import { and, eq, isNull } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { staffMembers, staffRoleLabels } from '../../db/staff.ts'
import type { InvitationLink } from '../../lib/auth/invitation.ts'
import { appUrl } from '../../lib/courriel.ts'
import { formatLongDate, formatTime, toIsoDate } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { proposals } from '../facturation/schema-devis.ts'
import { bookings } from '../reservations/schema.ts'
import { resources } from '../ressources/schema.ts'
import { centreTimeZone, formatSlot } from './faits.ts'
import { notify, type NotificationOutcome, type NotifyOptions } from './moteur.ts'

/**
 * Déclencheurs des comptes (ADR 068) : invitation dans l'équipe, accusé de
 * réception d'une demande du site. Tous deux écrivent à une personne seule,
 * qui n'a pas encore d'entreprise (audience `person`). Ne lèvent jamais ;
 * rendent `null` quand l'événement n'a pas lieu d'être.
 */

async function guarded(
  label: string,
  run: () => Promise<NotificationOutcome | null>,
): Promise<NotificationOutcome | null> {
  try {
    return await run()
  } catch (error) {
    console.error(`Notification impossible : ${label}`, error)
    return null
  }
}

/** Fin de validité d'un lien, à l'heure du centre : « mercredi 11 novembre 2026 à 10:00 ». */
function deadline(link: InvitationLink | undefined, timeZone: string): string | null {
  if (!link) return null
  return `${formatLongDate(toIsoDate(link.expiresAt, timeZone), timeZone)} à ${formatTime(link.expiresAt, timeZone)}`
}

/**
 * Invitation dans l'équipe, ou invitation renvoyée : au membre seulement,
 * tant qu'il n'est ni retiré ni déjà connecté.
 *
 * `prepareLink` prépare le lien pour choisir son mot de passe
 * (`lib/auth/equipe-invitation.ts`) une fois le membre retrouvé ; sans lien —
 * la personne a déjà un mot de passe, ou la préparation a échoué —, le
 * message l'invite à se connecter avec celui qu'elle a.
 */
export function notifyStaffInvited(
  staffMemberId: string,
  options: NotifyOptions & {
    prepareLink?: (member: { email: string; fullName: string | null }) => Promise<InvitationLink | undefined>
  } = {},
) {
  return guarded('invitation dans l’équipe', async () => {
    const tenantId = options.tenantId ?? currentTenantId()
    const row = await withTenant(
      tenantId,
      async (tx) => {
        const [found] = await tx
          .select({
            id: staffMembers.id,
            email: staffMembers.email,
            fullName: staffMembers.fullName,
            role: staffMembers.role,
            authUserId: staffMembers.authUserId,
          })
          .from(staffMembers)
          .where(
            and(eq(staffMembers.tenantId, tenantId), eq(staffMembers.id, staffMemberId), isNull(staffMembers.deletedAt)),
          )
        return found && { ...found, timeZone: await centreTimeZone(tx, tenantId) }
      },
      options.database,
    )
    // Retiré entre-temps, ou déjà entré : plus d'invitation à envoyer.
    if (!row || row.authUserId) return null
    const link = await options.prepareLink?.({ email: row.email, fullName: row.fullName })
    return notify(
      {
        event: 'staff_invited',
        related: { type: 'staff_member', id: row.id },
        recipients: { addresses: [{ email: row.email }] },
        values: {
          role: staffRoleLabels[row.role],
          adresse: row.email,
          lien: link?.url,
          echeance: deadline(link, row.timeZone),
          connexion: appUrl('/auth/equipe'),
        },
      },
      options,
    )
  })
}

/** Ce que le demandeur a déposé : une réservation (salle, bureau, camion, matériel) ou un devis seul (domiciliation). */
export type SiteRequestRef = { bookingId: string } | { proposalId: string }

/** Le demandeur d'une demande du site, tel qu'il s'est présenté. */
export type Requester = { email: string; name: string | null; company: string | null }

/**
 * Suite proposée au demandeur : créer son espace par un lien, ou se
 * connecter à celui qu'il a déjà (`modules/comptes/demandes-site.ts`).
 */
export type RequesterAccount = { kind: 'invite'; link: InvitationLink } | { kind: 'existing' }

/**
 * Accusé de réception d'une demande déposée sur la page publique par un
 * visiteur (ADR 068), à l'adresse qu'il a donnée. Seulement pour une demande
 * sans entreprise : une personne connectée à son espace y voit déjà la sienne.
 *
 * `prepareAccount` décide de la suite et prépare le lien au besoin ; sans
 * elle, ou si elle échoue, l'accusé part seul.
 */
export function notifyRequestReceived(
  request: SiteRequestRef,
  options: NotifyOptions & {
    prepareAccount?: (requester: Requester) => Promise<RequesterAccount | undefined>
  } = {},
) {
  return guarded('demande du site reçue', async () => {
    const tenantId = options.tenantId ?? currentTenantId()
    const loaded = await withTenant(
      tenantId,
      async (tx) => {
        const timeZone = await centreTimeZone(tx, tenantId)
        if ('bookingId' in request) {
          const [row] = await tx
            .select({
              id: bookings.id,
              kind: bookings.kind,
              status: bookings.status,
              clientId: bookings.clientId,
              startsAt: bookings.startsAt,
              endsAt: bookings.endsAt,
              email: bookings.requesterEmail,
              name: bookings.requesterName,
              anonymizedAt: bookings.requesterAnonymizedAt,
              resourceName: resources.name,
            })
            .from(bookings)
            .innerJoin(resources, eq(resources.id, bookings.resourceId))
            .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, request.bookingId)))
          if (!row || row.kind !== 'booking' || row.status === 'cancelled' || row.clientId) return undefined
          if (!row.email || row.anonymizedAt) return undefined
          const [proposal] = await tx
            .select({ number: proposals.number, company: proposals.requesterCompany })
            .from(proposals)
            .where(and(eq(proposals.tenantId, tenantId), eq(proposals.bookingId, row.id)))
            .limit(1)
          return {
            related: { type: 'booking' as const, id: row.id },
            requester: { email: row.email, name: row.name, company: proposal?.company ?? null },
            demande: `${row.resourceName}, ${formatSlot(row.startsAt, row.endsAt, timeZone)}`,
            numero: proposal?.number ?? null,
            timeZone,
          }
        }
        const [row] = await tx
          .select({
            id: proposals.id,
            product: proposals.product,
            status: proposals.status,
            clientId: proposals.clientId,
            number: proposals.number,
            email: proposals.requesterEmail,
            name: proposals.requesterName,
            company: proposals.requesterCompany,
          })
          .from(proposals)
          .where(and(eq(proposals.tenantId, tenantId), eq(proposals.id, request.proposalId)))
        if (!row || row.status === 'cancelled' || row.clientId || !row.email) return undefined
        return {
          related: { type: 'proposal' as const, id: row.id },
          requester: { email: row.email, name: row.name, company: row.company },
          demande: row.product === 'domiciliation' && row.company ? `domiciliation de ${row.company}` : 'domiciliation',
          numero: row.number,
          timeZone,
        }
      },
      options.database,
    )
    if (!loaded) return null

    const account = await options.prepareAccount?.(loaded.requester)
    const link = account?.kind === 'invite' ? account.link : undefined
    return notify(
      {
        event: 'request_received',
        related: loaded.related,
        recipients: { addresses: [{ email: loaded.requester.email }] },
        values: {
          demande: loaded.demande,
          numero: loaded.numero,
          adresse: loaded.requester.email.trim().toLowerCase(),
          lien: link?.url,
          echeance: deadline(link, loaded.timeZone),
          // Le lien de connexion ne sert qu'à qui a déjà un compte : sinon,
          // il mènerait à une page où l'on ne peut plus en créer.
          connexion: account?.kind === 'existing' ? appUrl('/auth/connexion') : null,
        },
      },
      options,
    )
  })
}
