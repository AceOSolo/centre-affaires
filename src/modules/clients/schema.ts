import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  mysqlEnum,
  mysqlTable,
  text,
  tinyint,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { deletedAt, instant, primaryKeyId, timestamps } from '../../db/columns.ts'
import { anonymizationBasisEnum, anonymizationTraceCheck, staffMembers } from '../../db/staff.ts'
import { tenantId } from '../../db/tenants.ts'

/**
 * Entreprises locataires ou domiciliées. Ce sont des personnes morales : les
 * personnes qui accèdent au portail en leur nom sont dans `client_members`.
 */
export const clientStatuses = ['prospect', 'active', 'inactive'] as const
export type ClientStatus = (typeof clientStatuses)[number]
export const clientStatusEnum = (name: string) => mysqlEnum(name, clientStatuses)

/**
 * Qui a créé la fiche (ADR 045) : l'équipe depuis le back-office, ou une
 * personne qui s'est inscrite seule sur le site. Une fiche « inscription »
 * est un prospect à qualifier, pas une entreprise vérifiée.
 */
export const clientOrigins = ['back_office', 'inscription'] as const
export type ClientOrigin = (typeof clientOrigins)[number]

export const clients = mysqlTable(
  'clients',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    /** Raison sociale. */
    name: varchar('name', { length: 255 }).notNull(),
    /** SAS, SARL, association… saisie libre, les formes varient par pays. */
    legalForm: text('legal_form'),
    /** Facultatif : un client étranger n'en a pas. */
    /** 14 chiffres, sans espace (`normaliseSiret`). */
    siret: varchar('siret', { length: 14 }),
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
    origin: mysqlEnum('origin', clientOrigins).notNull().default('back_office'),
    notes: text('notes'),
    /**
     * Compte auxiliaire du client dans l'export comptable (ADR 027), sous le
     * compte collectif 411 : « DURAND ». Nul : l'export le dérive ou le
     * demande.
     */
    accountingCode: varchar('accounting_code', { length: 17 }),
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
    anonymizedAt: instant('anonymized_at'),
    /** Membre de l'équipe qui l'a décidée ; nul pour la tâche de nuit (ADR 041). */
    anonymizedBy: char('anonymized_by', { length: 36 }).references(() => staffMembers.id, { onDelete: 'restrict' }),
    /** Au terme, à la demande d'effacement, ou à la fin de la relation (`anonymizationBases`). */
    anonymizationBasis: anonymizationBasisEnum('anonymization_basis'),
    /** Jour où la demande d'effacement a été reçue, pour `erasure_request`. */
    erasureRequestedOn: date('erasure_requested_on', { mode: 'string' }),
    /**
     * Colonne générée : `1` tant que la fiche n'est pas archivée, `NULL` ensuite.
     * MySQL n'a pas d'index unique partiel : un index unique ignore les `NULL`,
     * donc l'unicité « parmi les fiches vivantes » se fait en l'incluant
     * (conventions §3.1). Jamais écrite.
     */
    live: tinyint('live').generatedAlwaysAs(sql`if(deleted_at is null, 1, null)`, {
      mode: 'virtual',
    }),
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
    check('clients_anonymization_traced', anonymizationTraceCheck(table)),
    // Deux clients vivants ne partagent pas un compte auxiliaire : leurs
    // écritures se mêleraient chez l'expert-comptable.
    // (`accounting_code` nul : plusieurs `NULL` sont admis par l'index unique.)
    uniqueIndex('clients_tenant_accounting_code_key').on(
      table.tenantId,
      table.accountingCode,
      table.live,
    ),
    check(
      'clients_accounting_code_format',
      sql`${table.accountingCode} is null or REGEXP_LIKE(${table.accountingCode}, '^[0-9A-Z]{1,17}$', 'c')`,
    ),
    // Le SIRET identifie l'entreprise : deux fiches pour le même seraient deux
    // historiques de facturation à réconcilier.
    uniqueIndex('clients_tenant_siret_key').on(table.tenantId, table.siret, table.live),
    index('clients_tenant_name_idx').on(table.tenantId, table.name),
  ],
)

export type Client = typeof clients.$inferSelect
export type NewClient = typeof clients.$inferInsert

/**
 * Personnes qui accèdent à l'espace client d'une entreprise (ADR 015).
 *
 * Même modèle que `staff_members` (ADR 008) : l'authentification dit qui est connecté,
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
export const clientMembers = mysqlTable(
  'client_members',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    clientId: char('client_id', { length: 36 }).notNull(),
    /**
     * Identifiant du compte (Better Auth, `auth_user`), nul jusqu'à la première
     * connexion. Pas de clé étrangère vers `auth_*`, pour la même raison que
     * `staff_members`.
     */
    authUserId: varchar('auth_user_id', { length: 255 }),
    /** Toujours en minuscules : c'est la clé de rattachement au compte. */
    email: varchar('email', { length: 255 }).notNull(),
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
    anonymizedAt: instant('anonymized_at'),
    /** Membre de l'équipe qui l'a décidée ; nul pour la tâche de nuit (ADR 041). */
    anonymizedBy: char('anonymized_by', { length: 36 }).references(() => staffMembers.id, { onDelete: 'restrict' }),
    anonymizationBasis: anonymizationBasisEnum('anonymization_basis'),
    /** Jour où la demande d'effacement a été reçue, pour `erasure_request`. */
    erasureRequestedOn: date('erasure_requested_on', { mode: 'string' }),
    /** `1` tant que l'accès n'est pas retiré, `NULL` ensuite : voir `clients.live`. */
    live: tinyint('live').generatedAlwaysAs(sql`if(deleted_at is null, 1, null)`, {
      mode: 'virtual',
    }),
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
    check('client_members_anonymization_traced', anonymizationTraceCheck(table)),
    // Une adresse ne vaut qu'une fois par entreprise, et redevient libre après
    // un retrait.
    uniqueIndex('client_members_client_email_key').on(
      table.tenantId,
      table.clientId,
      table.email,
      table.live,
    ),
    // Un compte n'est rattaché qu'une fois à une même entreprise.
    // (`auth_user_id` nul : plusieurs `NULL` sont admis par l'index unique.)
    uniqueIndex('client_members_client_auth_user_key').on(
      table.clientId,
      table.authUserId,
      table.live,
    ),
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
export const clientContacts = mysqlTable(
  'client_contacts',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    clientId: char('client_id', { length: 36 }).notNull(),
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
    anonymizedAt: instant('anonymized_at'),
    /**
     * `1` pour le contact principal actif, `NULL` sinon : l'index unique
     * n'admet alors qu'un principal vivant par entreprise (conventions §3.1).
     */
    primaryLive: tinyint('primary_live').generatedAlwaysAs(
      sql`if(is_primary and deleted_at is null, 1, null)`,
      { mode: 'virtual' },
    ),
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
    uniqueIndex('client_contacts_primary_key').on(
      table.tenantId,
      table.clientId,
      table.primaryLive,
    ),
    index('client_contacts_client_idx').on(table.tenantId, table.clientId),
    check('client_contacts_name_not_blank', sql`trim(${table.fullName}) <> ''`),
    check(
      'client_contacts_anonymized_archived',
      sql`${table.anonymizedAt} is null or ${table.deletedAt} is not null`,
    ),
  ],
)

export type ClientContact = typeof clientContacts.$inferSelect
export type NewClientContact = typeof clientContacts.$inferInsert
