import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema'

function connectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL manquant (voir .env.example)')
  return url
}

function createClient() {
  return postgres(connectionString(), {
    // Le pooler de Neon travaille en mode transaction : les requêtes préparées
    // ne survivent pas d'une transaction à l'autre.
    prepare: false,
  })
}

// Next recharge les modules à chaud en développement ; sans ce cache, chaque
// édition ouvrirait un nouveau pool.
const globalForDb = globalThis as unknown as { client?: ReturnType<typeof createClient> }
const client = globalForDb.client ?? createClient()
if (process.env.NODE_ENV !== 'production') globalForDb.client = client

export const db = drizzle(client, { schema })

export type Database = typeof db
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * Ouvre une transaction dans le contexte d'un centre.
 *
 * Les politiques RLS (migration 0003) filtrent sur `app.tenant_id`, qui n'existe
 * que dans la transaction qui le pose. Une requête émise hors de `withTenant`
 * ne voit aucune ligne : c'est voulu, l'oubli est visible immédiatement plutôt
 * que silencieux.
 */
export async function withTenant<T>(
  tenantId: string,
  run: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`)
    return run(tx)
  })
}

export * from './schema'
