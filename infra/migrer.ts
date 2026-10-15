/**
 * Prépare la base MySQL : crée la base et l'utilisateur applicatif s'ils
 * manquent, applique les migrations, rejoue les règles métier.
 *
 *   npm run db:migrer
 *
 * Lit `.env.local` puis `.env` (variables : voir `.env.example`). Se connecte
 * avec `DB_ADMIN_USER` — l'utilisateur qui a le droit de définir la structure —
 * puis donne à `DB_USER` les seuls droits de lecture et d'écriture (ADR 042).
 *
 * Sur un serveur qui journalise en binaire (MySQL 8 par défaut), créer des
 * triggers sans le droit SUPER demande `log_bin_trust_function_creators = 1`
 * (déjà posé par `infra/serveur/compose.yml`).
 */
import { existsSync } from 'node:fs'

import { createDatabase, databaseOptionsFromEnv } from '../src/db/index.ts'
import { migrate } from '../src/db/migrer.ts'

for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) process.loadEnvFile(file)
}

const admin = databaseOptionsFromEnv('DB_ADMIN')
const { database, ...server } = admin
const name = String(database)
if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`DB_NAME invalide : ${name}`)

const root = createDatabase({ ...server, database: undefined })
await root.client.query(
  `create database if not exists \`${name}\` character set utf8mb4 collate utf8mb4_0900_as_ci`,
)

const appUser = process.env.DB_USER
const appPassword = process.env.DB_PASSWORD
if (appUser && appUser !== admin.user) {
  if (!/^[A-Za-z0-9_]+$/.test(appUser)) throw new Error(`DB_USER invalide : ${appUser}`)
  // `%` : l'application tourne dans un conteneur, son adresse n'est pas connue.
  // Le serveur reste fermé au réseau (compose.yml), pas ouvert par ce compte.
  await root.client.query(`create user if not exists ?@'%' identified by ?`, [appUser, appPassword ?? ''])
  await root.client.query(`alter user ?@'%' identified by ?`, [appUser, appPassword ?? ''])
}
await root.client.end()

const { client } = createDatabase(admin)
const report = await migrate(client)
console.log(
  `Structure : ${report.structure.length} fichier(s) appliqué(s). ` +
    `Règles : ${report.regles.length} rejouée(s). Triggers updated_at : ${report.triggers} créé(s).`,
)

const [[fuseau]] = (await client.query(
  "select convert_tz('2026-07-01 12:00:00', '+00:00', 'Europe/Paris') as heure",
)) as unknown as [[{ heure: unknown }]]
if (fuseau.heure === null) {
  console.warn(
    'ATTENTION : les tables de fuseaux horaires de MySQL sont vides. La numérotation et ' +
      'l’émission des factures en dépendent. Les charger : ' +
      'mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql -u root mysql (déjà fait par l’image Docker officielle).',
  )
}

if (appUser && appUser !== admin.user) {
  // Droits de manipulation seulement : jamais CREATE, ALTER, DROP. Accordés
  // table par table, car MySQL ne sait pas retirer un droit d'une table sous un
  // droit accordé sur toute la base. Les compteurs de numérotation ne se
  // touchent que par `next_document_number()`, routine `SQL SECURITY DEFINER`
  // (ADR 021) : l'application les lit seulement. Une table ajoutée plus tard
  // reçoit ses droits au prochain `npm run db:migrer`.
  const [tables] = (await client.query(
    `select table_name as name from information_schema.tables
      where table_schema = database() and table_type = 'BASE TABLE' and table_name <> '__migrations'`,
  )) as unknown as [{ name: string }[]]
  for (const { name: table } of tables) {
    const privileges = table === 'document_sequences' ? 'select' : 'select, insert, update, delete'
    await client.query(`grant ${privileges} on \`${name}\`.\`${table}\` to ?@'%'`, [appUser])
  }
  await client.query(`grant execute on \`${name}\`.* to ?@'%'`, [appUser])
  console.log(`Droits accordés à ${appUser} sur ${name}.`)
}
await client.end()
