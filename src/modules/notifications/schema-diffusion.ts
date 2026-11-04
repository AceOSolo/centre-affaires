import { sql } from 'drizzle-orm'
import {
  char,
  check,
  foreignKey,
  index,
  int,
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
import { clients } from '../clients/schema.ts'
import {
  broadcastRecipientStatuses,
  broadcastTargets,
  type BroadcastRecipientStatus,
  type BroadcastTarget,
} from './diffusion-regles.ts'

/**
 * Messages groupés aux clients (ADR 060) : un message libre de l'équipe —
 * fermeture, travaux, nouveau service — envoyé aux domiciliés, aux clients
 * des bureaux ou à une sélection, par le moteur de notifications
 * (`client_broadcast`, catégorie « Informations du centre »).
 *
 * `client_broadcasts` est l'historique : ce qui a été dit, par qui, quand, à
 * qui. `client_broadcast_recipients` fige la liste des entreprises au moment
 * de la confirmation, et porte l'issue de chacune : c'est ce qui permet
 * d'envoyer par paquets, de reprendre un envoi interrompu sans servir deux
 * fois la même entreprise, et de compter les échecs même après la purge du
 * journal des envois.
 *
 * Le texte est celui du centre, le même pour tous : il se garde, à la
 * différence du corps des messages du journal (ADR 038), qui recopierait les
 * données de chaque client. Aucune adresse n'est recopiée ici : elles sont
 * au journal, et partent avec sa purge.
 *
 * Réglage du back-office seul : aucune écriture sous portée client (trigger,
 * `70-notifications.sql`).
 */

export { broadcastRecipientStatuses, broadcastTargets, type BroadcastRecipientStatus, type BroadcastTarget }
export const broadcastTargetEnum = (name: string) => mysqlEnum(name, broadcastTargets)
export const broadcastRecipientStatusEnum = (name: string) => mysqlEnum(name, broadcastRecipientStatuses)

export const clientBroadcasts = mysqlTable(
  'client_broadcasts',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    subject: varchar('subject', { length: 150 }).notNull(),
    body: text('body').notNull(),
    target: broadcastTargetEnum('target').notNull(),
    createdBy: char('created_by', { length: 36 })
      .notNull()
      .references(() => staffMembers.id, { onDelete: 'restrict' }),
    /** Toutes les entreprises servies (ou écartées avec leur raison). Nulle : envoi en cours. */
    completedAt: instant('completed_at'),
    ...timestamps(),
  },
  (table) => [
    unique('client_broadcasts_tenant_id_id_key').on(table.tenantId, table.id),
    check(
      'client_broadcasts_text_valid',
      sql`trim(${table.subject}) <> '' and char_length(${table.subject}) <= 150 and trim(${table.body}) <> '' and char_length(${table.body}) <= 5000`,
    ),
    index('client_broadcasts_recent_idx').on(table.tenantId, table.createdAt),
  ],
)

export type ClientBroadcast = typeof clientBroadcasts.$inferSelect
export type NewClientBroadcast = typeof clientBroadcasts.$inferInsert

export const clientBroadcastRecipients = mysqlTable(
  'client_broadcast_recipients',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    broadcastId: char('broadcast_id', { length: 36 }).notNull(),
    clientId: char('client_id', { length: 36 }).notNull(),
    status: broadcastRecipientStatusEnum('status').notNull().default('pending'),
    /** Adresses servies — ou qui l'auraient été, SMTP non configuré. */
    addressCount: int('address_count').notNull().default(0),
    /** Adresses refusées par le serveur SMTP, parmi elles. */
    failedCount: int('failed_count').notNull().default(0),
    /** Cause d'un échec, raison d'un envoi écarté : celle du journal, jamais le message. */
    error: varchar('error', { length: 500 }),
    /**
     * Paquet qui s'en occupe, et depuis quand : un envoi interrompu (serveur
     * redémarré) se reprend sans servir deux fois une entreprise déjà prise
     * par un paquet encore vivant.
     */
    claimToken: char('claim_token', { length: 36 }),
    claimedAt: instant('claimed_at'),
    processedAt: instant('processed_at'),
  },
  (table) => [
    foreignKey({
      name: 'client_broadcast_recipients_broadcast_fk',
      columns: [table.tenantId, table.broadcastId],
      foreignColumns: [clientBroadcasts.tenantId, clientBroadcasts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'client_broadcast_recipients_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    uniqueIndex('client_broadcast_recipients_client_key').on(table.tenantId, table.broadcastId, table.clientId),
    // Une entreprise servie a une date ; une entreprise en attente n'en a pas.
    check(
      'client_broadcast_recipients_processed',
      sql`(${table.status} = 'pending') = (${table.processedAt} is null)`,
    ),
    check(
      'client_broadcast_recipients_counts',
      sql`${table.addressCount} >= 0 and ${table.failedCount} >= 0 and ${table.failedCount} <= ${table.addressCount}`,
    ),
    index('client_broadcast_recipients_status_idx').on(table.tenantId, table.broadcastId, table.status),
  ],
)

export type ClientBroadcastRecipient = typeof clientBroadcastRecipients.$inferSelect
