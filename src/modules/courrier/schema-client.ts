import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  foreignKey,
  mysqlTable,
  smallint,
  tinyint,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { primaryKeyId, timestamps } from '../../db/columns.ts'
import { tenantId } from '../../db/tenants.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { mailCategoryEnum } from './schema.ts'

/**
 * Courrier côté client, recette du 17/11/2026 (ADR 078) : les catégories
 * proposées réglées par le centre et par chaque personne, et le carnet
 * d'adresses de réexpédition de l'entreprise.
 *
 * Écrites sous portée client pour ce qui relève de la personne ou de
 * l'entreprise : les triggers (`62-courrier-client.sql`, `CA024`) refusent
 * une entreprise hors de la portée et tiennent chaque ligne à son
 * propriétaire. Les réglages du centre ne s'écrivent jamais sous portée
 * client.
 */

/**
 * Catégories proposées aux clients, telles que le centre les règle
 * (ADR 078) : nom affiché, masquée ou non, rang. Une ligne au plus par
 * catégorie de départ (`categories.ts`) ; sans ligne, le nom et le rang du
 * code. Le centre ne crée pas de catégorie : la liste de départ est une
 * énumération (ADR 044), le client crée les siennes (ADR 060).
 */
export const mailCategoryDefaults = mysqlTable(
  'mail_category_defaults',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    category: mailCategoryEnum('category').notNull(),
    /** Nom affiché aux clients ; nul : celui du code. */
    name: varchar('name', { length: 40 }),
    /** Plus proposée au classement ; un pli déjà rangé y reste. */
    hidden: boolean('hidden').notNull().default(false),
    /** Rang dans la liste ; nul : celui du code. */
    position: smallint('position'),
    ...timestamps(),
  },
  (table) => [
    unique('mail_category_defaults_tenant_id_id_key').on(table.tenantId, table.id),
    uniqueIndex('mail_category_defaults_category_key').on(table.tenantId, table.category),
    check(
      'mail_category_defaults_name_valid',
      sql`${table.name} is null or (trim(${table.name}) <> '' and char_length(${table.name}) <= 40)`,
    ),
    check('mail_category_defaults_position_valid', sql`${table.position} is null or ${table.position} >= 0`),
  ],
)

export type MailCategoryDefault = typeof mailCategoryDefaults.$inferSelect

/**
 * Réglage d'une catégorie proposée par une personne de l'espace client
 * (ADR 078) : la renommer, la masquer, la ranger — pour elle seule, la
 * portée du classement (ADR 044, l'accès d'une personne à une entreprise).
 * Chaque valeur nulle suit le réglage du centre, puis le code : le centre
 * garde ses catégories intactes, la personne ne change que sa vue.
 *
 * Le nom est du texte libre : il s'efface avec la personne ou l'entreprise
 * anonymisée (`62-courrier-client.sql`).
 */
export const mailMemberCategoryPrefs = mysqlTable(
  'mail_member_category_prefs',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    clientId: char('client_id', { length: 36 }).notNull(),
    clientMemberId: char('client_member_id', { length: 36 }).notNull(),
    category: mailCategoryEnum('category').notNull(),
    name: varchar('name', { length: 40 }),
    /** Nul : comme le centre. */
    hidden: boolean('hidden'),
    position: smallint('position'),
    ...timestamps(),
  },
  (table) => [
    unique('mail_member_category_prefs_tenant_id_id_key').on(table.tenantId, table.id),
    uniqueIndex('mail_member_category_prefs_member_key').on(
      table.tenantId,
      table.clientMemberId,
      table.category,
    ),
    foreignKey({
      name: 'mail_member_category_prefs_member_fk',
      columns: [table.tenantId, table.clientId, table.clientMemberId],
      foreignColumns: [clientMembers.tenantId, clientMembers.clientId, clientMembers.id],
    }).onDelete('restrict'),
    check(
      'mail_member_category_prefs_name_valid',
      sql`${table.name} is null or (trim(${table.name}) <> '' and char_length(${table.name}) <= 40)`,
    ),
    check(
      'mail_member_category_prefs_position_valid',
      sql`${table.position} is null or ${table.position} >= 0`,
    ),
  ],
)

export type MailMemberCategoryPref = typeof mailMemberCategoryPrefs.$inferSelect

/**
 * Carnet d'adresses de réexpédition d'une entreprise (ADR 078) : partagé par
 * les personnes de son espace, une adresse par défaut au plus
 * (`mail_forward_addresses_default_key`), proposée en premier à chaque
 * demande d'envoi. La demande recopie l'adresse choisie et la fige
 * (ADR 037) : modifier ou supprimer une adresse du carnet ne change aucune
 * demande déjà déposée.
 *
 * Réglage de l'entreprise, comme une catégorie personnelle (ADR 060) : une
 * adresse retirée l'est vraiment. Données personnelles : le carnet s'efface
 * avec l'entreprise anonymisée (`62-courrier-client.sql`).
 */
export const mailForwardAddresses = mysqlTable(
  'mail_forward_addresses',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    clientId: char('client_id', { length: 36 }).notNull(),
    /** Nom court, facultatif : « Siège », « Chez le comptable ». */
    label: varchar('label', { length: 60 }),
    recipient: varchar('recipient', { length: 120 }).notNull(),
    line1: varchar('line1', { length: 120 }).notNull(),
    line2: varchar('line2', { length: 120 }),
    postalCode: varchar('postal_code', { length: 16 }).notNull(),
    city: varchar('city', { length: 80 }).notNull(),
    /** ISO 3166-1 alpha-2, comme la demande de réexpédition. */
    country: char('country', { length: 2 }).notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    /**
     * Colonne générée : 1 pour l'adresse par défaut, NULL sinon. Porte
     * l'unicité « une adresse par défaut par entreprise » (MySQL n'a pas
     * d'index partiel). Jamais écrite.
     */
    defaultLive: tinyint('default_live').generatedAlwaysAs(sql`if(is_default, 1, null)`, { mode: 'virtual' }),
    ...timestamps(),
  },
  (table) => [
    unique('mail_forward_addresses_tenant_id_id_key').on(table.tenantId, table.id),
    uniqueIndex('mail_forward_addresses_default_key').on(table.tenantId, table.clientId, table.defaultLive),
    foreignKey({
      name: 'mail_forward_addresses_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    check(
      'mail_forward_addresses_complete',
      sql`trim(${table.recipient}) <> '' and trim(${table.line1}) <> ''
        and trim(${table.postalCode}) <> '' and trim(${table.city}) <> ''`,
    ),
    check('mail_forward_addresses_label_valid', sql`${table.label} is null or trim(${table.label}) <> ''`),
  ],
)

export type MailForwardAddress = typeof mailForwardAddresses.$inferSelect
