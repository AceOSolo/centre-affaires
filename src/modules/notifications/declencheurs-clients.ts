import { and, eq, isNull } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import type { InvitationLink } from '../../lib/auth/invitation.ts'
import { appUrl } from '../../lib/courriel.ts'
import { formatCalendarDate, formatLongDate, formatTime, toIsoDate } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { contracts, offerRequests } from '../contrats/schema.ts'
import { offers } from '../facturation/schema.ts'
import { resources } from '../ressources/schema.ts'
import { signalStaff } from './cloche-queries.ts'
import { centreTimeZone, personName } from './faits.ts'
import { notify, type NotificationOutcome, type NotifyOptions } from './moteur.ts'

/**
 * Déclencheurs de la relation client (ADR 015, ADR 025, ADR 036, ADR 038) :
 * contrat activé, accès ouvert à l'espace client, offre demandée. Ne lèvent
 * jamais ; rendent `null` quand l'événement n'a pas eu lieu.
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

/** Contrat activé : aux personnes de l'espace du client. */
export function notifyContractActivated(contractId: string, options: NotifyOptions = {}) {
  return guarded('contrat activé', async () => {
    const [row] = await withTenant(
      options.tenantId ?? currentTenantId(),
      (tx) =>
        tx
          .select({
            id: contracts.id,
            status: contracts.status,
            reference: contracts.reference,
            startsOn: contracts.startsOn,
            clientId: contracts.clientId,
            clientName: clients.name,
            resourceName: resources.name,
            deletedAt: contracts.deletedAt,
          })
          .from(contracts)
          .innerJoin(clients, eq(clients.id, contracts.clientId))
          .leftJoin(resources, eq(resources.id, contracts.resourceId))
          .where(eq(contracts.id, contractId)),
      options.database,
    )
    if (!row || row.deletedAt || row.status !== 'active') return null
    return notify(
      {
        event: 'contract_activated',
        clientId: row.clientId,
        related: { type: 'contract', id: row.id },
        values: {
          client: row.clientName,
          reference: row.reference,
          debut: formatCalendarDate(row.startsOn),
          ressource: row.resourceName,
          lien: appUrl('/compte'),
        },
      },
      options,
    )
  })
}

/**
 * Accès ouvert à l'espace client, ou invitation renvoyée : à la personne
 * inscrite seulement, quelle que soit sa préférence (le message n'a pas de
 * catégorie). Retrouvée par son adresse sur la fiche, retirés exclus.
 *
 * `prepareLink` prépare le lien pour choisir son mot de passe (ADR 059,
 * `clients/invitation.ts`), une fois l'accès retrouvé ; sans lui, ou s'il
 * échoue, le message part sans lien et renvoie à la page de connexion.
 */
export function notifyMemberInvited(
  clientId: string,
  email: string,
  options: NotifyOptions & {
    prepareLink?: (member: { email: string; fullName: string | null }) => Promise<InvitationLink | undefined>
  } = {},
) {
  return guarded('accès à l’espace client ouvert', async () => {
    const tenantId = options.tenantId ?? currentTenantId()
    const address = email.trim().toLowerCase()
    const row = await withTenant(
      tenantId,
      async (tx) => {
        const [found] = await tx
          .select({
            memberId: clientMembers.id,
            email: clientMembers.email,
            fullName: clientMembers.fullName,
            clientName: clients.name,
          })
          .from(clientMembers)
          .innerJoin(clients, and(eq(clients.tenantId, clientMembers.tenantId), eq(clients.id, clientMembers.clientId)))
          .where(
            and(
              eq(clientMembers.tenantId, tenantId),
              eq(clientMembers.clientId, clientId),
              eq(clientMembers.email, address),
              isNull(clientMembers.deletedAt),
            ),
          )
        return found && { ...found, timeZone: await centreTimeZone(tx, tenantId) }
      },
      options.database,
    )
    if (!row) return null
    const link = await options.prepareLink?.({ email: row.email, fullName: row.fullName })
    return notify(
      {
        event: 'member_invited',
        clientId,
        related: { type: 'client_member', id: row.memberId },
        recipients: { memberIds: [row.memberId] },
        values: {
          client: row.clientName,
          adresse: row.email,
          lien: link?.url,
          echeance: link
            ? `${formatLongDate(toIsoDate(link.expiresAt, row.timeZone), row.timeZone)} à ${formatTime(link.expiresAt, row.timeZone)}`
            : null,
          connexion: appUrl('/auth/connexion'),
        },
      },
      options,
    )
  })
}

/**
 * Offre demandée depuis l'espace client (ADR 036) : à l'adresse du centre, et
 * dans la cloche de l'équipe (ADR 059).
 * L'appelant (l'action de l'espace) a vérifié que l'offre est montrée aux
 * clients et que la personne relève de l'entreprise ; le message ne dit rien
 * de plus que ce qu'elle a demandé.
 */
export function notifyOfferRequested(
  request: { offerId: string; clientId: string; memberId: string; message?: string | null },
  options: NotifyOptions = {},
) {
  return guarded('offre demandée', async () => {
    const loaded = await withTenant(
      options.tenantId ?? currentTenantId(),
      async (tx) => {
        const [offer] = await tx
          .select({ name: offers.name, clientVisible: offers.clientVisible, deletedAt: offers.deletedAt })
          .from(offers)
          .where(eq(offers.id, request.offerId))
        const [member] = await tx
          .select({ fullName: clientMembers.fullName, email: clientMembers.email, clientName: clients.name })
          .from(clientMembers)
          .innerJoin(clients, eq(clients.id, clientMembers.clientId))
          .where(and(eq(clientMembers.id, request.memberId), eq(clientMembers.clientId, request.clientId)))
        // La demande à traiter, que la cloche désigne : une seule par
        // entreprise et par offre (`offer_requests_open_key`).
        const [open] = await tx
          .select({ id: offerRequests.id })
          .from(offerRequests)
          .where(
            and(
              eq(offerRequests.clientId, request.clientId),
              eq(offerRequests.offerId, request.offerId),
              eq(offerRequests.status, 'requested'),
            ),
          )
          .limit(1)
        return { offer, member, open }
      },
      options.database,
    )
    const { offer, member, open } = loaded
    if (!offer || offer.deletedAt || !offer.clientVisible || !member) return null
    if (open) {
      await signalStaff(
        { kind: 'offer_request', clientId: request.clientId, relatedId: open.id, summary: [offer.name] },
        options,
      )
    }
    return notify(
      {
        event: 'offer_requested',
        clientId: request.clientId,
        related: { type: 'offer', id: request.offerId },
        values: {
          client: member.clientName,
          offre: offer.name,
          demandeur: personName(member.fullName, member.email) ?? 'Le client',
          message: request.message?.trim() || null,
          lien: appUrl(`/clients/${request.clientId}`),
        },
      },
      options,
    )
  })
}
