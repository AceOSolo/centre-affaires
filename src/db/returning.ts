import { eq, inArray, type SQL } from 'drizzle-orm'
import type { MySqlColumn, MySqlTable } from 'drizzle-orm/mysql-core'

import { uuidv7 } from '../lib/uuid.ts'
import type { Transaction } from './index.ts'

/**
 * MySQL n'a pas de `RETURNING`. Ces helpers rendent les lignes écrites en
 * deux temps dans la même transaction : l'identifiant est connu avant
 * l'insertion (posé par l'application), la ligne est relue après.
 *
 * Ils ne servent que pour les tables dont la clé primaire est une colonne
 * `id`. Les autres (clé composite) relisent à la main.
 */
type WithId = MySqlTable & { id: MySqlColumn }

/** Insère une ligne et la rend telle que la base l'a enregistrée (défauts compris). */
export async function insertReturning<T extends WithId>(
  tx: Transaction,
  table: T,
  values: T['$inferInsert'],
): Promise<T['$inferSelect']> {
  const id = (values as { id?: string }).id ?? uuidv7()
  await tx.insert(table).values({ ...values, id } as never)
  const [row] = await tx.select().from(table).where(eq(table.id, id)).limit(1)
  return row as T['$inferSelect']
}

/** Insère plusieurs lignes ; les lignes rendues suivent l'ordre des valeurs reçues. */
export async function insertManyReturning<T extends WithId>(
  tx: Transaction,
  table: T,
  values: T['$inferInsert'][],
): Promise<T['$inferSelect'][]> {
  if (values.length === 0) return []
  const withIds = values.map((value) => ({
    ...value,
    id: (value as { id?: string }).id ?? uuidv7(),
  }))
  await tx.insert(table).values(withIds as never)
  const ids = withIds.map((value) => value.id)
  const rows = (await tx.select().from(table).where(inArray(table.id, ids))) as (T['$inferSelect'] & {
    id: string
  })[]
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ids.map((id) => byId.get(id)!)
}

/**
 * Met à jour les lignes qui répondent à `where` et les rend après mise à jour.
 *
 * Les lignes sont d'abord verrouillées (`FOR UPDATE`) : l'ensemble relu est
 * exactement celui qui a été modifié, même sous concurrence. Un `where`
 * absent met toute la table à jour — ne pas l'omettre.
 */
export async function updateReturning<T extends WithId>(
  tx: Transaction,
  table: T,
  set: Partial<T['$inferInsert']> | Record<string, unknown>,
  where: SQL | undefined,
): Promise<T['$inferSelect'][]> {
  const ids = (
    (await tx.select({ id: table.id }).from(table).where(where).for('update')) as { id: string }[]
  ).map((row) => row.id)
  if (ids.length === 0) return []
  await tx
    .update(table)
    .set(set as never)
    .where(inArray(table.id, ids))
  return (await tx.select().from(table).where(inArray(table.id, ids))) as T['$inferSelect'][]
}

/** Supprime les lignes qui répondent à `where` et les rend telles qu'elles étaient. */
export async function deleteReturning<T extends WithId>(
  tx: Transaction,
  table: T,
  where: SQL | undefined,
): Promise<T['$inferSelect'][]> {
  const rows = (await tx.select().from(table).where(where).for('update')) as (T['$inferSelect'] & {
    id: string
  })[]
  if (rows.length === 0) return []
  await tx.delete(table).where(
    inArray(
      table.id,
      rows.map((row) => row.id),
    ),
  )
  return rows
}
