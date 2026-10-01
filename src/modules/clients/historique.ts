import { and, asc, desc, eq, gt, lte, sql } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { formatTime, toIsoDate } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { bookings, isOpenEndedBooking, type Booking } from '../reservations/schema.ts'
import { resources } from '../ressources/schema.ts'

/**
 * Historique d'un client sur sa fiche (R07) : ses réservations, à venir et
 * passées.
 *
 * Seules les réservations (`kind = 'booking'`) en font partie. Les occupations
 * de contrat (ADR 018) portent aussi le client, mais la fiche montre déjà ses
 * contrats : les répéter ici en ferait deux fois la même ligne, et une
 * occupation sans terme serait « à venir » pour toujours.
 */
export type ClientBookingRow = Pick<
  Booking,
  'id' | 'title' | 'status' | 'startsAt' | 'endsAt' | 'seriesId' | 'cancellationReason'
> & {
  resourceName: string
  resourceCode: string
}

export type ClientBookingHistory = {
  /** En cours ou à venir, la plus proche d'abord. */
  upcoming: ClientBookingRow[]
  upcomingTotal: number
  /** Terminées, la plus récente d'abord. */
  past: ClientBookingRow[]
  pastTotal: number
}

/**
 * Réservations d'un client, annulées comprises : la fiche dit aussi ce qui a
 * été libéré, avec son état écrit en toutes lettres.
 *
 * Une réservation commencée mais pas finie est « à venir » : elle compte
 * encore. Le partage se fait sur la fin, en `[)` comme la contrainte
 * d'exclusion — une réservation qui finit à l'instant `now` est passée.
 *
 * Les listes sont bornées, les totaux ne le sont pas : la fiche dit « les 20
 * plus récentes sur 134 » plutôt que de laisser croire que tout est là.
 */
export async function listClientBookingHistory(
  clientId: string,
  options: { now?: Date; upcomingLimit?: number; pastLimit?: number } = {},
): Promise<ClientBookingHistory> {
  const { now = new Date(), upcomingLimit = 50, pastLimit = 20 } = options
  const ofClient = and(eq(bookings.clientId, clientId), eq(bookings.kind, 'booking'))

  return withTenant(currentTenantId(), async (tx) => {
    const columns = {
      id: bookings.id,
      title: bookings.title,
      status: bookings.status,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      seriesId: bookings.seriesId,
      cancellationReason: bookings.cancellationReason,
      resourceName: resources.name,
      resourceCode: resources.code,
    }

    // `gt` et `lte` passent l'instant par la colonne, qui sait le convertir ;
    // une `Date` glissée telle quelle dans `sql` n'atteindrait pas la base.
    const [totals] = await tx
      .select({
        upcoming: sql<number>`count(*) filter (where ${gt(bookings.endsAt, now)})::int`,
        past: sql<number>`count(*) filter (where ${lte(bookings.endsAt, now)})::int`,
      })
      .from(bookings)
      .where(ofClient)

    const upcoming = await tx
      .select(columns)
      .from(bookings)
      .innerJoin(resources, eq(resources.id, bookings.resourceId))
      .where(and(ofClient, gt(bookings.endsAt, now)))
      .orderBy(asc(bookings.startsAt), asc(bookings.id))
      .limit(upcomingLimit)

    const past = await tx
      .select(columns)
      .from(bookings)
      .innerJoin(resources, eq(resources.id, bookings.resourceId))
      .where(and(ofClient, lte(bookings.endsAt, now)))
      .orderBy(desc(bookings.startsAt), desc(bookings.id))
      .limit(pastLimit)

    return {
      upcoming,
      upcomingTotal: totals?.upcoming ?? 0,
      past,
      pastTotal: totals?.past ?? 0,
    }
  })
}

/* ------------------------------------------------------------------------ */
/* Affichage                                                                */
/* ------------------------------------------------------------------------ */

/**
 * « 1 oct. 2026 » pour une date de calendrier — celle d'un contrat, qui n'est
 * pas un instant (voir `contracts.starts_on`). Lue à midi UTC : aucun fuseau
 * ne la fait changer de jour.
 */
export function formatIsoDay(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day, 12)))
}

/** « lun. 12 oct. 2026 », jour du centre où commence la réservation. */
export function formatBookingDay(startsAt: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(startsAt)
}

/**
 * Horaire d'une réservation dans le fuseau du centre (décision 4).
 *
 * - Sur une journée : « 09:00 – 10:30 ». Une fin à minuit appartient encore
 *   à la journée commencée : « 08:00 – 24:00 ».
 * - Sur plusieurs : « 09:00 → 14 oct. 18:00 ».
 * - Sans terme : « depuis 09:00, sans terme ».
 */
export function formatBookingHours(
  booking: { startsAt: Date; endsAt: Date },
  timeZone: string,
): string {
  const start = formatTime(booking.startsAt, timeZone)
  if (isOpenEndedBooking(booking)) return `depuis ${start}, sans terme`

  const end = formatTime(booking.endsAt, timeZone)
  // La dernière milliseconde occupée, pour qu'une fin à minuit reste du jour.
  const lastInstant = new Date(booking.endsAt.getTime() - 1)
  if (toIsoDate(lastInstant, timeZone) === toIsoDate(booking.startsAt, timeZone)) {
    return `${start} – ${end === '00:00' ? '24:00' : end}`
  }
  const endDay = new Intl.DateTimeFormat('fr-FR', {
    timeZone,
    day: 'numeric',
    month: 'short',
  }).format(booking.endsAt)
  return `${start} → ${endDay} ${end}`
}
