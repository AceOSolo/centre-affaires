/**
 * Pose le mot de passe du rôle applicatif `app_centre` et publie APP_DATABASE_URL.
 *
 * À exécuter une fois par environnement — chaque branche Neon a ses propres
 * rôles — après `npx drizzle-kit migrate` :
 *
 *   node infra/provision-role-applicatif.mjs
 *
 * Pourquoi un rôle séparé : `neondb_owner` sur Neon, comme `postgres` en local,
 * porte l'attribut BYPASSRLS (ou est superutilisateur), qui l'emporte sur
 * FORCE ROW LEVEL SECURITY. Connectée avec lui, l'application ignore les
 * politiques d'isolation par centre et `withTenant()` ne filtre rien.
 * Voir la migration 0004 et l'ADR 003.
 *
 * Le mot de passe est tiré au hasard et n'est jamais écrit ailleurs que dans
 * .env.local, ignoré par git. Pour le fournir soi-même — un secret de CI, par
 * exemple — passer APP_DB_PASSWORD dans l'environnement.
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const ENV_FILE = '.env.local'
const ROLE = 'app_centre'

// En local, tout vient de .env.local. En CI il n'y a pas de fichier : les
// variables sont déjà dans l'environnement, et le résultat repart par
// $GITHUB_ENV plutôt que sur disque.
const fichierPresent = existsSync(ENV_FILE)
if (fichierPresent) process.loadEnvFile(ENV_FILE)

const ownerUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL
if (!ownerUrl) {
  throw new Error('DATABASE_URL manquant (.env.local ou environnement)')
}

// L'application passe par le pooler quand il existe ; seule l'identité change.
const appUrl = new URL(process.env.DATABASE_URL ?? ownerUrl)
const password = process.env.APP_DB_PASSWORD ?? randomBytes(24).toString('base64url')

const postgres = createRequire(import.meta.url)('postgres')
const sql = postgres(ownerUrl, { prepare: false })

try {
  const [role] = await sql`select rolbypassrls from pg_roles where rolname = ${ROLE}`
  if (!role) {
    throw new Error(`Rôle ${ROLE} absent — appliquer la migration 0004 d'abord`)
  }
  if (role.rolbypassrls) {
    throw new Error(`Rôle ${ROLE} en BYPASSRLS : il contournerait les politiques`)
  }

  // ALTER ROLE n'accepte pas de paramètre lié pour le mot de passe ; `format`
  // avec %L fait l'échappement côté serveur.
  const [{ statement }] = await sql`
    select format('alter role %I password %L', ${ROLE}::text, ${password}::text) as statement`
  await sql.unsafe(statement)

  appUrl.username = ROLE
  appUrl.password = password
  const ligne = `APP_DATABASE_URL="${appUrl.toString()}"`

  if (fichierPresent) {
    const contenu = readFileSync(ENV_FILE, 'utf8')
    const dejaPresent = /^APP_DATABASE_URL=.*$/m.test(contenu)
    writeFileSync(
      ENV_FILE,
      dejaPresent
        ? contenu.replace(/^APP_DATABASE_URL=.*$/m, ligne)
        : `${contenu.replace(/\n*$/, '')}\n${ligne}\n`,
      'utf8',
    )
    console.log(`APP_DATABASE_URL ${dejaPresent ? 'mis à jour' : 'ajouté'} dans ${ENV_FILE}.`)
  } else if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `${ligne}\n`)
    console.log('APP_DATABASE_URL publié dans $GITHUB_ENV.')
  } else {
    console.log(ligne)
  }

  console.log(`Mot de passe posé sur ${ROLE}.`)
  console.log(`Branche : ${process.env.NEON_BRANCH ?? 'hors Neon'}`)
} finally {
  await sql.end()
}
