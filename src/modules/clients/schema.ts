import { sql } from 'drizzle-orm'
import {
  char,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { deletedAt, primaryKeyId, timestamps } from '../../db/columns.ts'
import { tenantId } from '../../db/tenants.ts'

/**
 * Entreprises locataires ou domiciliées. Ce sont des personnes morales : les
 * personnes qui accèdent au portail en leur nom sont dans `client_members`.
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

/**
 * Personnes qui accèdent à l'espace client d'une entreprise (ADR 015).
 *
 * Même modèle que `staff_members` (ADR 008) : Neon Auth dit qui est connecté,
 * cette table dit à quelle entreprise cette personne a accès. Le centre inscrit
 * une adresse depuis la fiche client, le compte est rattaché à la première
 * connexion. Avoir un compte ne donne accès à rien.
 *
 * Une même adresse peut figurer sur plusieurs fiches : le gérant d'une holding
 * et de sa SCI domiciliées au centre relève les deux boîtes aux lettres avec un
 * seul compte.
 *
 * Dans le module `clients` et non dans `src/db/` comme `staff_members` : l'accès
 * est donné à une entreprise cliente, il n'a pas de sens sans elle.
 */
export const clientMembers = pgTable(
  'client_members',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    clientId: uuid('client_id').notNull(),
    /**
     * Identifiant du compte Neon Auth, nul jusqu'à la première connexion. Pas de
     * clé étrangère vers `neon_auth`, pour la même raison que `staff_members`.
     */
    authUserId: text('auth_user_id'),
    /** Toujours en minuscules : c'est la clé de rattachement au compte. */
    email: text('email').notNull(),
    fullName: text('full_name'),
    ...timestamps(),
    /** Retrait de l'accès : il cesse, l'historique des demandes reste (décision 6). */
    deletedAt: deletedAt(),
  },
  (table) => [
    foreignKey({
      name: 'client_members_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    // Cible des clés étrangères composites du courrier : une demande
    // d'ouverture ne peut pas être attribuée à la personne d'un autre centre.
    unique('client_members_tenant_id_id_key').on(table.tenantId, table.id),
    // Une adresse ne vaut qu'une fois par entreprise, et redevient libre après
    // un retrait.
    uniqueIndex('client_members_client_email_key')
      .on(table.tenantId, table.clientId, table.email)
      .where(sql`deleted_at is null`),
    // Un compte n'est rattaché qu'une fois à une même entreprise.
    uniqueIndex('client_members_client_auth_user_key')
      .on(table.clientId, table.authUserId)
      .where(sql`auth_user_id is not null and deleted_at is null`),
    index('client_members_tenant_email_idx').on(table.tenantId, table.email),
    index('client_members_auth_user_idx').on(table.authUserId),
  ],
)

export type ClientMember = typeof clientMembers.$inferSelect
export type NewClientMember = typeof clientMembers.$inferInsert
