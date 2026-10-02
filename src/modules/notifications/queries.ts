import { and, count, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm'

import { withTenant, type Database, type Transaction } from '../../db/index.ts'
import { staffMembers } from '../../db/staff.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clients } from '../clients/schema.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import { defaultTemplates } from './catalogue.ts'
import {
  JOURNAL_PAGE_SIZE,
  journalPeriodUtc,
  recipientPattern,
  type JournalFilters,
} from './journal-filtres.ts'
import {
  notificationCategories,
  notificationDeliveries,
  notificationPreferences,
  notificationTemplates,
  type NotificationCategory,
  type NotificationDelivery,
  type NotificationEvent,
} from './schema.ts'

/**
 * Lectures et écritures des écrans des notifications (R26, ADR 038) : modèles
 * du centre, journal des envois, préférences de l'espace client.
 */

/* ------------------------------------------------------------------------ */
/* Modèles                                                                  */
/* ------------------------------------------------------------------------ */

export type TemplateState = {
  event: NotificationEvent
  subject: string
  body: string
  active: boolean
  /** Le texte diffère du texte par défaut du code. */
  customized: boolean
  /** Une ligne existe en base (modèle écrit, ou seulement désactivé). */
  stored: boolean
  updatedAt: Date | null
  updatedByName: string | null
}

type StoredTemplate = {
  event: NotificationEvent
  subject: string
  body: string
  active: boolean
  updatedAt: Date
  updatedByName: string | null
}

function stateOf(event: NotificationEvent, row: StoredTemplate | undefined): TemplateState {
  const fallback = defaultTemplates[event]
  if (!row) {
    return { event, ...fallback, active: true, customized: false, stored: false, updatedAt: null, updatedByName: null }
  }
  return {
    event,
    subject: row.subject,
    body: row.body,
    active: row.active,
    customized: row.subject !== fallback.subject || row.body !== fallback.body,
    stored: true,
    updatedAt: row.updatedAt,
    updatedByName: row.updatedByName,
  }
}

async function selectTemplates(event?: NotificationEvent, database?: Database): Promise<StoredTemplate[]> {
  return withTenant(
    currentTenantId(),
    (tx) =>
      tx
        .select({
          event: notificationTemplates.event,
          subject: notificationTemplates.subject,
          body: notificationTemplates.body,
          active: notificationTemplates.active,
          updatedAt: notificationTemplates.updatedAt,
          updatedByName: sql<string | null>`coalesce(${staffMembers.fullName}, ${staffMembers.email})`,
        })
        .from(notificationTemplates)
        .leftJoin(staffMembers, eq(staffMembers.id, notificationTemplates.updatedBy))
        .where(event ? eq(notificationTemplates.event, event) : undefined),
    database,
  )
}

/** Modèle de chaque événement : celui du centre, ou le texte par défaut. */
export async function listTemplateStates(
  events: readonly NotificationEvent[],
  database?: Database,
): Promise<TemplateState[]> {
  const stored = new Map((await selectTemplates(undefined, database)).map((row) => [row.event, row]))
  return events.map((event) => stateOf(event, stored.get(event)))
}

export async function findTemplateState(event: NotificationEvent, database?: Database): Promise<TemplateState> {
  const [row] = await selectTemplates(event, database)
  return stateOf(event, row)
}

/**
 * Écrit le modèle d'un événement. Pas de suppression (ADR 038) : revenir au
 * texte par défaut, c'est réécrire la ligne avec lui.
 */
export async function saveTemplate(
  event: NotificationEvent,
  template: { subject: string; body: string; active: boolean },
  staffMemberId: string,
  database?: Database,
): Promise<void> {
  await withTenant(
    currentTenantId(),
    (tx) =>
      tx
        .insert(notificationTemplates)
        .values({ event, ...template, updatedBy: staffMemberId })
        .onConflictDoUpdate({
          target: [notificationTemplates.tenantId, notificationTemplates.event],
          set: {
            subject: sql`excluded.subject`,
            body: sql`excluded.body`,
            active: sql`excluded.active`,
            updatedBy: sql`excluded.updated_by`,
          },
        }),
    database,
  )
}

/* ------------------------------------------------------------------------ */
/* Journal des envois                                                       */
/* ------------------------------------------------------------------------ */

export type DeliveryRow = NotificationDelivery & { clientName: string | null }

export type DeliveryPage = { rows: DeliveryRow[]; total: number; pageCount: number }

/** Envois filtrés, du plus récent au plus ancien, par pages. */
export async function listDeliveries(
  filters: JournalFilters,
  timeZone: string,
  database?: Database,
): Promise<DeliveryPage> {
  const period = journalPeriodUtc(filters, timeZone)
  const conditions: (SQL | undefined)[] = [
    filters.event ? eq(notificationDeliveries.event, filters.event) : undefined,
    filters.status ? eq(notificationDeliveries.status, filters.status) : undefined,
    period.from ? gte(notificationDeliveries.sentAt, period.from) : undefined,
    period.to ? lt(notificationDeliveries.sentAt, period.to) : undefined,
    filters.recipient
      ? sql`exists (select 1 from unnest(${notificationDeliveries.recipients}) as address where address ilike ${recipientPattern(filters.recipient)})`
      : undefined,
  ]
  const where = and(...conditions)
  return withTenant(
    currentTenantId(),
    async (tx) => {
      const [{ total }] = await tx.select({ total: count() }).from(notificationDeliveries).where(where)
      const pageCount = Math.max(1, Math.ceil(total / JOURNAL_PAGE_SIZE))
      const page = Math.min(filters.page, pageCount)
      const rows = await tx
        .select({ delivery: notificationDeliveries, clientName: clients.name })
        .from(notificationDeliveries)
        .leftJoin(clients, eq(clients.id, notificationDeliveries.clientId))
        .where(where)
        .orderBy(desc(notificationDeliveries.sentAt), desc(notificationDeliveries.id))
        .limit(JOURNAL_PAGE_SIZE)
        .offset((page - 1) * JOURNAL_PAGE_SIZE)
      return {
        rows: rows.map(({ delivery, clientName }) => ({ ...delivery, clientName })),
        total,
        pageCount,
      }
    },
    database,
  )
}

/** Purge du journal au terme de la durée du centre (tâche nocturne). */
export async function purgeExpiredNotificationDeliveries(tx: Transaction): Promise<number> {
  const [row] = await tx.execute(sql`select purge_expired_notification_deliveries() as purged`)
  return Number(row?.purged ?? 0)
}

/* ------------------------------------------------------------------------ */
/* Préférences de l'espace client                                           */
/* ------------------------------------------------------------------------ */

/** Ce que reçoit chaque accès du compte connecté, catégorie par catégorie. */
export type MemberPreferences = {
  account: ClientAccount
  enabled: Record<NotificationCategory, boolean>
}

/**
 * Préférences des accès du compte connecté, sous portée client (ADR 019).
 * Sans ligne, une catégorie est reçue.
 */
export async function listMemberPreferences(
  accounts: readonly ClientAccount[],
  database?: Database,
): Promise<MemberPreferences[]> {
  if (accounts.length === 0) return []
  const rows = await inClientSpace(
    accounts,
    (tx) =>
      tx
        .select({
          memberId: notificationPreferences.clientMemberId,
          category: notificationPreferences.category,
          enabled: notificationPreferences.enabled,
        })
        .from(notificationPreferences),
    database,
  )
  return accounts.map((account) => {
    const enabled = Object.fromEntries(notificationCategories.map((category) => [category, true])) as Record<
      NotificationCategory,
      boolean
    >
    for (const row of rows) if (row.memberId === account.memberId) enabled[row.category] = row.enabled
    return { account, enabled }
  })
}

/**
 * Enregistre les préférences d'un accès du compte connecté. L'accès est pris
 * parmi ceux du compte, jamais dans la requête : une personne ne règle que les
 * siens. Écrit sous portée client — un accès d'une autre entreprise serait
 * refusé par la base. Toutes les catégories sont écrites : la page les montre
 * toutes, une case décochée est un refus.
 */
export async function saveMemberPreferences(
  accounts: readonly ClientAccount[],
  clientId: string,
  enabled: Record<NotificationCategory, boolean>,
  database?: Database,
): Promise<boolean> {
  const account = accounts.find((candidate) => candidate.clientId === clientId)
  if (!account) return false
  await inClientSpace(
    accounts,
    (tx) =>
      tx
        .insert(notificationPreferences)
        .values(
          notificationCategories.map((category) => ({
            clientId: account.clientId,
            clientMemberId: account.memberId,
            category,
            enabled: enabled[category],
          })),
        )
        .onConflictDoUpdate({
          target: [
            notificationPreferences.tenantId,
            notificationPreferences.clientMemberId,
            notificationPreferences.category,
          ],
          set: { enabled: sql`excluded.enabled` },
        }),
    database,
  )
  return true
}
