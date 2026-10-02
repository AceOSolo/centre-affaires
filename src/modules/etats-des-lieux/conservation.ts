import { sql } from 'drizzle-orm'

import type { Transaction } from '../../db/index.ts'

/**
 * Conservation des photos d'états des lieux (R33, ADR 039).
 *
 * Le délai court depuis la clôture de la sortie ; une entrée sans sortie close
 * ne se purge pas. La base choisit ce qui est échu (`expired_inspection_photos`)
 * et revérifie avant de marquer (`mark_inspection_photo_purged`) : le code
 * efface le fichier entre les deux, et ne décide de rien.
 *
 * Le stockage est passé en paramètre pour que la règle s'éprouve contre une
 * base sans stockage réel.
 */

/** Par passage : une purge interrompue reprend au suivant. */
const BATCH = 200

export async function purgeExpiredInspectionPhotos(
  tx: Transaction,
  removeObject: (key: string) => Promise<void>,
  limit: number = BATCH,
): Promise<number> {
  const expired = await tx.execute<{ id: string; storage_key: string }>(
    sql`select id, storage_key from expired_inspection_photos(${limit})`,
  )
  let purged = 0
  for (const photo of expired) {
    // Le fichier d'abord : si l'effacement échoue, la ligne reste et le
    // passage suivant réessaie. Effacer deux fois un objet ne fait rien.
    await removeObject(photo.storage_key)
    const [row] = await tx.execute<{ purged: boolean }>(
      sql`select mark_inspection_photo_purged(${photo.id}) as purged`,
    )
    if (row?.purged) purged += 1
  }
  return purged
}

/** Journal des consultations des photos, au terme de sa durée. */
export async function purgeExpiredInspectionPhotoViews(tx: Transaction): Promise<number> {
  const [row] = await tx.execute<{ purged: number }>(
    sql`select purge_expired_inspection_photo_views() as purged`,
  )
  return Number(row?.purged ?? 0)
}
