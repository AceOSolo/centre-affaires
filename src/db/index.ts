import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { createPool, type PoolOptions } from 'mysql2/promise'

import { isUuid } from '../lib/uuid.ts'
import { tenantContext } from './contexte.ts'
import * as schema from './schema.ts'

export type Database = ReturnType<typeof createDatabase>['db']
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * Configuration de la base, lue dans l'environnement (`.env`) :
 *
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSL
 *
 * `prefix` permet de lire un autre jeu (`DB_ADMIN` pour les migrations, par
 * exemple : `DB_ADMIN_USER`, `DB_ADMIN_PASSWORD`, qui héritent de l'hôte, du
 * port et du nom de base de `DB_*` quand ils ne sont pas redéfinis).
 */
export function databaseOptionsFromEnv(
  prefix: 'DB' | 'DB_ADMIN' = 'DB',
  env: Record<string, string | undefined> = process.env,
): PoolOptions {
  const pick = (name: string) => env[`${prefix}_${name}`] ?? env[`DB_${name}`]
  const database = env.DB_NAME
  const user = prefix === 'DB' ? env.DB_USER : (env.DB_ADMIN_USER ?? env.DB_USER)
  const password = prefix === 'DB' ? env.DB_PASSWORD : (env.DB_ADMIN_PASSWORD ?? env.DB_PASSWORD)
  if (!database || !user) {
    throw new Error(
      `${prefix === 'DB' ? 'DB_NAME et DB_USER' : 'DB_NAME et DB_ADMIN_USER (ou DB_USER)'} manquants (voir .env.example)`,
    )
  }
  const ssl = (pick('SSL') ?? '').toLowerCase() === 'true'
  return {
    host: pick('HOST') ?? '127.0.0.1',
    port: Number(pick('PORT') ?? 3306),
    database,
    user,
    password: password ?? '',
    ...(ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  }
}

/**
 * Ouvre un pool sur une base. Exporté pour que les tests éprouvent le code
 * réellement utilisé en production plutôt qu'une copie qui finirait par diverger.
 *
 * Chaque connexion est mise en UTC (décision 4) et en `READ COMMITTED`, le
 * niveau d'isolation par défaut de PostgreSQL pour lequel les transactions du
 * code ont été écrites : MySQL prend `REPEATABLE READ`, dont la lecture figée
 * changerait le comportement des verrous.
 */
export function createDatabase(config: string | PoolOptions, options: PoolOptions = {}) {
  const base: PoolOptions = {
    // Les dates sont lues et écrites en UTC, jamais dans le fuseau du processus.
    timezone: 'Z',
    // L'identifiant de la collation 0900_as_ci (305) dépasse l'octet de la
    // poignée de main : elle est posée à la connexion (`SET NAMES`, plus bas).
    charset: 'utf8mb4',
    // `decimal` rendu en nombre : les montants sont des entiers en centimes.
    decimalNumbers: true,
    connectionLimit: 10,
    waitForConnections: true,
    // Pas de requêtes multiples : une injection ne peut pas en chaîner une autre.
    multipleStatements: false,
  }
  const pool = createPool(
    typeof config === 'string'
      ? { uri: config, ...base, ...options }
      : { ...base, ...config, ...options },
  )
  pool.pool.on('connection', (connection) => {
    // Collation de connexion = celle des colonnes : sans elle, MySQL compare
    // une colonne à `@app_*` en `utf8mb4_general_ci` (erreur 1267).
    connection.query('SET NAMES utf8mb4 COLLATE utf8mb4_0900_as_ci')
    // Messages d'erreur en anglais : le code lit des noms de contraintes dedans.
    connection.query("SET lc_messages = 'en_US'")
    connection.query("SET time_zone = '+00:00'")
    connection.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED')
  })
  return { client: pool, db: drizzle(pool, { schema, mode: 'default' }) }
}

/**
 * L'application se connecte avec `DB_USER`, un utilisateur sans droit de
 * définition (pas de `CREATE`, `ALTER`, `DROP`) : les migrations passent par
 * `DB_ADMIN_USER`. Voir ADR 042.
 */
// Next recharge les modules à chaud en développement ; sans ce cache, chaque
// édition ouvrirait un nouveau pool. L'ouverture est paresseuse : importer ce
// module au build ne doit pas exiger une base joignable.
const globalForDb = globalThis as unknown as {
  database?: ReturnType<typeof createDatabase>
}

// Volontairement non exporté : le code métier passe par `withTenant()`, seul
// endroit où le centre est posé. Exposer la base rendrait l'oubli possible.
function getDb(): Database {
  globalForDb.database ??= createDatabase(databaseOptionsFromEnv())
  return globalForDb.database.db
}

/**
 * Ouvre une transaction dans le contexte d'un centre. Unique porte d'entrée du
 * code métier vers la base.
 *
 * MySQL n'a pas de Row Level Security (ADR 042). Le contexte sert à deux
 * choses :
 *
 * - `tenantContext` donne la valeur par défaut de `tenant_id` aux insertions
 *   de l'application ;
 * - `@app_tenant_id` est lue par les triggers et procédures de la base
 *   (`src/db/regles/`), qui refusent d'écrire pour un autre centre.
 *
 * Les lectures, elles, ne sont pas filtrées par la base : toute requête sur
 * une table métier porte son propre filtre sur `tenant_id` dès qu'un second
 * centre existera. Tant que le produit est mono-centre, un seul centre est en
 * base et l'oubli est sans effet — mais il faut l'écrire dès maintenant.
 */
export async function withTenant<T>(
  tenantId: string,
  run: (tx: Transaction) => Promise<T>,
  database: Database = getDb(),
): Promise<T> {
  if (!isUuid(tenantId)) throw new Error('Centre invalide : identifiant mal formé.')
  return tenantContext.run(tenantId, () =>
    database.transaction(async (tx) => {
      await tx.execute(sql`set @app_tenant_id = ${tenantId}, @app_client_ids = null`)
      try {
        return await run(tx)
      } finally {
        // La connexion retourne au pool : le contexte ne doit pas la suivre.
        await tx.execute(sql`set @app_tenant_id = null, @app_client_ids = null`).catch(() => {})
      }
    }),
  )
}

/**
 * Transaction dans le contexte d'un centre **et** d'une portée client : celle
 * de l'espace client, pour les entreprises du compte connecté (ADR 019).
 *
 * `@app_client_ids` (liste séparée par des virgules) est lue par les triggers
 * de la base : sous portée client, ils refusent d'écrire hors des entreprises
 * de la liste (`FIND_IN_SET`). Une liste vide est une portée vide, pas une
 * absence de portée : défaut fermé.
 *
 * Contrairement à PostgreSQL, **la base ne filtre pas les lectures**. Toute
 * requête exécutée sous `withClientScope()` doit donc filtrer elle-même sur
 * les `clientIds` reçus — c'est ce que `scopeClientIds()` permet de relire
 * depuis la transaction, et ce que les tests de portée contrôlent.
 *
 * Les créneaux occupés par d'autres se lisent par une fonction qui n'en
 * révèle que les heures (module réservations).
 */
export async function withClientScope<T>(
  tenantId: string,
  clientIds: readonly string[],
  run: (tx: Transaction) => Promise<T>,
  database: Database = getDb(),
): Promise<T> {
  // La liste devient une chaîne séparée par des virgules : un identifiant mal
  // formé pourrait en changer le sens. Refusé avant d'atteindre la base.
  if (clientIds.some((id) => !isUuid(id))) {
    throw new Error('Portée client invalide : identifiant de client mal formé.')
  }
  if (!isUuid(tenantId)) throw new Error('Centre invalide : identifiant mal formé.')
  const scope = clientIds.join(',')
  return tenantContext.run(tenantId, () =>
    database.transaction(async (tx) => {
      await tx.execute(sql`set @app_tenant_id = ${tenantId}, @app_client_ids = ${scope}`)
      try {
        return await run(tx)
      } finally {
        await tx.execute(sql`set @app_tenant_id = null, @app_client_ids = null`).catch(() => {})
      }
    }),
  )
}

/**
 * Entreprises de la portée client de la transaction, ou `null` hors portée
 * (back-office). Relit `@app_client_ids` posée par `withClientScope()`.
 */
export async function scopeClientIds(tx: Transaction): Promise<string[] | null> {
  const [rows] = (await tx.execute(sql`select @app_client_ids as ids`)) as unknown as [
    { ids: string | null }[],
  ]
  const ids = rows[0]?.ids
  if (ids === null || ids === undefined) return null
  return ids === '' ? [] : ids.split(',')
}

export * from './schema.ts'
