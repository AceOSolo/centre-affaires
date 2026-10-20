import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { instant, primaryKeyId, timestamps } from '../../db/columns.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenantId } from '../../db/tenants.ts'
import { clientMembers, clients } from '../clients/schema.ts'

/**
 * Moteur de notifications (R26, ADR 038) : modèles de messages éditables par
 * centre et par événement, journal des envois, préférences des personnes de
 * l'espace client.
 *
 * Un courriel prévient, il ne transporte jamais de document (ADR 015) : ni
 * pièce jointe, ni contenu de pli, ni expéditeur. Le journal ne garde pas le
 * corps des messages, seulement leur objet.
 */

/**
 * Événements qui déclenchent un message. Le destinataire (`audience`) et la
 * catégorie de préférence de chacun sont fixés par la base
 * (`notification_event_audience()`, `notification_event_category()`,
 * `src/db/regles/70-notifications.sql`) et recopiés ici, à l'identique (test
 * en base).
 */
export const notificationEvents = [
  'mail_received',
  'mail_scanned',
  'mail_request_submitted',
  'mail_request_done',
  'mail_request_refused',
  'booking_request_submitted',
  'booking_request_accepted',
  'booking_request_refused',
  'booking_confirmed',
  'booking_cancelled',
  'invoice_issued',
  'invoice_reminder',
  'contract_activated',
  'inspection_to_sign',
  'inspection_signed',
  'member_invited',
  'offer_requested',
  // Fin de tournée (ADR 044) : un message par entreprise.
  'mail_batch_received',
  'mail_none',
] as const
export type NotificationEvent = (typeof notificationEvents)[number]
export const notificationEventEnum = (name: string) => mysqlEnum(name, notificationEvents)

/** À qui s'adresse un événement : les personnes de l'entreprise, ou l'adresse du centre. */
export const notificationAudiences = ['client', 'centre'] as const
export type NotificationAudience = (typeof notificationAudiences)[number]
export const notificationAudienceEnum = (name: string) => mysqlEnum(name, notificationAudiences)

/**
 * Catégories auxquelles une personne de l'espace client peut renoncer
 * (`notification_preferences`). Un événement sans catégorie (accès ouvert,
 * messages au centre) part toujours.
 */
export const notificationCategories = [
  'mail',
  'bookings',
  'invoices',
  'contracts',
  'inspections',
  // « Pas de courrier aujourd'hui » (ADR 044) : se refuse sans renoncer au courrier reçu.
  'mail_none',
] as const
export type NotificationCategory = (typeof notificationCategories)[number]
export const notificationCategoryEnum = (name: string) => mysqlEnum(name, notificationCategories)

/** Miroir de `notification_event_audience()` (`70-notifications.sql`). */
export const notificationEventAudience: Record<NotificationEvent, NotificationAudience> = {
  mail_received: 'client',
  mail_scanned: 'client',
  mail_request_submitted: 'centre',
  mail_request_done: 'client',
  mail_request_refused: 'client',
  booking_request_submitted: 'centre',
  booking_request_accepted: 'client',
  booking_request_refused: 'client',
  booking_confirmed: 'client',
  booking_cancelled: 'client',
  invoice_issued: 'client',
  invoice_reminder: 'client',
  contract_activated: 'client',
  inspection_to_sign: 'client',
  inspection_signed: 'centre',
  member_invited: 'client',
  offer_requested: 'centre',
  mail_batch_received: 'client',
  mail_none: 'client',
}

/** Miroir de `notification_event_category()` (`70-notifications.sql`). Nul : pas de renoncement possible. */
export const notificationEventCategory: Record<NotificationEvent, NotificationCategory | null> = {
  mail_received: 'mail',
  mail_scanned: 'mail',
  mail_request_submitted: null,
  mail_request_done: 'mail',
  mail_request_refused: 'mail',
  booking_request_submitted: null,
  booking_request_accepted: 'bookings',
  booking_request_refused: 'bookings',
  booking_confirmed: 'bookings',
  booking_cancelled: 'bookings',
  invoice_issued: 'invoices',
  invoice_reminder: 'invoices',
  contract_activated: 'contracts',
  inspection_to_sign: 'inspections',
  inspection_signed: null,
  member_invited: null,
  offer_requested: null,
  mail_batch_received: 'mail',
  mail_none: 'mail_none',
}

/**
 * Issue d'un envoi :
 *
 * - `sent` : parti vers chaque destinataire ;
 * - `failed` : au moins un envoi refusé par le serveur SMTP (`failed_recipients`,
 *   `error`) ;
 * - `not_configured` : SMTP non configuré, rien n'est parti (développement) ;
 * - `skipped` : rien à envoyer — modèle désactivé, aucun destinataire, toutes
 *   les personnes ont renoncé à la catégorie. `error` dit pourquoi.
 */
export const notificationDeliveryStatuses = ['sent', 'failed', 'not_configured', 'skipped'] as const
export type NotificationDeliveryStatus = (typeof notificationDeliveryStatuses)[number]
export const notificationDeliveryStatusEnum = (name: string) =>
  mysqlEnum(name, notificationDeliveryStatuses)

/** Nature de l'entité dont parle le message (`related_type`, `related_id`). */
export const notificationRelatedTypes = [
  'mail_item',
  'mail_request',
  'booking',
  'invoice',
  'contract',
  'inspection',
  'client_member',
  'offer',
  'mail_batch',
] as const
export type NotificationRelatedType = (typeof notificationRelatedTypes)[number]
export const notificationRelatedTypeEnum = (name: string) =>
  mysqlEnum(name, notificationRelatedTypes)

/**
 * Modèles de messages du centre, un par événement au plus.
 *
 * Sans ligne, le texte par défaut du code s'applique. `subject` et `body`
 * portent des variables nommées entre doubles accolades (`{{client}}`,
 * `{{lien}}`), propres à chaque événement : le code les vérifie à
 * l'enregistrement et les remplace à l'envoi. `active` faux : l'événement
 * n'envoie plus rien (journalisé `skipped`).
 *
 * Réglage du back-office seul : non modifiable sous portée client (trigger),
 * jamais lu par l'espace client. Ne se supprime pas (revenir au texte par
 * défaut, c'est le réécrire : trigger).
 */
export const notificationTemplates = mysqlTable(
  'notification_templates',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    event: notificationEventEnum('event').notNull(),
    subject: varchar('subject', { length: 255 }).notNull(),
    body: text('body').notNull(),
    active: boolean('active').notNull().default(true),
    updatedBy: char('updated_by', { length: 36 }).references(() => staffMembers.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (table) => [
    unique('notification_templates_tenant_id_id_key').on(table.tenantId, table.id),
    uniqueIndex('notification_templates_event_key').on(table.tenantId, table.event),
    check(
      'notification_templates_text_valid',
      sql`trim(${table.subject}) <> '' and char_length(${table.subject}) <= 200 and trim(${table.body}) <> '' and char_length(${table.body}) <= 10000`,
    ),
  ],
)

export type NotificationTemplate = typeof notificationTemplates.$inferSelect
export type NewNotificationTemplate = typeof notificationTemplates.$inferInsert

/**
 * Journal des envois (R26, ADR 038) : un message par ligne, tous ses
 * destinataires ensemble (chacun reçoit son exemplaire, sans voir les autres).
 *
 * **Jamais le corps** : il n'y a pas de colonne pour lui. L'objet suffit à
 * dire ce qui est parti ; le corps, recomposable depuis le modèle, n'a pas à
 * être une copie de plus des données du client.
 *
 * Ajout seul : des triggers refusent `UPDATE` et `DELETE`
 * (`70-notifications.sql`) ; la purge passe par
 * `purge_expired_notification_deliveries()`, au terme de
 * `tenants.notification_log_retention_months`. Sous portée client,
 * une entreprise ne doit lire que les messages qui lui ont été adressés
 * (`audience = 'client'`) : la base ne filtre plus les lectures, la requête le
 * fait. Le journal s'écrit sous `withTenant()`.
 */
export const notificationDeliveries = mysqlTable(
  'notification_deliveries',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    event: notificationEventEnum('event').notNull(),
    /** Fixée par l'événement (contrainte `notification_deliveries_audience_matches`). */
    audience: notificationAudienceEnum('audience').notNull(),
    /** Entreprise concernée. Toujours posée pour un message à un client. */
    clientId: char('client_id', { length: 36 }),
    /** Adresses, en minuscules. Vide pour un envoi `skipped` faute de destinataire. */
    recipients: json('recipients').$type<string[]>().notNull().default(sql`(JSON_ARRAY())`),
    /** Destinataires refusés par le serveur SMTP, parmi `recipients`. */
    failedRecipients: json('failed_recipients')
      .$type<string[]>()
      .notNull()
      .default(sql`(JSON_ARRAY())`),
    subject: text('subject').notNull(),
    status: notificationDeliveryStatusEnum('status').notNull(),
    /** Cause d'un échec ou d'un envoi sauté, lisible par l'équipe. Jamais le contenu du message. */
    error: text('error'),
    relatedType: notificationRelatedTypeEnum('related_type'),
    /** Pas de clé étrangère : l'entité peut être de huit tables ; aucune ne se supprime. */
    relatedId: char('related_id', { length: 36 }),
    sentAt: instant('sent_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    foreignKey({
      name: 'notification_deliveries_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    // `notification_deliveries_audience_matches` (l'audience est celle de
    // l'événement) n'est pas une contrainte `CHECK` : MySQL n'y accepte pas de
    // fonction stockée. C'est un trigger (`70-notifications.sql`) qui lève la
    // même erreur de contrainte (3819).
    check(
      'notification_deliveries_client_audience',
      sql`${table.audience} <> 'client' or ${table.clientId} is not null`,
    ),
    check('notification_deliveries_subject_not_blank', sql`trim(${table.subject}) <> ''`),
    check(
      'notification_deliveries_status_consistent',
      // `failed <@ recipients` devient `JSON_CONTAINS(recipients, failed)` :
      // tout élément de `failed_recipients` figure dans `recipients`.
      sql`JSON_CONTAINS(${table.recipients}, ${table.failedRecipients})
        and case ${table.status}
          when 'sent' then JSON_LENGTH(${table.recipients}) > 0 and JSON_LENGTH(${table.failedRecipients}) = 0
          when 'failed' then ${table.error} is not null and JSON_LENGTH(${table.failedRecipients}) > 0
          when 'not_configured' then JSON_LENGTH(${table.failedRecipients}) = 0
          when 'skipped' then ${table.error} is not null and JSON_LENGTH(${table.failedRecipients}) = 0
          else false
        end`,
    ),
    check(
      'notification_deliveries_related_complete',
      sql`(${table.relatedType} is null) = (${table.relatedId} is null)`,
    ),
    index('notification_deliveries_sent_idx').on(table.tenantId, table.sentAt),
    index('notification_deliveries_client_idx').on(table.tenantId, table.clientId, table.sentAt),
    index('notification_deliveries_related_idx').on(
      table.tenantId,
      table.relatedType,
      table.relatedId,
    ),
  ],
)

export type NotificationDelivery = typeof notificationDeliveries.$inferSelect
export type NewNotificationDelivery = typeof notificationDeliveries.$inferInsert

/**
 * Préférences d'une personne de l'espace client, par catégorie. Sans ligne :
 * elle reçoit tout. La personne les règle depuis son espace, sous portée
 * client ; la ligne porte l'entreprise de l'accès (clé étrangère). Un
 * renoncement ne vaut que pour cet accès : la même personne peut garder les
 * factures d'une société et pas d'une autre.
 */
export const notificationPreferences = mysqlTable(
  'notification_preferences',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    clientId: char('client_id', { length: 36 }).notNull(),
    clientMemberId: char('client_member_id', { length: 36 }).notNull(),
    category: notificationCategoryEnum('category').notNull(),
    enabled: boolean('enabled').notNull(),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'notification_preferences_member_fk',
      columns: [table.tenantId, table.clientId, table.clientMemberId],
      foreignColumns: [clientMembers.tenantId, clientMembers.clientId, clientMembers.id],
    }).onDelete('restrict'),
    uniqueIndex('notification_preferences_member_category_key').on(
      table.tenantId,
      table.clientMemberId,
      table.category,
    ),
    index('notification_preferences_client_idx').on(table.tenantId, table.clientId),
  ],
)

export type NotificationPreference = typeof notificationPreferences.$inferSelect
export type NewNotificationPreference = typeof notificationPreferences.$inferInsert
