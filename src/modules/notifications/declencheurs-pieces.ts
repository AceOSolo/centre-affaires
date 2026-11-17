import { withTenant } from '../../db/index.ts'
import { appUrl } from '../../lib/courriel.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { findDocumentForMessage } from '../clients/pieces-queries.ts'
import { personName } from './faits.ts'
import { notify, type NotificationOutcome, type NotifyOptions } from './moteur.ts'

/**
 * Déclencheurs des pièces justificatives de la domiciliation (ADR 075) : une
 * pièce arrive (à l'accueil), une pièce est refusée (au client, avec le
 * motif). Ne lèvent jamais ; rendent `null` quand l'événement n'a pas lieu
 * d'être. Ils préviennent sans transporter : jamais le document (ADR 015).
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

/** Pièce déposée depuis l'espace client : l'accueil la vérifie. */
export function notifyClientDocumentReceived(documentId: string, options: NotifyOptions = {}) {
  return guarded('pièce justificative déposée', async () => {
    const tenantId = options.tenantId ?? currentTenantId()
    const document = await withTenant(tenantId, (tx) => findDocumentForMessage(tx, documentId), options.database)
    if (!document || document.status !== 'received') return null
    return notify(
      {
        event: 'client_document_received',
        clientId: document.clientId,
        related: { type: 'client_document', id: document.id },
        values: {
          client: document.clientName,
          piece: document.kindLabel,
          demandeur: personName(document.memberName, document.memberEmail) ?? document.clientName,
          lien: appUrl(`/clients/${document.clientId}#pieces`),
        },
      },
      options,
    )
  })
}

/** Pièce refusée par l'équipe : les personnes de l'espace du client, avec le motif. */
export function notifyClientDocumentRefused(documentId: string, options: NotifyOptions = {}) {
  return guarded('pièce justificative refusée', async () => {
    const tenantId = options.tenantId ?? currentTenantId()
    const document = await withTenant(tenantId, (tx) => findDocumentForMessage(tx, documentId), options.database)
    if (!document || document.status !== 'refused') return null
    return notify(
      {
        event: 'client_document_refused',
        clientId: document.clientId,
        related: { type: 'client_document', id: document.id },
        values: {
          client: document.clientName,
          piece: document.kindLabel,
          motif: document.refusalReason,
          lien: appUrl('/compte/pieces'),
        },
      },
      options,
    )
  })
}
