import { sql } from 'drizzle-orm'
import { char, index, pgEnum, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core'

import { deletedAt, primaryKeyId, timestamps } from '../../db/columns.ts'
import { tenantId } from '../../db/tenants.ts'

/**
 * Entreprises locataires ou domiciliées. Ce sont des personnes morales : les
 * comptes d'accès au portail viendront séparément, avec l'authentification.
 */
export const clientStatuses = ['prospect', 'active', 'inactive'] as const
export type ClientStatus = (typeof clientStatuses)[number]
export const clientStatusEnum = pgEnum('client_status', clientStatuses)

export const clients = pgTable(
  'clients',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    /** Raison sociale. */
    name: text('name').notNull(),
    /** SAS, SARL, association… saisie libre, les formes varient par pays. */
    legalForm: text('legal_form'),
    /** Facultatif : un client étranger n'en a pas. */
    siret: text('siret'),
    vatNumber: text('vat_number'),
    email: text('email'),
    phone: text('phone'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    postalCode: text('postal_code'),
    city: text('city'),
    /** ISO 3166-1 alpha-2. */
    country: char('country', { length: 2 }).notNull().default('FR'),
    status: clientStatusEnum('status').notNull().default('prospect'),
    notes: text('notes'),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (table) => [
    // Cible des clés étrangères composites : un contrat ne peut pas viser le
    // client d'un autre centre.
    unique('clients_tenant_id_id_key').on(table.tenantId, table.id),
    // Le SIRET identifie l'entreprise : deux fiches pour le même seraient deux
    // historiques de facturation à réconcilier.
    uniqueIndex('clients_tenant_siret_key')
      .on(table.tenantId, table.siret)
      .where(sql`deleted_at is null and siret is not null`),
    index('clients_tenant_name_idx').on(table.tenantId, table.name),
  ],
)

export type Client = typeof clients.$inferSelect
export type NewClient = typeof clients.$inferInsert
