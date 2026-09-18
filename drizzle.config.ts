import { existsSync } from 'node:fs'

import { defineConfig } from 'drizzle-kit'

// Next charge .env.local automatiquement, pas drizzle-kit.
if (existsSync('.env.local')) process.loadEnvFile('.env.local')

// Les migrations posent du DDL (extensions, triggers, politiques RLS). Neon
// fournit une connexion directe a cote du pooler : le pooler travaille en mode
// transaction et convient mal au DDL. `neon env pull` renseigne les deux ;
// hors Neon, seule DATABASE_URL existe et sert aux deux usages.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL

if (!url) {
  throw new Error('DATABASE_URL manquant (voir .env.example)')
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: { url },
  strict: true,
  verbose: true,
})
