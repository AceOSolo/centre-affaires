import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres, { type Options } from 'postgres'

import * as schema from './schema.ts'

export type Database = ReturnType<typeof createDatabase>['db']
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * Ouvre un pool sur une base. Exporté pour que les tests éprouvent le code
 * réellement utilisé en production plutôt qu'une copie qui finirait par diverger.
 */
export function createDatabase(url: string, options: Options<Record<string, never>> = {}) {
  const client = postgres(url, {
    // Le pooler de Neon travaille en mode transaction : les requêtes préparées
    // ne survivent pas d'une transaction à l'autre.
    prepare: false,
    ...options,
  })
  return { client, db: drizzle(client, { schema }) }
}

/**
 * L'application se connecte avec `app_centre`, jamais avec le propriétaire :
 * lui seul est soumis aux politiques d'isolation par centre. Voir ADR 003 et la
 * migration 0004.
 */
function connectionString(): string {
  const url = process.env.APP_DATABASE_URL
  if (url) return url

  throw new Error(
    process.env.DATABASE_URL
      ? 'APP_DATABASE_URL manquant : lancer `node infra/provision-role-applicatif.mjs`. ' +
        "DATABASE_URL est le rôle propriétaire, il contourne la RLS et ne doit pas servir à l'application."
      : 'APP_DATABASE_URL manquant (voir .env.example)',
  )
}

// Next recharge les modules à chaud en développement ; sans ce cache, chaque
// édition ouvrirait un nouveau pool. L'ouverture est paresseuse : importer ce
// module au build ne doit pas exiger une base joignable.
const globalForDb = globalThis as unknown as {
  database?: ReturnType<typeof createDatabase>
}

// Volontairement non exporté : le code métier passe par `withTenant()`, seul
// endroit où le centre est posé. Exposer la base rendrait l'oubli possible.
function getDb(): Database {
  globalForDb.database ??= createDatabase(connectionString())
  return globalForDb.database.db
}

/**
 * Ouvre une transaction dans le contexte d'un centre. Unique porte d'entrée du
 * code métier vers la base.
 *
 * `app.tenant_id` est posé pour la durée de la transaction — donc compatible
 * avec un pooler en mode transaction — et les politiques de la migration 0003
 * filtrent dessus. Sans lui, `current_tenant_id()` vaut NULL et aucune ligne ne
 * remonte : l'oubli du contexte se voit tout de suite au lieu d'ouvrir
 * silencieusement les données d'un autre centre.
 */
export async function withTenant<T>(
  tenantId: string,
  run: (tx: Transaction) => Promise<T>,
  database: Database = getDb(),
): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`)
    return run(tx)
  })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Transaction dans le contexte d'un centre **et** d'une portée client : celle
 * de l'espace client, pour les entreprises du compte connecté (ADR 019).
 *
 * En plus de `app.tenant_id`, pose `app.client_ids`. Les politiques
 * restrictives de la migration 0026 ne laissent alors voir ni écrire, dans les
 * tables qui relèvent d'un client (`clients`, `client_members`,
 * `client_contacts`, `contracts`, `bookings`, `mail_items`, `mail_scans`,
 * `mail_scan_views`), que les lignes de ces entreprises — même pour une
 * requête qui oublierait son filtre `where`. Les tables sans client
 * (`resources`, `tenants`…) restent lisibles comme sous `withTenant()`.
 *
 * Une liste vide ne voit rien : défaut fermé. Les créneaux occupés par
 * d'autres se lisent par `booking_busy_ranges()`, qui n'en révèle que les
 * heures.
 *
 * Le back-office n'utilise pas cette fonction : sans portée, rien ne change.
 */
export async function withClientScope<T>(
  tenantId: string,
  clientIds: readonly string[],
  run: (tx: Transaction) => Promise<T>,
  database: Database = getDb(),
): Promise<T> {
  // La liste devient un littéral de tableau Postgres : un identifiant mal formé
  // pourrait en changer le sens. Refusé avant d'atteindre la base.
  if (clientIds.some((id) => !UUID.test(id))) {
    throw new Error('Portée client invalide : identifiant de client mal formé.')
  }
  const scope = `{${clientIds.join(',')}}`
  return database.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.client_ids', ${scope}, true)`,
    )
    return run(tx)
  })
}

export * from './schema.ts'
