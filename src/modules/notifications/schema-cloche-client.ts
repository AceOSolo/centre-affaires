import { sql } from 'drizzle-orm'
import { char, check, foreignKey, index, int, json, mysqlTable, uniqueIndex } from 'drizzle-orm/mysql-core'

import { instant, primaryKeyId, timestamps } from '../../db/columns.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenantId } from '../../db/tenants.ts'
import { clientMembers } from '../clients/schema.ts'
import { notificationDeliveries } from './schema.ts'

/**
 * Cloche de l'espace client (ADR 077).
 *
 * Elle se nourrit du **journal des messages** (`notification_deliveries`,
 * ADR 038) : chaque message adressé à l'entreprise — courrier reçu,
 * numérisation prête, demande acceptée ou refusée, message du centre… — y a
 * déjà sa ligne, quelle que soit l'issue du courriel (envoyé, désactivé,
 * refusé par la personne). La cloche n'écrit rien de plus, sauf le « lu ».
 */

/**
 * « Lu », personne par personne : une ligne par nouveauté ouverte, au titre de
 * l'accès (`client_members`) de l'entreprise à qui le message s'adressait.
 * Sans ligne, la nouveauté est non lue pour cette personne.
 *
 * Purgée avec sa ligne du journal (clé étrangère en cascade), au terme de
 * `tenants.notification_log_retention_months`. La base refuse une lecture qui
 * ne vise pas un message de l'entreprise de l'accès (`CA023`,
 * `74-cloche-client.sql`).
 */
export const clientNotificationReads = mysqlTable(
  'client_notification_reads',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    /** Entreprise du message et de l'accès : la clé étrangère et le trigger la tiennent égale. */
    clientId: char('client_id', { length: 36 }).notNull(),
    clientMemberId: char('client_member_id', { length: 36 }).notNull(),
    deliveryId: char('delivery_id', { length: 36 }).notNull(),
    readAt: instant('read_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    // La personne relève de l'entreprise de la ligne.
    foreignKey({
      name: 'client_notification_reads_member_fk',
      columns: [table.tenantId, table.clientId, table.clientMemberId],
      foreignColumns: [clientMembers.tenantId, clientMembers.clientId, clientMembers.id],
    }).onDelete('restrict'),
    // Le « lu » part avec sa ligne du journal, à la purge.
    foreignKey({
      name: 'client_notification_reads_delivery_fk',
      columns: [table.deliveryId],
      foreignColumns: [notificationDeliveries.id],
    }).onDelete('cascade'),
    uniqueIndex('client_notification_reads_member_key').on(table.tenantId, table.clientMemberId, table.deliveryId),
    index('client_notification_reads_client_idx').on(table.tenantId, table.clientId),
  ],
)

export type ClientNotificationRead = typeof clientNotificationReads.$inferSelect

/**
 * Réglage de la cloche de l'espace client, par centre (règle commune de la
 * recette du 17/11 : rien d'écrit en dur). Sans ligne, les valeurs par défaut
 * du code s'appliquent (`cloche-client.ts`) : toutes les nouveautés, trente
 * jours.
 *
 * `hidden_events` liste les nouveautés que le centre **retire** de la cloche,
 * et non celles qu'il montre : une nouveauté ajoutée plus tard au code y
 * paraît sans qu'on y touche.
 *
 * Réglage du back-office seul : refusé sous portée client (trigger).
 */
export const clientBellSettings = mysqlTable(
  'client_bell_settings',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    hiddenEvents: json('hidden_events').$type<string[]>().notNull().default(sql`(JSON_ARRAY())`),
    /** Jours pendant lesquels une nouveauté reste dans la cloche, de 1 à 90. */
    windowDays: int('window_days').notNull().default(30),
    updatedBy: char('updated_by', { length: 36 }).references(() => staffMembers.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('client_bell_settings_tenant_key').on(table.tenantId),
    check('client_bell_settings_window_days', sql`${table.windowDays} between 1 and 90`),
    check('client_bell_settings_hidden_array', sql`json_type(${table.hiddenEvents}) = 'ARRAY'`),
  ],
)

export type ClientBellSettingsRow = typeof clientBellSettings.$inferSelect
