import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
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

import { primaryKeyId, timestamps } from '../../db/columns.ts'
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
 * migration 0039) et recopiés ici, à l'identique (test en base).
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
] as const
export type NotificationEvent = (typeof notificationEvents)[number]
export const notificationEventEnum = pgEnum('notification_event', notificationEvents)

/** À qui s'adresse un événement : les personnes de l'entreprise, ou l'adresse du centre. */
export const notificationAudiences = ['client', 'centre'] as const
export type NotificationAudience = (typeof notificationAudiences)[number]
export const notificationAudienceEnum = pgEnum('notification_audience', notificationAudiences)

/**
 * Catégories auxquelles une personne de l'espace client peut renoncer
 * (`notification_preferences`). Un événement sans catégorie (accès ouvert,
 * messages au centre) part toujours.
 */
export const notificationCategories = ['mail', 'bookings', 'invoices', 'contracts', 'inspections'] as const
export type NotificationCategory = (typeof notificationCategories)[number]
export const notificationCategoryEnum = pgEnum('notification_category', notificationCategories)

/** Miroir de `notification_event_audience()` (migration 0039). */
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
}

/** Miroir de `notification_event_category()` (migration 0039). Nul : pas de renoncement possible. */
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
export const notificationDeliveryStatusEnum = pgEnum(
  'notification_delivery_status',
  notificationDeliveryStatuses,
)

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
] as const
export type NotificationRelatedType = (typeof notificationRelatedTypes)[number]
export const notificationRelatedTypeEnum = pgEnum(
  'notification_related_type',
  notificationRelatedTypes,
)

/**
 * Modèles de messages du centre, un par événement au plus.
 *
 * Sans ligne, le texte par défaut du code s'applique. `subject` et `body`
 * portent des variables nommées entre doubles accolades (`{{client}}`,
 * `{{lien}}`), propres à chaque événement : le code les vérifie à
 * l'enregistrement et les remplace à l'envoi. `active` faux : l'événement
 * n'envoie plus rien (journalisé `skipped`).
 *
 * Réglage du back-office seul : invisible et non modifiable sous portée
 * client. Ne se supprime pas (revenir au texte par défaut, c'est le réécrire).
 */
export const notificationTemplates = pgTable(
  'notification_templates',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    event: notificationEventEnum('event').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    active: boolean('active').notNull().default(true),
    updatedBy: uuid('updated_by').references(() => staffMembers.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (table) => [
    unique('notification_templates_tenant_id_id_key').on(table.tenantId, table.id),
    uniqueIndex('notification_templates_event_key').on(table.tenantId, table.event),
    check(
      'notification_templates_text_valid',
      sql`btrim(${table.subject}) <> '' and length(${table.subject}) <= 200 and btrim(${table.body}) <> '' and length(${table.body}) <= 10000`,
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
 * Ajout seul : le rôle applicatif n'a ni `UPDATE` ni `DELETE` (migration
 * 0042) ; la purge passe par `purge_expired_notification_deliveries()`, au
 * terme de `tenants.notification_log_retention_months`. Sous portée client,
 * une entreprise ne lit que les messages qui lui ont été adressés
 * (`audience = 'client'`). Le journal s'écrit sous `withTenant()`.
 */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    event: notificationEventEnum('event').notNull(),
    /** Fixée par l'événement (contrainte `notification_deliveries_audience_matches`). */
    audience: notificationAudienceEnum('audience').notNull(),
    /** Entreprise concernée. Toujours posée pour un message à un client. */
    clientId: uuid('client_id'),
    /** Adresses, en minuscules. Vide pour un envoi `skipped` faute de destinataire. */
    recipients: text('recipients').array().notNull().default(sql`'{}'::text[]`),
    /** Destinataires refusés par le serveur SMTP, parmi `recipients`. */
    failedRecipients: text('failed_recipients').array().notNull().default(sql`'{}'::text[]`),
    subject: text('subject').notNull(),
    status: notificationDeliveryStatusEnum('status').notNull(),
    /** Cause d'un échec ou d'un envoi sauté, lisible par l'équipe. Jamais le contenu du message. */
    error: text('error'),
    relatedType: notificationRelatedTypeEnum('related_type'),
    /** Pas de clé étrangère : l'entité peut être de huit tables ; aucune ne se supprime. */
    relatedId: uuid('related_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'notification_deliveries_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    // La fonction prend du texte : elle est posée avant les énumérations, par
    // la migration 0039, comme les règles d'arrondi avant les factures (0029).
    check(
      'notification_deliveries_audience_matches',
      sql`${table.audience}::text = notification_event_audience(${table.event}::text)`,
    ),
    check(
      'notification_deliveries_client_audience',
      sql`${table.audience} <> 'client' or ${table.clientId} is not null`,
    ),
    check('notification_deliveries_subject_not_blank', sql`btrim(${table.subject}) <> ''`),
    check(
      'notification_deliveries_status_consistent',
      sql`${table.failedRecipients} <@ ${table.recipients}
        and case ${table.status}
          when 'sent' then cardinality(${table.recipients}) > 0 and cardinality(${table.failedRecipients}) = 0
          when 'failed' then ${table.error} is not null and cardinality(${table.failedRecipients}) > 0
          when 'not_configured' then cardinality(${table.failedRecipients}) = 0
          when 'skipped' then ${table.error} is not null and cardinality(${table.failedRecipients}) = 0
          else false
        end`,
    ),
    check(
      'notification_deliveries_related_complete',
      sql`(${table.relatedType} is null) = (${table.relatedId} is null)`,
    ),
    index('notification_deliveries_sent_idx').on(table.tenantId, table.sentAt),
    index('notification_deliveries_client_idx')
      .on(table.tenantId, table.clientId, table.sentAt)
      .where(sql`client_id is not null`),
    index('notification_deliveries_related_idx')
      .on(table.tenantId, table.relatedType, table.relatedId)
      .where(sql`related_id is not null`),
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
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    clientId: uuid('client_id').notNull(),
    clientMemberId: uuid('client_member_id').notNull(),
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
