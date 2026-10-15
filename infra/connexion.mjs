/**
 * Connexion commune aux scripts d'exploitation (`seed-demo.mjs`,
 * `catalogue.mjs`, `configurer-centre.mjs`, `ajouter-membre-staff.mjs`).
 *
 * Même configuration que l'application : le pool se construit depuis `DB_*`
 * (`databaseOptionsFromEnv`), sous l'identité applicative `DB_USER`. Les
 * scripts écrivent donc exactement ce que l'application pourrait écrire, y
 * compris sous les gardes d'écriture par centre.
 *
 * Module TypeScript importé tel quel : Node 24 retire les types à la volée
 * (voir `infra/migrer.ts`). Charge `.env.local` puis `.env` s'ils existent ;
 * `--env-file` reste possible et prime.
 */
import { existsSync } from 'node:fs'

import { createDatabase, databaseOptionsFromEnv } from '../src/db/index.ts'
import { DEFAULT_TENANT_ID } from '../src/db/tenants.ts'
import { uuidv7 } from '../src/lib/uuid.ts'

for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) process.loadEnvFile(file)
}

export { DEFAULT_TENANT_ID, uuidv7 }

/** Ouvre le pool applicatif. `client` est un pool `mysql2/promise`, `db` son habillage Drizzle. */
export function ouvrirBase() {
  try {
    return createDatabase(databaseOptionsFromEnv())
  } catch (error) {
    console.error(`${error.message}\nRenseigner DB_* dans .env.local (voir .env.example).`)
    process.exit(1)
  }
}

/**
 * Transaction dans le contexte du centre, comme `withTenant()` : `@app_tenant_id`
 * est posée pour les triggers de la base (gardes d'écriture par centre) et
 * remise à `NULL` avant de rendre la connexion au pool.
 *
 * `run` reçoit une connexion `mysql2` : `const [rows] = await cnx.query(sql, params)`.
 */
export async function dansLeCentre(client, run, tenantId = DEFAULT_TENANT_ID) {
  const cnx = await client.getConnection()
  try {
    await cnx.beginTransaction()
    await cnx.query('set @app_tenant_id = ?, @app_client_ids = null', [tenantId])
    const result = await run(cnx)
    await cnx.commit()
    return result
  } catch (error) {
    await cnx.rollback().catch(() => {})
    throw error
  } finally {
    await cnx.query('set @app_tenant_id = null, @app_client_ids = null').catch(() => {})
    cnx.release()
  }
}

/**
 * La ligne du centre unique. Base vide : aucune migration ne la crée plus (les
 * migrations sont générées depuis le schéma), c'est le premier script lancé qui
 * la pose. Rejouable : une ligne existante n'est pas modifiée.
 */
export async function assurerCentre(cnx, { name = 'Handfield', slug = 'handfield' } = {}) {
  await cnx.query(
    'insert into tenants (id, name, slug) values (?, ?, ?) on duplicate key update id = id',
    [DEFAULT_TENANT_ID, name, slug],
  )
}
