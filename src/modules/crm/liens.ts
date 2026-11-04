import { and, desc, eq } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { crmConnectors } from './catalogue.ts'
import { crmLinks, type CrmLinkEntity } from './schema-liens.ts'

/**
 * D'où vient une fiche (ADR 066) : le CRM qui la tient, son identifiant et sa
 * référence là-bas, le dernier envoi reçu. Pour les fiches client et contrat
 * du back-office, qui disent alors qu'une modification faite ici sera
 * remplacée au prochain envoi du CRM.
 */
export type CrmOrigin = {
  crmLabel: string
  externalId: string
  externalRef: string | null
  receivedAt: Date
  /** Supprimé dans le CRM : la fiche reste, elle n'est plus tenue par lui. */
  removedAt: Date | null
}

export async function crmOriginOf(entity: CrmLinkEntity, localId: string): Promise<CrmOrigin | undefined> {
  const tenantId = currentTenantId()
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select({
        connector: crmLinks.connector,
        externalId: crmLinks.externalId,
        externalRef: crmLinks.externalRef,
        receivedAt: crmLinks.receivedAt,
        removedAt: crmLinks.removedAt,
      })
      .from(crmLinks)
      .where(and(eq(crmLinks.tenantId, tenantId), eq(crmLinks.entity, entity), eq(crmLinks.localId, localId)))
      // Le lien vivant d'abord (`removed_at` nul), puis le plus récent.
      .orderBy(crmLinks.removedAt, desc(crmLinks.receivedAt))
      .limit(1),
  )
  if (!row) return undefined
  return {
    crmLabel: crmConnectors[row.connector].label,
    externalId: row.externalId,
    externalRef: row.externalRef,
    receivedAt: row.receivedAt,
    removedAt: row.removedAt,
  }
}
