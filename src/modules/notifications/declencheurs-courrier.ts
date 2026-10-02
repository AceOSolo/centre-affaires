import { and, desc, eq, inArray } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { appUrl } from '../../lib/courriel.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { mailKindLabels } from '../courrier/labels.ts'
import { mailItems, mailRequests, type MailRequestKind } from '../courrier/schema.ts'
import { centreTimeZone, formatInstant, mailRequestKindPhrases, personName } from './faits.ts'
import { notify, type NotificationOutcome, type NotifyOptions } from './moteur.ts'

/**
 * Déclencheurs du courrier (ADR 015, ADR 037, ADR 038). Chacun relit l'état
 * en base, vérifie que l'événement a bien eu lieu, et confie le message au
 * moteur. Rendent `null` quand il n'y a rien à dire (pli retiré, demande dans
 * un autre état) ; ne lèvent jamais.
 *
 * Ils préviennent, ils ne transportent pas : ni le document, ni l'expéditeur,
 * ni la consigne du client n'entrent dans les valeurs.
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

/** Le pli, son client et le fuseau du centre. */
async function loadMail(mailItemId: string, options: NotifyOptions) {
  const tenantId = options.tenantId ?? currentTenantId()
  return withTenant(
    tenantId,
    async (tx) => {
      const [row] = await tx
        .select({
          id: mailItems.id,
          clientId: mailItems.clientId,
          clientName: clients.name,
          kind: mailItems.kind,
          status: mailItems.status,
          receivedAt: mailItems.receivedAt,
          deletedAt: mailItems.deletedAt,
        })
        .from(mailItems)
        .innerJoin(clients, eq(clients.id, mailItems.clientId))
        .where(eq(mailItems.id, mailItemId))
      if (!row) return undefined
      return { mail: row, timeZone: await centreTimeZone(tx, tenantId) }
    },
    options.database,
  )
}

/**
 * Arrivée d'un pli, aux personnes de l'entreprise. Un pli enregistré déjà
 * ouvert part comme « courrier numérisé » : il est lisible dès l'arrivée.
 */
export function notifyMailReceived(mailItemId: string, options: NotifyOptions = {}) {
  return guarded('arrivée de courrier', async () => {
    const loaded = await loadMail(mailItemId, options)
    if (!loaded || loaded.mail.deletedAt) return null
    const { mail, timeZone } = loaded
    return notify(
      {
        event: mail.status === 'opened' ? 'mail_scanned' : 'mail_received',
        clientId: mail.clientId,
        related: { type: 'mail_item', id: mail.id },
        values: {
          client: mail.clientName,
          nature: mailKindLabels[mail.kind].toLowerCase(),
          date: formatInstant(mail.receivedAt, timeZone),
          lien: appUrl('/compte/courrier'),
        },
      },
      options,
    )
  })
}

/** Pli ouvert et numérisé par l'accueil. */
export function notifyMailScanned(mailItemId: string, options: NotifyOptions = {}) {
  return guarded('numérisation de courrier', async () => {
    const loaded = await loadMail(mailItemId, options)
    if (!loaded || loaded.mail.deletedAt || loaded.mail.status !== 'opened') return null
    const { mail, timeZone } = loaded
    return notify(
      {
        event: 'mail_scanned',
        clientId: mail.clientId,
        related: { type: 'mail_item', id: mail.id },
        values: {
          client: mail.clientName,
          nature: mailKindLabels[mail.kind].toLowerCase(),
          date: formatInstant(mail.receivedAt, timeZone),
          lien: appUrl('/compte/courrier'),
        },
      },
      options,
    )
  })
}

/** La demande, son pli, son client, son auteur et le fuseau du centre. */
async function loadRequest(mailRequestId: string, options: NotifyOptions) {
  const tenantId = options.tenantId ?? currentTenantId()
  return withTenant(
    tenantId,
    async (tx) => {
      const [row] = await tx
        .select({
          request: {
            id: mailRequests.id,
            kind: mailRequests.kind,
            status: mailRequests.status,
            clientId: mailRequests.clientId,
            mailItemId: mailRequests.mailItemId,
            requestedByStaffId: mailRequests.requestedByStaffId,
            forwardTrackingNumber: mailRequests.forwardTrackingNumber,
            refusalReason: mailRequests.refusalReason,
          },
          clientName: clients.name,
          mailKind: mailItems.kind,
          receivedAt: mailItems.receivedAt,
          requesterName: clientMembers.fullName,
          requesterEmail: clientMembers.email,
        })
        .from(mailRequests)
        .innerJoin(mailItems, eq(mailItems.id, mailRequests.mailItemId))
        .innerJoin(clients, eq(clients.id, mailRequests.clientId))
        .leftJoin(clientMembers, eq(clientMembers.id, mailRequests.requestedByMemberId))
        .where(eq(mailRequests.id, mailRequestId))
      if (!row) return undefined
      return { ...row, timeZone: await centreTimeZone(tx, tenantId) }
    },
    options.database,
  )
}

type LoadedRequest = NonNullable<Awaited<ReturnType<typeof loadRequest>>>

function requestValues(loaded: LoadedRequest) {
  return {
    client: loaded.clientName,
    demande: mailRequestKindPhrases[loaded.request.kind],
    nature: mailKindLabels[loaded.mailKind].toLowerCase(),
    date: formatInstant(loaded.receivedAt, loaded.timeZone),
  }
}

/**
 * Demande de courrier déposée : à l'adresse du centre. Une demande consignée
 * par l'accueil lui-même ne le prévient pas.
 */
export function notifyMailRequestSubmitted(mailRequestId: string, options: NotifyOptions = {}) {
  return guarded('demande de courrier déposée', async () => {
    const loaded = await loadRequest(mailRequestId, options)
    if (!loaded || loaded.request.requestedByStaffId) return null
    if (loaded.request.status !== 'requested' && loaded.request.status !== 'in_progress') return null
    return notify(
      {
        event: 'mail_request_submitted',
        clientId: loaded.request.clientId,
        related: { type: 'mail_request', id: loaded.request.id },
        values: {
          ...requestValues(loaded),
          demandeur: personName(loaded.requesterName, loaded.requesterEmail) ?? 'Le client',
          lien: appUrl(`/courrier/${loaded.request.mailItemId}`),
        },
      },
      options,
    )
  })
}

/**
 * Demande de courrier traitée : aux personnes de l'entreprise. L'ouverture
 * d'un pli prévient déjà par « courrier numérisé » (`notifyMailScanned`) :
 * une demande d'ouverture faite ne donne pas un second message.
 */
export function notifyMailRequestDone(mailRequestId: string, options: NotifyOptions = {}) {
  return guarded('demande de courrier traitée', async () => {
    const loaded = await loadRequest(mailRequestId, options)
    if (!loaded || loaded.request.status !== 'done' || loaded.request.kind === 'open_and_scan') return null
    return notify(
      {
        event: 'mail_request_done',
        clientId: loaded.request.clientId,
        related: { type: 'mail_request', id: loaded.request.id },
        values: {
          ...requestValues(loaded),
          suivi: loaded.request.kind === 'forward' ? loaded.request.forwardTrackingNumber : null,
          lien: appUrl('/compte/courrier'),
        },
      },
      options,
    )
  })
}

/** Demande de courrier refusée, par l'accueil ou par le retrait du pli. */
export function notifyMailRequestRefused(mailRequestId: string, options: NotifyOptions = {}) {
  return guarded('demande de courrier refusée', async () => {
    const loaded = await loadRequest(mailRequestId, options)
    if (!loaded || loaded.request.status !== 'refused') return null
    return notify(
      {
        event: 'mail_request_refused',
        clientId: loaded.request.clientId,
        related: { type: 'mail_request', id: loaded.request.id },
        values: {
          ...requestValues(loaded),
          motif: loaded.request.refusalReason,
          lien: appUrl('/compte/courrier'),
        },
      },
      options,
    )
  })
}

/**
 * Demande en cours d'une nature sur un pli : la plus récente. Pour les
 * chemins qui ne connaissent que le pli (`requestOpening`).
 */
export async function findPendingMailRequestId(
  mailItemId: string,
  kind: MailRequestKind,
  options: NotifyOptions = {},
): Promise<string | undefined> {
  const [row] = await withTenant(
    options.tenantId ?? currentTenantId(),
    (tx) =>
      tx
        .select({ id: mailRequests.id })
        .from(mailRequests)
        .where(
          and(
            eq(mailRequests.mailItemId, mailItemId),
            eq(mailRequests.kind, kind),
            inArray(mailRequests.status, ['requested', 'in_progress']),
          ),
        )
        .orderBy(desc(mailRequests.requestedAt))
        .limit(1),
    options.database,
  )
  return row?.id
}
