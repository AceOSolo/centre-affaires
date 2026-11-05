import { eq } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { appUrl } from '../../lib/courriel.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { inspections, type InspectionKind } from '../etats-des-lieux/schema.ts'
import { resources } from '../ressources/schema.ts'
import { centreTimeZone, formatInstant, personName } from './faits.ts'
import { notify, type NotificationOutcome, type NotifyOptions } from './moteur.ts'

/**
 * Déclencheurs des états des lieux (ADR 039, ADR 038). Prêts pour la tranche
 * des états des lieux, qui les appelle après la clôture et après la
 * validation du client (`after()`). Le message ne contient ni le document ni
 * ses photos, ni le texte des remarques du client. Ne lèvent jamais.
 */

const kindPhrases: Record<InspectionKind, string> = {
  entry: 'd’entrée',
  exit: 'de sortie',
}

async function loadInspection(inspectionId: string, options: NotifyOptions) {
  const tenantId = options.tenantId ?? currentTenantId()
  return withTenant(
    tenantId,
    async (tx) => {
      const [row] = await tx
        .select({
          id: inspections.id,
          kind: inspections.kind,
          status: inspections.status,
          clientId: inspections.clientId,
          clientName: clients.name,
          resourceName: resources.name,
          performedAt: inspections.performedAt,
          signedAt: inspections.signedAt,
          signerName: clientMembers.fullName,
          signerEmail: clientMembers.email,
          hasRemarks: inspections.clientRemarks,
          deletedAt: inspections.deletedAt,
        })
        .from(inspections)
        .innerJoin(clients, eq(clients.id, inspections.clientId))
        .innerJoin(resources, eq(resources.id, inspections.resourceId))
        .leftJoin(clientMembers, eq(clientMembers.id, inspections.signedByMemberId))
        .where(eq(inspections.id, inspectionId))
      if (!row) return undefined
      return { ...row, timeZone: await centreTimeZone(tx, tenantId) }
    },
    options.database,
  )
}

type LoadedInspection = NonNullable<Awaited<ReturnType<typeof loadInspection>>>

function inspectionValues(loaded: LoadedInspection) {
  return {
    client: loaded.clientName,
    nature: kindPhrases[loaded.kind],
    ressource: loaded.resourceName,
    date: formatInstant(loaded.performedAt, loaded.timeZone),
  }
}

/**
 * État des lieux clos, à valider : aux personnes de l'espace du client. Rien
 * pour un brouillon, un état retiré ou déjà validé.
 */
export async function notifyInspectionToSign(
  inspectionId: string,
  options: NotifyOptions = {},
): Promise<NotificationOutcome | null> {
  try {
    const loaded = await loadInspection(inspectionId, options)
    if (!loaded || loaded.deletedAt || loaded.status !== 'closed' || loaded.signedAt) return null
    return await notify(
      {
        event: 'inspection_to_sign',
        clientId: loaded.clientId,
        related: { type: 'inspection', id: loaded.id },
        values: { ...inspectionValues(loaded), lien: appUrl('/compte/etats-des-lieux') },
      },
      options,
    )
  } catch (error) {
    console.error('Notification d’état des lieux à valider impossible', error)
    return null
  }
}

/** État des lieux validé par le client : à l'adresse du centre. */
export async function notifyInspectionSigned(
  inspectionId: string,
  options: NotifyOptions = {},
): Promise<NotificationOutcome | null> {
  try {
    const loaded = await loadInspection(inspectionId, options)
    if (!loaded || loaded.deletedAt || !loaded.signedAt) return null
    return await notify(
      {
        event: 'inspection_signed',
        clientId: loaded.clientId,
        related: { type: 'inspection', id: loaded.id },
        values: {
          ...inspectionValues(loaded),
          signataire: personName(loaded.signerName, loaded.signerEmail) ?? 'Le client',
          // Que des remarques existent, pas leur texte : il se lit à l'écran.
          remarques: loaded.hasRemarks?.trim() ? 'Le client a ajouté des remarques.' : null,
          lien: appUrl(`/etats-des-lieux/${loaded.id}`),
        },
      },
      options,
    )
  } catch (error) {
    console.error('Notification d’état des lieux validé impossible', error)
    return null
  }
}
