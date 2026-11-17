import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'

import { withTenant, type Database } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import { mailRequests } from '../courrier/schema.ts'
import {
  CLIENT_BELL_PANEL_LIMIT,
  buildClientBellItems,
  clientBellSettingsFromRow,
  clientBellSince,
  isClientBellEvent,
  shownClientBellEvents,
  type ClientBellItem,
  type ClientBellSettings,
  type ClientBellSource,
} from './cloche-client.ts'
import { notificationDeliveries } from './schema.ts'
import { clientBellSettings, clientNotificationReads } from './schema-cloche-client.ts'

/**
 * La cloche de l'espace client en base (ADR 077) : les messages du journal
 * adressés aux entreprises du compte, et le « lu » de la personne.
 *
 * Sous portée client (`inClientSpace`) : la base ne filtre plus les lectures,
 * chaque requête porte son filtre `tenant_id` et la liste des entreprises du
 * compte (conventions §6, décision 1).
 */

/** Réglage du centre, ou les valeurs par défaut s'il n'a rien écrit. */
export async function loadClientBellSettings(database?: Database): Promise<ClientBellSettings> {
  const tenantId = currentTenantId()
  const [row] = await withTenant(
    tenantId,
    (tx) =>
      tx
        .select({ hiddenEvents: clientBellSettings.hiddenEvents, windowDays: clientBellSettings.windowDays })
        .from(clientBellSettings)
        .where(eq(clientBellSettings.tenantId, tenantId))
        .limit(1),
    database,
  )
  return clientBellSettingsFromRow(row)
}

/** Écrit le réglage du centre : une ligne par centre, réécrite. */
export async function saveClientBellSettings(
  settings: ClientBellSettings,
  staffMemberId: string,
  database?: Database,
): Promise<void> {
  await withTenant(
    currentTenantId(),
    (tx) =>
      tx
        .insert(clientBellSettings)
        .values({ hiddenEvents: settings.hiddenEvents, windowDays: settings.windowDays, updatedBy: staffMemberId })
        .onDuplicateKeyUpdate({
          set: { hiddenEvents: settings.hiddenEvents, windowDays: settings.windowDays, updatedBy: staffMemberId },
        }),
    database,
  )
}

/** Conditions communes : messages au client, d'une entreprise du compte, d'une nature montrée, récents. */
function bellScope(accounts: readonly ClientAccount[], settings: ClientBellSettings, now: Date) {
  return and(
    eq(notificationDeliveries.tenantId, currentTenantId()),
    eq(notificationDeliveries.audience, 'client'),
    inArray(
      notificationDeliveries.clientId,
      accounts.map((account) => account.clientId),
    ),
    inArray(notificationDeliveries.event, shownClientBellEvents(settings)),
    gte(notificationDeliveries.sentAt, clientBellSince(now, settings.windowDays)),
  )
}

/** Le « lu » de la personne : ses accès, une ligne au plus par message. */
function readByMember(accounts: readonly ClientAccount[]) {
  return and(
    eq(clientNotificationReads.tenantId, notificationDeliveries.tenantId),
    eq(clientNotificationReads.deliveryId, notificationDeliveries.id),
    inArray(
      clientNotificationReads.clientMemberId,
      accounts.map((account) => account.memberId),
    ),
  )
}

/**
 * Nombre de nouveautés non lues de la personne : la pastille de la cloche au
 * premier affichage de la coque, avant toute interrogation du navigateur.
 */
export async function clientBellUnreadCount(
  accounts: readonly ClientAccount[],
  options: { now?: Date; database?: Database } = {},
): Promise<number> {
  if (accounts.length === 0) return 0
  const now = options.now ?? new Date()
  const settings = await loadClientBellSettings(options.database)
  if (shownClientBellEvents(settings).length === 0) return 0
  const [row] = await inClientSpace(
    accounts,
    (tx) =>
      tx
        .select({ count: sql<number>`count(*)` })
        .from(notificationDeliveries)
        .leftJoin(clientNotificationReads, readByMember(accounts))
        .where(and(bellScope(accounts, settings, now), isNull(clientNotificationReads.id))),
    options.database,
  )
  return Number(row?.count ?? 0)
}

/**
 * Ce que la cloche de la personne affiche : le nombre de nouveautés non lues
 * de la période, et les plus récentes, lues ou non.
 */
export async function clientBellFeed(
  accounts: readonly ClientAccount[],
  options: { timeZone: string; now?: Date; database?: Database },
): Promise<{ count: number; items: ClientBellItem[] }> {
  if (accounts.length === 0) return { count: 0, items: [] }
  const now = options.now ?? new Date()
  const settings = await loadClientBellSettings(options.database)
  if (shownClientBellEvents(settings).length === 0) return { count: 0, items: [] }
  const names = new Map(accounts.map((account) => [account.clientId, account.clientName]))

  return inClientSpace(
    accounts,
    async (tx) => {
      const [unread] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(notificationDeliveries)
        .leftJoin(clientNotificationReads, readByMember(accounts))
        .where(and(bellScope(accounts, settings, now), isNull(clientNotificationReads.id)))

      const rows = await tx
        .select({
          id: notificationDeliveries.id,
          event: notificationDeliveries.event,
          clientId: notificationDeliveries.clientId,
          subject: notificationDeliveries.subject,
          sentAt: notificationDeliveries.sentAt,
          relatedType: notificationDeliveries.relatedType,
          relatedId: notificationDeliveries.relatedId,
          readId: clientNotificationReads.id,
          mailItemId: mailRequests.mailItemId,
        })
        .from(notificationDeliveries)
        .leftJoin(clientNotificationReads, readByMember(accounts))
        // Une demande de courrier mène à la fiche de son pli.
        .leftJoin(
          mailRequests,
          and(
            eq(notificationDeliveries.relatedType, 'mail_request'),
            eq(mailRequests.tenantId, notificationDeliveries.tenantId),
            eq(mailRequests.id, notificationDeliveries.relatedId),
          ),
        )
        .where(bellScope(accounts, settings, now))
        .orderBy(desc(notificationDeliveries.sentAt), desc(notificationDeliveries.id))
        .limit(CLIENT_BELL_PANEL_LIMIT)

      const sources: ClientBellSource[] = rows.flatMap((row) =>
        isClientBellEvent(row.event) && row.clientId
          ? [
              {
                id: row.id,
                event: row.event,
                clientId: row.clientId,
                clientName: names.get(row.clientId) ?? '',
                subject: row.subject,
                sentAt: row.sentAt,
                relatedType: row.relatedType,
                relatedId: row.relatedId,
                mailItemId: row.mailItemId ?? null,
                read: row.readId !== null,
              },
            ]
          : [],
      )

      return {
        count: Number(unread?.count ?? 0),
        items: buildClientBellItems(sources, { timeZone: options.timeZone, now, showClient: accounts.length > 1 }),
      }
    },
    options.database,
  )
}

/**
 * Marque lues des nouveautés pour la personne : `ids` (ouverture d'une ligne),
 * ou toutes celles de la période (`'toutes'`). Seuls les messages de ses
 * entreprises sont retenus ; chacun est marqué au titre de l'accès de son
 * entreprise. Rejouer ne change rien. Rend le nombre de nouveautés marquées.
 */
export async function markClientBellRead(
  accounts: readonly ClientAccount[],
  ids: readonly string[] | 'toutes',
  options: { now?: Date; database?: Database } = {},
): Promise<number> {
  if (accounts.length === 0 || (ids !== 'toutes' && ids.length === 0)) return 0
  const now = options.now ?? new Date()
  const settings = await loadClientBellSettings(options.database)
  if (shownClientBellEvents(settings).length === 0) return 0
  const members = new Map(accounts.map((account) => [account.clientId, account.memberId]))

  return inClientSpace(
    accounts,
    async (tx) => {
      const targets = await tx
        .select({ id: notificationDeliveries.id, clientId: notificationDeliveries.clientId })
        .from(notificationDeliveries)
        .leftJoin(clientNotificationReads, readByMember(accounts))
        .where(
          and(
            bellScope(accounts, settings, now),
            isNull(clientNotificationReads.id),
            ids === 'toutes' ? undefined : inArray(notificationDeliveries.id, [...ids]),
          ),
        )
      const values = targets.flatMap((target) => {
        const memberId = target.clientId ? members.get(target.clientId) : undefined
        return memberId && target.clientId
          ? [{ clientId: target.clientId, clientMemberId: memberId, deliveryId: target.id }]
          : []
      })
      if (values.length === 0) return 0
      // Deux onglets qui marquent la même ligne : la seconde écriture ne change rien.
      await tx
        .insert(clientNotificationReads)
        .values(values)
        .onDuplicateKeyUpdate({ set: { readAt: sql`${clientNotificationReads.readAt}` } })
      return values.length
    },
    options.database,
  )
}
