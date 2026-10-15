import { and, asc, eq, isNull, sql } from 'drizzle-orm'

import { tenantContext } from '../../db/contexte.ts'
import type { Transaction } from '../../db/index.ts'
import { tenants } from '../../db/tenants.ts'
import { inspectionPhotos, inspections } from './schema.ts'

/**
 * Conservation des photos d'états des lieux (R33, ADR 039).
 *
 * Le délai court depuis la clôture de la sortie ; une entrée sans sortie close
 * ne se purge pas. Le code lit les photos échues (`expiredInspectionPhotos`,
 * réécriture TypeScript de l'ancienne fonction SQL), efface le fichier, puis la
 * base revérifie l'échéance avant de marquer
 * (`mark_inspection_photo_purged`) : le code ne décide de rien.
 *
 * Le stockage est passé en paramètre pour que la règle s'éprouve contre une
 * base sans stockage réel.
 */

/** Par passage : une purge interrompue reprend au suivant. */
const BATCH = 200

/**
 * Départ de la conservation d'un état des lieux : la clôture de la sortie.
 * Pour une sortie, la sienne ; pour une entrée, celle de la sortie close qui la
 * désigne. NULL — rien ne court — pour un brouillon, ou une entrée sans sortie
 * close : l'occupation dure, ou la sortie reste à faire.
 */
const retentionStart = sql`case
  when ${inspections.status} <> 'closed' then null
  when ${inspections.kind} = 'exit' then ${inspections.closedAt}
  else (
    select min(x.closed_at) from inspections as x
     where x.tenant_id = ${inspections.tenantId} and x.entry_inspection_id = ${inspections.id}
       and x.status = 'closed' and x.deleted_at is null
  )
end`

/** Photos échues du centre courant, de la plus ancienne à la plus récente. */
export async function expiredInspectionPhotos(
  tx: Transaction,
  limit: number = BATCH,
): Promise<{ id: string; storageKey: string }[]> {
  const tenantId = tenantContext.getStore()
  if (!tenantId) return []
  return tx
    .select({ id: inspectionPhotos.id, storageKey: inspectionPhotos.storageKey })
    .from(inspectionPhotos)
    .innerJoin(
      inspections,
      and(
        eq(inspections.tenantId, inspectionPhotos.tenantId),
        eq(inspections.id, inspectionPhotos.inspectionId),
      ),
    )
    .innerJoin(tenants, eq(tenants.id, inspectionPhotos.tenantId))
    .where(
      and(
        eq(inspectionPhotos.tenantId, tenantId),
        isNull(inspectionPhotos.deletedAt),
        sql`${retentionStart} < TIMESTAMPADD(MONTH, -${tenants.inspectionPhotoRetentionMonths}, CURRENT_TIMESTAMP(3))`,
      ),
    )
    .orderBy(asc(inspectionPhotos.createdAt), asc(inspectionPhotos.id))
    .limit(limit)
}

export async function purgeExpiredInspectionPhotos(
  tx: Transaction,
  removeObject: (key: string) => Promise<void>,
  limit: number = BATCH,
): Promise<number> {
  const expired = await expiredInspectionPhotos(tx, limit)
  let purged = 0
  for (const photo of expired) {
    // Le fichier d'abord : si l'effacement échoue, la ligne reste et le
    // passage suivant réessaie. Effacer deux fois un objet ne fait rien.
    await removeObject(photo.storageKey)
    const [rows] = (await tx.execute(
      sql`select mark_inspection_photo_purged(${photo.id}) as purged`,
    )) as unknown as [{ purged: number }[]]
    if (Number(rows[0]?.purged ?? 0) === 1) purged += 1
  }
  return purged
}

/** Journal des consultations des photos, au terme de sa durée. */
export async function purgeExpiredInspectionPhotoViews(tx: Transaction): Promise<number> {
  const [rows] = (await tx.execute(
    sql`select purge_expired_inspection_photo_views() as purged`,
  )) as unknown as [{ purged: number }[]]
  return Number(rows[0]?.purged ?? 0)
}
