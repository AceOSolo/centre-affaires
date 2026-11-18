import { and, asc, eq, isNull, sql } from 'drizzle-orm'

import { tenantContext } from '../../db/contexte.ts'
import type { Transaction } from '../../db/index.ts'
import { clientDocuments } from './schema-pieces.ts'

/**
 * Conservation des pièces justificatives (RGPD, ADR 020, ADR 075).
 *
 * L'échéance est tenue par la base (`client_document_expired()`,
 * `34-pieces.sql`) : entreprise anonymisée, pièce refusée depuis plus de
 * `refused_client_document_retention_months`, ou relation finie depuis plus de
 * `client_document_retention_months`. Le code lit les pièces échues, efface le
 * fichier, puis la base revérifie l'échéance avant de marquer la ligne
 * (`mark_client_document_purged()`) : le code ne décide de rien.
 *
 * Le stockage est passé en paramètre pour que la règle s'éprouve contre une
 * base sans stockage réel.
 */

/** Par passage : une purge interrompue reprend au suivant. */
const BATCH = 200

/** Pièces échues du centre courant, des plus anciennes aux plus récentes. */
export async function expiredClientDocuments(
  tx: Transaction,
  limit: number = BATCH,
): Promise<{ id: string; storageKey: string }[]> {
  const tenantId = tenantContext.getStore()
  if (!tenantId) return []
  return tx
    .select({ id: clientDocuments.id, storageKey: clientDocuments.storageKey })
    .from(clientDocuments)
    .where(
      and(
        eq(clientDocuments.tenantId, tenantId),
        isNull(clientDocuments.deletedAt),
        sql`client_document_expired(${clientDocuments.id}) = 1`,
      ),
    )
    .orderBy(asc(clientDocuments.createdAt), asc(clientDocuments.id))
    .limit(limit)
}

export async function purgeExpiredClientDocuments(
  tx: Transaction,
  removeObject: (key: string) => Promise<void>,
  limit: number = BATCH,
): Promise<number> {
  const expired = await expiredClientDocuments(tx, limit)
  let purged = 0
  for (const document of expired) {
    // Le fichier d'abord : si l'effacement échoue, la ligne reste et le
    // passage suivant réessaie. Effacer deux fois un objet ne fait rien.
    await removeObject(document.storageKey)
    const [rows] = (await tx.execute(
      sql`select mark_client_document_purged(${document.id}) as purged`,
    )) as unknown as [{ purged: number }[]]
    if (Number(rows[0]?.purged ?? 0) === 1) purged += 1
  }
  return purged
}

/** Journal des consultations des pièces, au terme de sa durée. */
export async function purgeExpiredClientDocumentViews(tx: Transaction): Promise<number> {
  const [rows] = (await tx.execute(
    sql`select purge_expired_client_document_views() as purged`,
  )) as unknown as [{ purged: number }[]]
  return Number(rows[0]?.purged ?? 0)
}
