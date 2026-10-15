import { sql } from 'drizzle-orm'
import { char, datetime } from 'drizzle-orm/mysql-core'

import { uuidv7 } from '../lib/uuid.ts'

/**
 * Colonnes réutilisées par toutes les tables métier.
 *
 * Les valeurs par défaut sont posées en base chaque fois que MySQL sait les
 * calculer : un seed, un import ou une requête SQL directe produisent les mêmes
 * lignes qu'une insertion via Drizzle.
 */

/**
 * Clé primaire UUID, en `char(36)`.
 *
 * L'application pose un UUID v7 (ordonné dans le temps, `$defaultFn`) ; un
 * insert en SQL direct reçoit `uuid()` de la base. Comme MySQL n'a pas de
 * `RETURNING`, connaître l'identifiant avant l'insertion est ce qui permet de
 * relire la ligne créée (`src/db/returning.ts`).
 */
export const primaryKeyId = () =>
  char('id', { length: 36 })
    .primaryKey()
    .default(sql`(uuid())`)
    .$defaultFn(() => uuidv7())

/**
 * `datetime(3)` : tout est stocké en UTC, le fuseau est appliqué à
 * l'affichage (décision 4). La connexion force `time_zone = '+00:00'`
 * (`src/db/index.ts`), donc `CURRENT_TIMESTAMP(3)` est bien en UTC.
 *
 * Pas de `timestamp` : sa plage s'arrête en 2038.
 */
export const instant = (name: string) => datetime(name, { mode: 'date', fsp: 3 })

export const timestamps = () => ({
  createdAt: instant('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  // Tenue à jour par un trigger `BEFORE UPDATE` posé par le migrateur sur
  // toute table qui porte cette colonne (`src/db/migrer.ts`), pas par le code.
  updatedAt: instant('updated_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
})

/** Suppression logique : une entité métier reste consultable après coup. */
export const deletedAt = () => instant('deleted_at')

/** Expression SQL « maintenant », à la milliseconde, en UTC. */
export const maintenant = () => sql`CURRENT_TIMESTAMP(3)`
