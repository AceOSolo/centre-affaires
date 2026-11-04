import { sql } from 'drizzle-orm'
import {
  char,
  check,
  foreignKey,
  index,
  mysqlEnum,
  mysqlTable,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { instant, primaryKeyId } from '../../db/columns.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenantId } from '../../db/tenants.ts'
import { clients } from '../clients/schema.ts'

/**
 * Notifications de l'équipe : la cloche du back-office (ADR 059).
 *
 * Un événement qui attend l'équipe — une demande déposée par un client, un
 * état des lieux qu'il a signé — y laisse une ligne, posée par le même
 * déclencheur que le courriel au centre (`declencheurs-*.ts`). Le courriel
 * prévient la boîte du centre ; la cloche prévient chaque membre, qui la
 * marque lue pour lui seul (`staff_notification_reads`).
 *
 * Aucune donnée personnelle n'y est recopiée : `summary` ne dit que la
 * ressource, le créneau, l'offre ou la nature du pli. Le client se lit par
 * la fiche (`client_id`), le demandeur d'une page publique par sa demande :
 * leur anonymisation (ADR 040) vaut donc aussi pour la cloche.
 */

/**
 * Ce qui fait sonner la cloche, et le droit qui la fait voir
 * (`staffNotificationPermissions`, `cloche.ts`).
 *
 * - `booking_request` : demande de réservation depuis l'espace client
 *   (ressource « accord de l'accueil », ADR 036) ;
 * - `quote_request` : demande par produit de la page publique — salle,
 *   bureau, camion —, réservation et devis nés ensemble (ADR 043) ;
 * - `domiciliation_request` : demande de domiciliation, un devis sans
 *   réservation (ADR 043) ;
 * - `offer_request` : offre demandée depuis l'espace client (ADR 041) ;
 * - `mail_request` : ouverture, numérisation, réexpédition (ADR 037) ;
 * - `inspection_signed` : état des lieux signé par le client (ADR 039).
 */
export const staffNotificationKinds = [
  'booking_request',
  'quote_request',
  'domiciliation_request',
  'offer_request',
  'mail_request',
  'inspection_signed',
] as const
export type StaffNotificationKind = (typeof staffNotificationKinds)[number]
export const staffNotificationKindEnum = (name: string) => mysqlEnum(name, staffNotificationKinds)

/**
 * Une notification de l'équipe. `related_id` désigne l'entité que son
 * `kind` annonce : réservation, devis, demande d'offre, demande de courrier,
 * état des lieux. Pas de clé étrangère, comme au journal des envois : l'entité
 * peut être de cinq tables, et aucune ne se supprime.
 *
 * Une seule par événement (`staff_notifications_event_key`) : un déclencheur
 * rejoué ne sonne pas deux fois.
 *
 * Purgée au terme du journal des messages
 * (`tenants.notification_log_retention_months`, tâche de nuit) ; la cloche,
 * elle, ne montre que les derniers jours (`STAFF_NOTIFICATION_DAYS`).
 */
export const staffNotifications = mysqlTable(
  'staff_notifications',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    kind: staffNotificationKindEnum('kind').notNull(),
    /** Entreprise concernée ; nulle pour une demande de la page publique sans compte. */
    clientId: char('client_id', { length: 36 }),
    relatedId: char('related_id', { length: 36 }).notNull(),
    /** Ce dont il s'agit, sans donnée personnelle : « Salle Atlas · lundi 5 octobre 2026, de 09:00 à 11:00 ». */
    summary: varchar('summary', { length: 255 }).notNull(),
    createdAt: instant('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    unique('staff_notifications_tenant_id_id_key').on(table.tenantId, table.id),
    uniqueIndex('staff_notifications_event_key').on(table.tenantId, table.kind, table.relatedId),
    foreignKey({
      name: 'staff_notifications_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    check('staff_notifications_summary_not_blank', sql`trim(${table.summary}) <> ''`),
    index('staff_notifications_recent_idx').on(table.tenantId, table.createdAt),
  ],
)

export type StaffNotification = typeof staffNotifications.$inferSelect
export type NewStaffNotification = typeof staffNotifications.$inferInsert

/**
 * « Lu », membre par membre : une ligne par notification lue. Sans ligne, la
 * notification est non lue pour ce membre. Supprimée avec sa notification.
 */
export const staffNotificationReads = mysqlTable(
  'staff_notification_reads',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    notificationId: char('notification_id', { length: 36 }).notNull(),
    staffMemberId: char('staff_member_id', { length: 36 })
      .notNull()
      .references(() => staffMembers.id, { onDelete: 'restrict' }),
    readAt: instant('read_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    foreignKey({
      name: 'staff_notification_reads_notification_fk',
      columns: [table.tenantId, table.notificationId],
      foreignColumns: [staffNotifications.tenantId, staffNotifications.id],
    }).onDelete('cascade'),
    uniqueIndex('staff_notification_reads_member_key').on(
      table.tenantId,
      table.staffMemberId,
      table.notificationId,
    ),
  ],
)

export type StaffNotificationRead = typeof staffNotificationReads.$inferSelect
