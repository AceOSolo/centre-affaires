import { loadOpeningContext } from '../ressources/ouverture-queries.ts'
import { openingWindows, type TimeRange } from '../ressources/ouverture.ts'
import { occupiesResource } from './availability.ts'
import { listBookingsBetween } from './queries.ts'
import { addDaysToIsoDate } from '../../lib/dates.ts'
import { columnsForDays, weekDays, weekExtent } from './semaine.ts'
import { dayCells } from './selection.ts'
import type { CalendarDay } from './week-calendar.tsx'

/**
 * Semaine d'une ressource, prête à être affichée et cliquée.
 *
 * Le portail et le back-office posent exactement la même question — « quand
 * cette salle est-elle libre » — et doivent recevoir exactement la même
 * réponse. Deux chargements séparés finiraient par diverger sur un détail :
 * une réservation annulée comptée d'un côté, une fermeture oubliée de l'autre.
 *
 * Chaque ressource a son propre emploi du temps : les horaires sont résolus
 * pour elle (`rulesForResource` dans `openingWindows`), et une fermeture peut
 * ne viser qu'elle.
 */
export async function loadWeekCalendar({
  resourceId,
  anchor,
  timeZone,
  mode = 'calendar',
  excludeBookingId,
  now = new Date(),
}: {
  resourceId: string
  /** Une date de la semaine voulue, ou le premier jour en mode glissant. */
  anchor: string
  timeZone: string
  /**
   * `calendar` : du lundi au dimanche, la semaine dont on parle au téléphone.
   * `rolling` : sept jours à partir d'`anchor`, pour ne pas offrir un
   * calendrier à moitié révolu à un visiteur.
   */
  mode?: 'calendar' | 'rolling'
  /**
   * Réservation à ignorer, pour l'écran qui la déplace : sans cela elle
   * occuperait sa propre place et son créneau actuel serait inatteignable.
   */
  excludeBookingId?: string
  now?: Date
}): Promise<CalendarDay[]> {
  const jours =
    mode === 'rolling'
      ? Array.from({ length: 7 }, (_, index) => addDaysToIsoDate(anchor, index))
      : weekDays(anchor)

  const [bookings, contexte] = await Promise.all([
    listBookingsBetween(jours[0], jours[6], timeZone),
    loadOpeningContext(jours[0], jours[6]),
  ])

  const opening: Record<string, TimeRange[]> = Object.fromEntries(
    jours.map((jour) => [
      jour,
      openingWindows(jour, timeZone, {
        rules: contexte.rules,
        closures: contexte.closures,
        resourceId,
      }),
    ]),
  )

  // Seules les réservations de cette ressource occupent la grille, et les
  // annulées libèrent leur créneau : c'est le prédicat de la contrainte
  // d'exclusion, reproduit à l'identique (décision 3).
  const busy = bookings
    .filter(
      (booking) =>
        booking.resourceId === resourceId &&
        booking.id !== excludeBookingId &&
        occupiesResource(booking.status),
    )
    .map((booking) => ({ startsAt: booking.startsAt, endsAt: booking.endsAt }))

  // Une amplitude murale commune aux sept jours : sans elle les colonnes ne
  // seraient pas comparables d'une ligne à l'autre.
  const extent = weekExtent(Object.values(opening).flat(), timeZone)

  return columnsForDays(jours, timeZone, extent, opening).map((column) => ({
    isoDate: column.isoDate,
    weekday: column.weekday,
    closed: column.closed,
    cells: dayCells(column.window, opening[column.isoDate] ?? [], busy, now),
  }))
}
