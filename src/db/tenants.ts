import { sql } from 'drizzle-orm'
import { char, pgTable, text, uuid } from 'drizzle-orm/pg-core'

import { deletedAt, primaryKeyId, timestamps } from './columns.ts'

/**
 * Centre unique tant que le produit est mono-centre. Cet identifiant est aussi
 * écrit en dur dans la migration 0002 (création de la ligne) et dans la
 * fonction `tenant_id_default()` : les trois doivent rester synchronisés.
 */
export const DEFAULT_TENANT_ID = '01999f00-0000-7000-8000-000000000001'

export const tenants = pgTable('tenants', {
  id: primaryKeyId(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  /** Fuseau d'affichage du centre (IANA), la base reste en UTC. */
  timezone: text('timezone').notNull().default('Europe/Paris'),
  /** ISO 4217, accompagne les montants stockés en centimes. */
  currency: char('currency', { length: 3 }).notNull().default('EUR'),
  ...timestamps(),
  deletedAt: deletedAt(),
})

/**
 * Colonne `tenant_id` de toutes les tables métier.
 *
 * Valeur par défaut : le tenant du contexte de session, ou le centre unique.
 * L'isolation réelle est assurée par les politiques RLS (migration 0003), qui
 * exigent un `app.tenant_id` explicite et ne renvoient rien sans lui.
 */
export const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(sql`tenant_id_default()`)
    .references(() => tenants.id, { onDelete: 'restrict' })

export type Tenant = typeof tenants.$inferSelect
export type NewTenant = typeof tenants.$inferInsert
