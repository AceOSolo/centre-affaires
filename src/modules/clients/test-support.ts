import type { SQL } from 'drizzle-orm'
import type { Pool, PoolConnection } from 'mysql2/promise'

import type { Transaction } from '../../db/index.ts'
import { viderTables } from '../../db/test-support.ts'

/**
 * Outillage commun aux tests d'intégration des modules `clients` et `rgpd`
 * (pas un test : le lanceur ne le prend pas).
 */

/**
 * Vide toutes les tables métier, sauf `tenants` et celles de l'authentification.
 *
 * PostgreSQL le faisait par `truncate … cascade`, qui suivait les clés
 * étrangères. MySQL refuse de vider une table référencée et n'a pas de
 * `cascade` : on vide tout, clés étrangères suspendues (`viderTables`).
 */
export async function toutVider(owner: { client: Pool }): Promise<void> {
  const [tables] = (await owner.client.query(
    `select table_name as name from information_schema.tables
      where table_schema = database() and table_type = 'BASE TABLE'
        and table_name not in ('tenants', '__migrations') and table_name not like 'auth\\_%'`,
  )) as unknown as [{ name: string }[]]
  await viderTables(owner, ...tables.map((table) => table.name))
}

/** Les lignes d'une requête : `execute` rend `[lignes, champs]` sous mysql2. */
export async function lire(
  tx: Pick<Transaction, 'execute'>,
  requete: SQL,
): Promise<Record<string, unknown>[]> {
  return ((await tx.execute(requete)) as unknown as [Record<string, unknown>[]])[0]
}

/** Un tableau JSON lu d'une colonne ou d'une fonction (déjà décodé, ou en chaîne). */
export function jsonEnTableau<T = string>(valeur: unknown): T[] {
  if (valeur === null || valeur === undefined) return []
  return (typeof valeur === 'string' ? JSON.parse(valeur) : valeur) as T[]
}

/**
 * Exécute `action` sur une connexion du propriétaire, les triggers des tables
 * citées étant retirés le temps de l'action, puis recréés tels quels.
 *
 * PostgreSQL le faisait par `set local session_replication_role = replica`.
 * MySQL n'a pas d'équivalent : on lit la définition de chaque trigger
 * (`SHOW CREATE TRIGGER`), on le supprime, on le recrée en `finally`. Réservé
 * aux tests qui doivent réécrire l'histoire d'une pièce figée (reculer la date
 * d'une facture émise) ; à n'utiliser qu'avec `--test-concurrency=1`.
 */
export async function sansTriggers<T>(
  owner: { client: Pool },
  tables: string[],
  action: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await owner.client.getConnection()
  const definitions: string[] = []
  try {
    const [triggers] = (await connection.query(
      `select trigger_name as name from information_schema.triggers
        where trigger_schema = database() and event_object_table in (?)`,
      [tables],
    )) as unknown as [{ name: string }[]]
    for (const { name } of triggers) {
      const [rows] = (await connection.query(`show create trigger \`${name}\``)) as unknown as [
        Record<string, string>[],
      ]
      definitions.push(rows[0]['SQL Original Statement'])
      await connection.query(`drop trigger \`${name}\``)
    }
    return await action(connection)
  } finally {
    for (const definition of definitions) await connection.query(definition)
    connection.release()
  }
}
