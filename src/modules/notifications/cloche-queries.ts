import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'

import { tenantContext } from '../../db/contexte.ts'
import { withTenant, type Database, type Transaction } from '../../db/index.ts'
import type { Permission } from '../../lib/auth/permissions.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clients } from '../clients/schema.ts'
import { proposals } from '../facturation/schema-devis.ts'
import { bookings } from '../reservations/schema.ts'
import {
  STAFF_NOTIFICATION_DAYS,
  STAFF_NOTIFICATION_PANEL_LIMIT,
  boundedSummary,
  kindsVisibleTo,
  staffNotificationHref,
  staffNotificationKindLabels,
  staffNotificationWhen,
  type StaffNotificationFeed,
} from './cloche.ts'
import { centreTimeZone } from './faits.ts'
import { staffNotificationReads, staffNotifications, type StaffNotificationKind } from './schema-equipe.ts'

/**
 * La cloche de l'équipe en base (ADR 059) : poser une notification, lire
 * celles d'un membre, les marquer lues, purger les anciennes.
 *
 * Toute lecture filtre par centre (`tenant_id`), comme le veut `CLAUDE.md`
 * (décision 1) : la base ne filtre plus les lectures (ADR 042).
 */

export type StaffNotificationOptions = {
  /** Base des tests ; sans elle, celle de l'application. */
  database?: Database
  tenantId?: string
}

/** Ce qu'un déclencheur pose dans la cloche. */
export type StaffSignal = {
  kind: StaffNotificationKind
  clientId?: string | null
  relatedId: string
  /** Morceaux du résumé, sans donnée personnelle ; joints par « · ». */
  summary: readonly (string | null | undefined)[]
}

/**
 * Pose la notification d'un événement. Une seule par événement : rejouée,
 * elle ne fait rien de plus (`staff_notifications_event_key`).
 *
 * Ne lève jamais, comme le courriel qu'elle accompagne : une cloche qui ne
 * sonne pas ne défait pas la demande du client, déjà enregistrée.
 */
export async function signalStaff(signal: StaffSignal, options: StaffNotificationOptions = {}): Promise<boolean> {
  try {
    await withTenant(
      options.tenantId ?? currentTenantId(),
      (tx) =>
        tx
          .insert(staffNotifications)
          .values({
            kind: signal.kind,
            clientId: signal.clientId ?? null,
            relatedId: signal.relatedId,
            summary: boundedSummary(signal.summary) || staffNotificationKindLabels[signal.kind],
          })
          .onDuplicateKeyUpdate({ set: { id: sql`id` } }),
      options.database,
    )
    return true
  } catch (error) {
    console.error(`Notification de l’équipe non posée (${signal.kind})`, error)
    return false
  }
}

/** Le membre connecté : son identifiant et les droits de son rôle (`permissionsOf`). */
export type StaffReader = { id: string; allowed: readonly Permission[] }

const since = (now: Date) => new Date(now.getTime() - STAFF_NOTIFICATION_DAYS * 86_400_000)

/** Conditions communes : ce centre, ces natures, les derniers jours. */
function visible(tenantId: string, kinds: readonly StaffNotificationKind[], now: Date) {
  return and(
    eq(staffNotifications.tenantId, tenantId),
    inArray(staffNotifications.kind, [...kinds]),
    gte(staffNotifications.createdAt, since(now)),
  )
}

/** Jointure du « lu » du membre : sans ligne, non lue. */
function readBy(memberId: string) {
  return and(
    eq(staffNotificationReads.tenantId, staffNotifications.tenantId),
    eq(staffNotificationReads.notificationId, staffNotifications.id),
    eq(staffNotificationReads.staffMemberId, memberId),
  )
}

async function unreadCount(tx: Transaction, tenantId: string, reader: StaffReader, now: Date): Promise<number> {
  const kinds = kindsVisibleTo(reader.allowed)
  if (kinds.length === 0) return 0
  const [row] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(staffNotifications)
    .leftJoin(staffNotificationReads, readBy(reader.id))
    .where(and(visible(tenantId, kinds, now), isNull(staffNotificationReads.id)))
  return Number(row?.n ?? 0)
}

/** Nombre de non lues du membre : la pastille rendue avec la page. */
export async function countUnreadStaffNotifications(
  reader: StaffReader,
  options: StaffNotificationOptions & { now?: Date } = {},
): Promise<number> {
  const tenantId = options.tenantId ?? currentTenantId()
  return withTenant(tenantId, (tx) => unreadCount(tx, tenantId, reader, options.now ?? new Date()), options.database)
}

/**
 * Ce que la cloche du membre affiche : le nombre de non lues et les dernières
 * notifications, lues ou non, des natures que ses droits lui ouvrent.
 *
 * « Qui » se lit à la source : la fiche du client, sinon le demandeur de la
 * page publique sur sa réservation ou son devis — une fois anonymisés, ils
 * ne paraissent plus ici non plus.
 */
export async function staffNotificationFeed(
  reader: StaffReader,
  options: StaffNotificationOptions & { now?: Date } = {},
): Promise<StaffNotificationFeed> {
  const tenantId = options.tenantId ?? currentTenantId()
  const now = options.now ?? new Date()
  const kinds = kindsVisibleTo(reader.allowed)
  if (kinds.length === 0) return { unread: 0, items: [] }

  return withTenant(
    tenantId,
    async (tx) => {
      const [unread, rows, timeZone] = await Promise.all([
        unreadCount(tx, tenantId, reader, now),
        tx
          .select({
            id: staffNotifications.id,
            kind: staffNotifications.kind,
            relatedId: staffNotifications.relatedId,
            summary: staffNotifications.summary,
            createdAt: staffNotifications.createdAt,
            readId: staffNotificationReads.id,
            clientName: clients.name,
            bookingRequester: bookings.requesterName,
            proposalCompany: proposals.requesterCompany,
            proposalRequester: proposals.requesterName,
          })
          .from(staffNotifications)
          .leftJoin(staffNotificationReads, readBy(reader.id))
          .leftJoin(
            clients,
            and(eq(clients.tenantId, staffNotifications.tenantId), eq(clients.id, staffNotifications.clientId)),
          )
          .leftJoin(
            bookings,
            and(
              eq(bookings.tenantId, staffNotifications.tenantId),
              eq(bookings.id, staffNotifications.relatedId),
              inArray(staffNotifications.kind, ['booking_request', 'quote_request']),
            ),
          )
          .leftJoin(
            proposals,
            and(
              eq(proposals.tenantId, staffNotifications.tenantId),
              eq(proposals.id, staffNotifications.relatedId),
              eq(staffNotifications.kind, 'domiciliation_request'),
            ),
          )
          .where(visible(tenantId, kinds, now))
          .orderBy(desc(staffNotifications.createdAt), desc(staffNotifications.id))
          .limit(STAFF_NOTIFICATION_PANEL_LIMIT),
        centreTimeZone(tx, tenantId),
      ])
      return {
        unread,
        items: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          label: staffNotificationKindLabels[row.kind],
          summary: row.summary,
          who:
            [row.clientName, row.bookingRequester, row.proposalCompany, row.proposalRequester]
              .map((value) => value?.trim())
              .find(Boolean) ?? 'Visiteur du site',
          createdAt: row.createdAt.toISOString(),
          when: staffNotificationWhen(row.createdAt, timeZone, now),
          href: staffNotificationHref(row.kind, row.relatedId),
          read: row.readId !== null,
        })),
      }
    },
    options.database,
  )
}

/** Marque lues ces notifications pour ce membre ; une déjà lue reste telle. */
async function markRead(tx: Transaction, reader: StaffReader, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await tx
    .insert(staffNotificationReads)
    .values(ids.map((notificationId) => ({ notificationId, staffMemberId: reader.id })))
    .onDuplicateKeyUpdate({ set: { id: sql`${staffNotificationReads.id}` } })
}

/**
 * Marque lue une notification pour ce membre, pour lui seul. Une notification
 * qu'il ne voit pas — autre centre, nature hors de ses droits, trop ancienne —
 * est ignorée. Rend le nombre de non lues qui restent.
 */
export async function markStaffNotificationRead(
  reader: StaffReader,
  notificationId: string,
  options: StaffNotificationOptions & { now?: Date } = {},
): Promise<number> {
  const tenantId = options.tenantId ?? currentTenantId()
  const now = options.now ?? new Date()
  const kinds = kindsVisibleTo(reader.allowed)
  return withTenant(
    tenantId,
    async (tx) => {
      if (kinds.length > 0) {
        const [found] = await tx
          .select({ id: staffNotifications.id })
          .from(staffNotifications)
          .where(and(visible(tenantId, kinds, now), eq(staffNotifications.id, notificationId)))
        if (found) await markRead(tx, reader, [found.id])
      }
      return unreadCount(tx, tenantId, reader, now)
    },
    options.database,
  )
}

/** Marque lues toutes les notifications que ce membre voit. Rend 0, le nombre de non lues. */
export async function markAllStaffNotificationsRead(
  reader: StaffReader,
  options: StaffNotificationOptions & { now?: Date } = {},
): Promise<number> {
  const tenantId = options.tenantId ?? currentTenantId()
  const now = options.now ?? new Date()
  const kinds = kindsVisibleTo(reader.allowed)
  return withTenant(
    tenantId,
    async (tx) => {
      if (kinds.length === 0) return 0
      const unread = await tx
        .select({ id: staffNotifications.id })
        .from(staffNotifications)
        .leftJoin(staffNotificationReads, readBy(reader.id))
        .where(and(visible(tenantId, kinds, now), isNull(staffNotificationReads.id)))
      await markRead(
        tx,
        reader,
        unread.map((row) => row.id),
      )
      return unreadCount(tx, tenantId, reader, now)
    },
    options.database,
  )
}

/**
 * Purge des notifications de l'équipe au terme du journal des messages
 * (`tenants.notification_log_retention_months`, tâche de nuit) : elles en
 * sont le pendant pour l'équipe. Leurs « lu » partent avec elles (clé
 * étrangère en cascade). Rend le nombre de notifications purgées.
 */
export async function purgeExpiredStaffNotifications(tx: Transaction): Promise<number> {
  // Le centre de la transaction en cours, celui de `withTenant()`.
  const tenantId = tenantContext.getStore() ?? currentTenantId()
  const [result] = (await tx.execute(sql`
    delete n from staff_notifications as n
      join tenants as t on t.id = n.tenant_id
     where t.id = ${tenantId}
       and n.created_at < timestampadd(month, -t.notification_log_retention_months, current_timestamp(3))`)) as unknown as [
    { affectedRows?: number },
  ]
  return Number(result?.affectedRows ?? 0)
}
