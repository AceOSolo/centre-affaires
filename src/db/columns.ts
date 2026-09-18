import { sql } from 'drizzle-orm'
import { timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Colonnes réutilisées par toutes les tables métier.
 *
 * Les valeurs par défaut sont posées en base et non dans le code : un seed, un
 * import ou une requête SQL directe doivent produire les mêmes lignes qu'une
 * insertion via Drizzle.
 */

/** Clé primaire UUID v7 — `uuid_generate_v7()` est créée par la migration 0000. */
export const primaryKeyId = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuid_generate_v7()`)

/** `timestamptz` : tout est stocké en UTC, le fuseau est appliqué à l'affichage. */
export const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Tenue à jour par le trigger `set_updated_at` (migration 0000), pas par le code.
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Suppression logique : une entité métier reste consultable après coup. */
export const deletedAt = () => timestamp('deleted_at', { withTimezone: true })
