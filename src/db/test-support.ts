import type { Pool } from 'mysql2/promise'

import { createDatabase, databaseOptionsFromEnv, type Database } from './index.ts'
import { migrate } from './migrer.ts'

/**
 * Outillage des tests d'intégration (`*.db.test.ts`).
 *
 * Les tests s'exécutent contre un vrai MySQL : les règles de la base
 * (triggers, contraintes) ne se vérifient pas autrement. Ils sont ignorés
 * quand `TEST_DB_NAME` n'est pas défini.
 *
 *   TEST_DB_NAME=centre_affaires_test   base jetable, créée si besoin
 *   TEST_DB_HOST / TEST_DB_PORT         sinon DB_HOST / DB_PORT / 127.0.0.1:3306
 *   TEST_DB_ADMIN_USER / _PASSWORD      propriétaire : migrations, TRUNCATE
 *   TEST_DB_USER / _PASSWORD            utilisateur applicatif (DML seulement)
 *
 * Deux identités, comme en production : `owner` prépare et vide la base,
 * `app` est celle sous laquelle le code métier s'exécute.
 */
export const raisonDeSaut: string | false = process.env.TEST_DB_NAME
  ? false
  : 'TEST_DB_NAME non défini'

function testEnv(prefix: 'DB' | 'DB_ADMIN'): Record<string, string | undefined> {
  const e = process.env
  return {
    DB_HOST: e.TEST_DB_HOST ?? e.DB_HOST ?? '127.0.0.1',
    DB_PORT: e.TEST_DB_PORT ?? e.DB_PORT ?? '3306',
    DB_NAME: e.TEST_DB_NAME,
    DB_USER: e.TEST_DB_USER ?? e.DB_USER,
    DB_PASSWORD: e.TEST_DB_PASSWORD ?? e.DB_PASSWORD,
    DB_ADMIN_USER: e.TEST_DB_ADMIN_USER ?? e.DB_ADMIN_USER ?? 'root',
    DB_ADMIN_PASSWORD: e.TEST_DB_ADMIN_PASSWORD ?? e.DB_ADMIN_PASSWORD ?? '',
    DB_SSL: 'false',
    ...(prefix === 'DB_ADMIN' ? {} : {}),
  }
}

export type TestDatabases = {
  owner: { client: Pool; db: Database }
  app: { client: Pool; db: Database }
  fermer(): Promise<void>
}

/**
 * Crée la base de test si elle manque, applique les migrations, ouvre les
 * deux identités. À appeler dans `before()`.
 */
export async function ouvrirBasesDeTest(): Promise<TestDatabases> {
  const adminOptions = databaseOptionsFromEnv('DB_ADMIN', testEnv('DB_ADMIN'))
  const { database, ...serverOptions } = adminOptions
  const server = createDatabase({ ...serverOptions, database: undefined })
  const name = String(database)
  await server.client.query(
    `create database if not exists \`${name}\` character set utf8mb4 collate utf8mb4_0900_as_ci`,
  )
  await server.client.end()

  const owner = createDatabase(adminOptions)
  await migrate(owner.client)
  await repartirDeZero(owner.client)

  // Sans `TEST_DB_USER`, l'identité applicative est le propriétaire : les
  // vérifications de droits (écrire un compteur…) sont alors ignorées par les
  // tests qui les portent.
  const hasApp = Boolean(process.env.TEST_DB_USER ?? process.env.DB_USER)
  const app = hasApp ? createDatabase(databaseOptionsFromEnv('DB', testEnv('DB'))) : owner
  return {
    owner,
    app,
    async fermer() {
      await owner.client.end()
      if (app !== owner) await app.client.end()
    },
  }
}

/**
 * Vide des tables en suspendant les clés étrangères le temps de l'opération
 * (MySQL refuse `TRUNCATE` sur une table référencée, même vide). Le
 * propriétaire seul peut l'appeler.
 */
export async function viderTables(owner: { client: Pool }, ...tables: string[]): Promise<void> {
  const connection = await owner.client.getConnection()
  try {
    await connection.query('set foreign_key_checks = 0')
    for (const table of tables) await connection.query(`truncate table \`${table}\``)
    await connection.query('set foreign_key_checks = 1')
  } finally {
    connection.release()
  }
}

/**
 * Remet la base à son état de sortie de migration : toutes les tables vidées,
 * sauf le centre unique et le journal des migrations.
 *
 * Les fichiers de test partagent une base et chacun ne vide que ses tables :
 * sans ce vidage de départ, les lignes d'un fichier précédent (un créneau
 * occupé, un code pris) faisaient échouer les suivants. PostgreSQL le faisait
 * par `truncate … cascade` ; MySQL n'a pas de `cascade`.
 */
async function repartirDeZero(pool: Pool): Promise<void> {
  const connection = await pool.getConnection()
  try {
    const [rows] = (await connection.query(
      `select table_name as name from information_schema.tables
        where table_schema = database() and table_type = 'BASE TABLE'
          and table_name not in ('__migrations', 'tenants')`,
    )) as unknown as [{ name: string }[]]
    await connection.query('set foreign_key_checks = 0')
    for (const { name } of rows) await connection.query(`truncate table \`${name}\``)
    await connection.query('delete from tenants where id <> ?', [
      '01999f00-0000-7000-8000-000000000001',
    ])
    await connection.query('set foreign_key_checks = 1')
  } finally {
    connection.release()
  }
}
