import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
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
    /**
     * Compte auxiliaire du client dans l'export comptable (ADR 027), sous le
     * compte collectif 411 : « DURAND ». Nul : l'export le dérive ou le
     * demande.
     */
    accountingCode: text('accounting_code'),
    /**
     * Dernier échange noté par l'équipe avec l'entreprise (appel, rendez-vous,
     * visite), jour civil du centre. Une des dates dont
     * `client_last_activity_on()` tire la fin de la relation (R29, ADR 040) :
     * un prospect qu'on rappelle ne s'anonymise pas.
     */
    lastContactOn: date('last_contact_on', { mode: 'string' }),
    ...timestamps(),
    deletedAt: deletedAt(),
    /**
     * Anonymisation (R29, ADR 040) : raison sociale remplacée, coordonnées,
     * SIRET et notes effacés, contacts et accès anonymisés avec elle. Posée par
     * `anonymize_client()` ou `anonymize_expired_clients()`, jamais par le
     * code ; une fiche anonymisée ne change plus (SQLSTATE `CA012`). Les
     * factures émises gardent leur instantané de l'acheteur (obligation de
     * conservation de 10 ans).
     */
    anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
  },
  (table) => [
    // Cible des clés étrangères composites : un contrat ne peut pas viser le
    // client d'un autre centre.
    unique('clients_tenant_id_id_key').on(table.tenantId, table.id),
    // Une fiche anonymisée est archivée : elle sort des listes.
    check(
      'clients_anonymized_archived',
      sql`${table.anonymizedAt} is null or ${table.deletedAt} is not null`,
    ),
    // Deux clients vivants ne partagent pas un compte auxiliaire : leurs
    // écritures se mêleraient chez l'expert-comptable.
    uniqueIndex('clients_tenant_accounting_code_key')
      .on(table.tenantId, table.accountingCode)
      .where(sql`deleted_at is null and accounting_code is not null`),
    check(
      'clients_accounting_code_format',
      sql`${table.accountingCode} is null or ${table.accountingCode} ~ '^[0-9A-Z]{1,17}$'`,
    ),
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
    /**
     * Anonymisation de la trace d'un accès retiré, ou de l'entreprise (R29,
     * ADR 040) : adresse remplacée par une adresse inexistante, nom effacé,
     * compte détaché. La ligne reste : elle signe des demandes, des
     * consultations, des validations d'états des lieux.
     */
    anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
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
    // Cible des clés étrangères qui exigent que la personne relève de
    // l'entreprise de la ligne : une demande de courrier, une réservation du
    // portail, une préférence, la validation d'un état des lieux (vague 3).
    unique('client_members_tenant_client_id_key').on(table.tenantId, table.clientId, table.id),
    check(
      'client_members_anonymized_removed',
      sql`${table.anonymizedAt} is null or (${table.deletedAt} is not null and ${table.authUserId} is null)`,
    ),
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

/**
 * Contacts d'une entreprise cliente (R07, CRM) : les personnes à qui l'on parle
 * — gérant, comptable, assistante — avec leur fonction et leurs coordonnées.
 *
 * Distincts de `client_members` : un contact n'a pas forcément de compte, et un
 * compte n'est pas forcément un contact. Le comptable qui reçoit les factures
 * n'a aucune raison d'ouvrir l'espace client ; l'assistante qui relève le
 * courrier n'est pas celle qu'on appelle pour renégocier le bail.
 *
 * Données personnelles de tiers : elles suivent la fiche client, et partent
 * avec elle au terme de sa conservation (registre RGPD, ADR 020).
 */
export const clientContacts = pgTable(
  'client_contacts',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    clientId: uuid('client_id').notNull(),
    fullName: text('full_name').notNull(),
    /** Fonction dans l'entreprise : « gérante », « expert-comptable ». */
    jobTitle: text('job_title'),
    email: text('email'),
    phone: text('phone'),
    /** Interlocuteur principal de l'entreprise : un seul à la fois. */
    isPrimary: boolean('is_primary').notNull().default(false),
    /** Destinataire des factures. Plusieurs possibles (gérant et comptable). */
    isBilling: boolean('is_billing').notNull().default(false),
    notes: text('notes'),
    ...timestamps(),
    deletedAt: deletedAt(),
    /** Anonymisation avec la fiche de l'entreprise (R29, ADR 040). */
    anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'client_contacts_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    // Cible des futures clés étrangères composites (destinataire d'une facture).
    unique('client_contacts_tenant_id_id_key').on(table.tenantId, table.id),
    // Au plus un contact principal actif par entreprise : deux rendraient
    // « qui appeler » dépendant de l'ordre de lecture. Archivé, il libère la
    // place.
    uniqueIndex('client_contacts_primary_key')
      .on(table.tenantId, table.clientId)
      .where(sql`is_primary and deleted_at is null`),
    index('client_contacts_client_idx').on(table.tenantId, table.clientId),
    check('client_contacts_name_not_blank', sql`btrim(${table.fullName}) <> ''`),
    check(
      'client_contacts_anonymized_archived',
      sql`${table.anonymizedAt} is null or ${table.deletedAt} is not null`,
    ),
  ],
)

export type ClientContact = typeof clientContacts.$inferSelect
export type NewClientContact = typeof clientContacts.$inferInsert
