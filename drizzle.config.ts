import { existsSync } from 'node:fs'

import { defineConfig } from 'drizzle-kit'

// Next charge .env.local et .env automatiquement, pas drizzle-kit.
for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) process.loadEnvFile(file)
}

/**
 * drizzle-kit ne sert qu'à **générer** les migrations de structure :
 *
 *   npx drizzle-kit generate
 *
 * Les appliquer est le travail de `npm run db:migrer` (`infra/migrer.ts`), qui
 * rejoue aussi les règles métier (`src/db/regles/`) que Drizzle ne décrit pas.
 */
export default defineConfig({
  dialect: 'mysql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_ADMIN_USER ?? process.env.DB_USER ?? 'root',
    password: process.env.DB_ADMIN_PASSWORD ?? process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'centre_affaires',
  },
  strict: true,
  verbose: true,
})
