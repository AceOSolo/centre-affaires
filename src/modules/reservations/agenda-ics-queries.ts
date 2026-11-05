import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm'

import { maintenant } from '../../db/columns.ts'
import { withTenant } from '../../db/index.ts'
import { deleteReturning } from '../../db/returning.ts'
import { tenants } from '../../db/tenants.ts'
import { currentTenantId, runForTenant } from '../../lib/tenant.ts'
import { resources } from '../ressources/schema.ts'
import { FEED_PAST_DAYS, feedIdFromToken, feedToken, feedUrl, icsCalendar, isFeedToken } from './agenda-ics.ts'
import { bookings, calendarFeeds } from './schema.ts'

/*
 * Liens d'agenda des ressources (ADR 071) : un par ressource, créé, régénéré
 * ou désactivé depuis l'espace des agendas, lu sans session par les
 * applications d'agenda.
 */

/**
 * Les deux réglages du serveur dont le lien a besoin, déjà exigés par la
 * connexion de l'équipe : la clé qui signe les liens et l'adresse du site.
 */
function feedSettings(): { authSecret: string; appUrl: string } | undefined {
  const { AUTH_SECRET: authSecret, APP_URL: appUrl } = process.env
  return authSecret && appUrl ? { authSecret, appUrl } : undefined
}

/** Les ressources du centre et, pour chacune, son lien d'agenda s'il en a un. */
export async function listResourceFeeds() {
  const settings = feedSettings()
  const tenantId = currentTenantId()
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({
        id: resources.id,
        name: resources.name,
        code: resources.code,
        resourceType: resources.resourceType,
        feedId: calendarFeeds.id,
        createdAt: calendarFeeds.createdAt,
        lastFetchedAt: calendarFeeds.lastFetchedAt,
      })
      .from(resources)
      .leftJoin(
        calendarFeeds,
        and(eq(calendarFeeds.tenantId, resources.tenantId), eq(calendarFeeds.resourceId, resources.id)),
      )
      .where(and(eq(resources.tenantId, tenantId), isNull(resources.deletedAt)))
      .orderBy(asc(resources.name)),
  )
  return rows.map(({ feedId, ...row }) => ({
    ...row,
    url: feedId && settings ? feedUrl(settings.appUrl, feedToken(feedId, tenantId, settings.authSecret)) : undefined,
  }))
}

export type ResourceFeed = Awaited<ReturnType<typeof listResourceFeeds>>[number]

/** Le serveur peut-il signer des liens ? Sinon l'écran le dit. */
export function feedsAvailable(): boolean {
  return feedSettings() !== undefined
}

/** Les ressources du centre, encore actives, parmi celles demandées. */
async function activeResourceIds(resourceIds: string[]): Promise<string[]> {
  if (!resourceIds.length) return []
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ id: resources.id })
      .from(resources)
      .where(
        and(eq(resources.tenantId, currentTenantId()), inArray(resources.id, resourceIds), isNull(resources.deletedAt)),
      ),
  )
  return rows.map((row) => row.id)
}

/** Crée le lien des ressources qui n'en ont pas. Rend le nombre de liens créés. */
export async function createFeeds(resourceIds: string[], staffMemberId: string): Promise<number> {
  const ids = await activeResourceIds(resourceIds)
  if (!ids.length) return 0
  return withTenant(currentTenantId(), async (tx) => {
    const existing = await tx
      .select({ resourceId: calendarFeeds.resourceId })
      .from(calendarFeeds)
      .where(and(eq(calendarFeeds.tenantId, currentTenantId()), inArray(calendarFeeds.resourceId, ids)))
    const linked = new Set(existing.map((row) => row.resourceId))
    const missing = ids.filter((id) => !linked.has(id))
    if (missing.length) {
      await tx.insert(calendarFeeds).values(missing.map((resourceId) => ({ resourceId, createdBy: staffMemberId })))
    }
    return missing.length
  })
}

/**
 * Remplace le lien d'une ressource : l'ancien cesse aussitôt de marcher, les
 * agendas abonnés doivent ajouter le nouveau. Sans lien, n'en crée pas.
 */
export async function regenerateFeed(resourceId: string, staffMemberId: string): Promise<boolean> {
  return withTenant(currentTenantId(), async (tx) => {
    const removed = await deleteReturning(
      tx,
      calendarFeeds,
      and(eq(calendarFeeds.tenantId, currentTenantId()), eq(calendarFeeds.resourceId, resourceId))!,
    )
    if (!removed.length) return false
    await tx.insert(calendarFeeds).values({ resourceId, createdBy: staffMemberId })
    return true
  })
}

/** Désactive le lien des ressources : il cesse aussitôt de marcher. Rend le nombre retiré. */
export async function removeFeeds(resourceIds: string[]): Promise<number> {
  if (!resourceIds.length) return 0
  const removed = await withTenant(currentTenantId(), (tx) =>
    deleteReturning(
      tx,
      calendarFeeds,
      and(eq(calendarFeeds.tenantId, currentTenantId()), inArray(calendarFeeds.resourceId, resourceIds))!,
    ),
  )
  return removed.length
}

/** Au-delà, l'agenda serait trop lourd pour être relu ; un an de réservations tient en deçà. */
const MAX_EVENTS = 5000

/**
 * L'agenda que sert un lien, ou `undefined` si le lien n'existe pas (mal
 * formé, régénéré, désactivé, ressource retirée). Note la lecture : l'écran
 * montre ainsi que l'abonnement marche.
 */
export async function calendarForToken(token: string): Promise<string | undefined> {
  const settings = feedSettings()
  const feedId = feedIdFromToken(token)
  if (!settings || !feedId) return undefined

  // La seule lecture sans filtre de centre, voulue : c'est le lien qui désigne
  // le centre. Le jeton signé avec lui est vérifié juste après.
  const [feed] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ id: calendarFeeds.id, tenantId: calendarFeeds.tenantId, resourceId: calendarFeeds.resourceId })
      .from(calendarFeeds)
      .where(eq(calendarFeeds.id, feedId))
      .limit(1),
  )
  if (!feed || !isFeedToken(token, feed, settings.authSecret)) return undefined

  return runForTenant(feed.tenantId, () =>
    withTenant(feed.tenantId, async (tx) => {
      const [row] = await tx
        .select({ resource: resources, tenant: tenants })
        .from(resources)
        .innerJoin(tenants, eq(tenants.id, resources.tenantId))
        .where(
          and(eq(resources.tenantId, feed.tenantId), eq(resources.id, feed.resourceId), isNull(resources.deletedAt)),
        )
        .limit(1)
      if (!row) return undefined

      const since = new Date(Date.now() - FEED_PAST_DAYS * 24 * 60 * 60 * 1000)
      const listed = await tx
        .select()
        .from(bookings)
        .where(
          and(
            eq(bookings.tenantId, feed.tenantId),
            eq(bookings.resourceId, feed.resourceId),
            eq(bookings.kind, 'booking'),
            eq(bookings.status, 'confirmed'),
            gt(bookings.endsAt, since),
          ),
        )
        .orderBy(asc(bookings.startsAt))
        .limit(MAX_EVENTS)

      await tx.update(calendarFeeds).set({ lastFetchedAt: maintenant() }).where(eq(calendarFeeds.id, feed.id))
      return icsCalendar(listed, row.resource, {
        tenantName: row.tenant.name,
        timeZone: row.tenant.timezone,
        appUrl: settings.appUrl,
      })
    }),
  )
}
