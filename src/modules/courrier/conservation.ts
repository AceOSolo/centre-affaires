import { and, eq, isNull, sql } from 'drizzle-orm'

import type { Transaction } from '../../db/index.ts'
import { tenants } from '../../db/tenants.ts'
import { mailScans } from './schema.ts'

/**
 * Purge du courrier au terme de sa durée de conservation (RGPD, ADR 015).
 *
 * Les durées sont celles du centre (`tenants`), comptées en mois calendaires
 * par Postgres. Deux purges :
 *
 * - les numérisations : le fichier est effacé du stockage, la ligne reste
 *   marquée `deleted_at` — le pli, sa date et son ouverture restent au relevé
 *   de facturation, seul le document disparaît ;
 * - le journal d'accès, par la fonction `purge_expired_mail_scan_views()`
 *   (migration 0024), seule porte d'effacement que le rôle applicatif ait.
 *
 * Le stockage est passé en paramètre pour que la règle s'éprouve contre une
 * base sans stockage réel.
 */

/** Par passage : une purge interrompue reprend au suivant. */
const BATCH = 200

export async function purgeExpiredMail(
  tx: Transaction,
  removeObject: (key: string) => Promise<void>,
): Promise<{ scans: number; views: number }> {
  const scans = await purgeExpiredMailScans(tx, removeObject)
  const views = await purgeExpiredMailScanViews(tx)
  return { scans, views }
}

/**
 * Numérisations échues : fichier effacé du stockage, puis ligne marquée. Rend
 * le nombre de numérisations purgées.
 */
export async function purgeExpiredMailScans(
  tx: Transaction,
  removeObject: (key: string) => Promise<void>,
): Promise<number> {
  const expired = await tx
    .select({ id: mailScans.id, storageKey: mailScans.storageKey })
    .from(mailScans)
    .innerJoin(tenants, eq(tenants.id, mailScans.tenantId))
    .where(
      and(
        isNull(mailScans.deletedAt),
        sql`${mailScans.createdAt} < now() - make_interval(months => ${tenants.mailScanRetentionMonths})`,
      ),
    )
    .limit(BATCH)

  for (const scan of expired) {
    // Le fichier d'abord : si l'effacement échoue, la ligne reste active et
    // le passage suivant réessaie. Effacer deux fois un objet ne fait rien.
    await removeObject(scan.storageKey)
    await tx.update(mailScans).set({ deletedAt: sql`now()` }).where(eq(mailScans.id, scan.id))
  }
  return expired.length
}

/**
 * Journal d'accès aux numérisations, au terme de sa durée : il ne dépend pas
 * du stockage, la tâche de nuit le purge avant lui.
 */
export async function purgeExpiredMailScanViews(tx: Transaction): Promise<number> {
  const [row] = await tx.execute<{ purged: number }>(
    sql`select purge_expired_mail_scan_views() as purged`,
  )
  return Number(row?.purged ?? 0)
}
