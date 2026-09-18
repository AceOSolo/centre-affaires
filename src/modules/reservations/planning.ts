import { dayRangeUtc, toWallClock, wallClockToUtc } from '../../lib/dates.ts'
import type { TimeRange } from './availability.ts'

/**
 * Géométrie du planning du jour.
 *
 * Tout est calculé sur des instants, jamais sur des durées supposées : une
 * journée fait 23 ou 25 heures deux fois par an (décision 4). Positionner les
 * réservations en divisant par « 24 heures » ferait glisser tout le planning
 * d'une heure ces jours-là.
 */

/** Fenêtre affichée, bornes `[)` comme les réservations. */
export type PlanningWindow = { startsAt: Date; endsAt: Date }

/** Heures d'ouverture par défaut du centre, en heure murale. */
export const DEFAULT_OPENING = { openHour: 7, closeHour: 20 }

const HOUR_MS = 3_600_000

const pad = (hour: number) => String(hour).padStart(2, '0')

/** Début de l'heure murale qui contient l'instant, sans jamais le dépasser. */
function floorToHour(instant: Date, timeZone: string): Date {
  const floored = wallClockToUtc(`${toWallClock(instant, timeZone).slice(0, 13)}:00`, timeZone)
  // Sur l'heure en double du retour à l'heure d'hiver, la conversion retient la
  // seconde occurrence, qui peut tomber après l'instant. La borne le corrige.
  return new Date(Math.min(floored.getTime(), instant.getTime()))
}

/** Fin de l'heure murale qui contient l'instant, sans jamais rester en deçà. */
function ceilToHour(instant: Date, timeZone: string): Date {
  const floored = floorToHour(instant, timeZone)
  if (floored.getTime() === instant.getTime()) return floored
  return new Date(floored.getTime() + HOUR_MS)
}

const clamp = (instant: Date, min: Date, max: Date) =>
  new Date(Math.min(Math.max(instant.getTime(), min.getTime()), max.getTime()))

/**
 * Fenêtre horaire du planning : les heures d'ouverture, élargies à l'heure
 * pleine pour contenir toute réservation qui en déborde.
 *
 * Une réservation posée hors ouverture — une salle prêtée un dimanche soir —
 * doit rester visible. L'élargissement ne franchit jamais les bornes de la
 * journée du centre : ce qui déborde sur le lendemain s'affiche le lendemain.
 */
export function planningWindow(
  isoDate: string,
  timeZone: string,
  bookings: readonly TimeRange[] = [],
  opening = DEFAULT_OPENING,
): PlanningWindow {
  const day = dayRangeUtc(isoDate, timeZone)
  let startsAt = clamp(
    wallClockToUtc(`${isoDate}T${pad(opening.openHour)}:00`, timeZone),
    day.startsAt,
    day.endsAt,
  )
  let endsAt = clamp(
    opening.closeHour >= 24
      ? day.endsAt
      : wallClockToUtc(`${isoDate}T${pad(opening.closeHour)}:00`, timeZone),
    startsAt,
    day.endsAt,
  )

  for (const booking of bookings) {
    if (booking.startsAt < startsAt) {
      startsAt = clamp(floorToHour(booking.startsAt, timeZone), day.startsAt, endsAt)
    }
    if (booking.endsAt > endsAt) {
      endsAt = clamp(ceilToHour(booking.endsAt, timeZone), startsAt, day.endsAt)
    }
  }

  return { startsAt, endsAt }
}

/** Position d'une réservation dans la fenêtre, en pourcentage de sa hauteur. */
export type BlockGeometry = { topPercent: number; heightPercent: number }

/**
 * Rogne la réservation sur la fenêtre. Renvoie `undefined` quand il ne reste
 * rien à dessiner — une réservation entièrement hors de la plage affichée.
 */
export function blockGeometry(
  range: TimeRange,
  window: PlanningWindow,
): BlockGeometry | undefined {
  const total = window.endsAt.getTime() - window.startsAt.getTime()
  if (total <= 0) return undefined

  const start = Math.max(range.startsAt.getTime(), window.startsAt.getTime())
  const end = Math.min(range.endsAt.getTime(), window.endsAt.getTime())
  if (end <= start) return undefined

  return {
    topPercent: ((start - window.startsAt.getTime()) / total) * 100,
    heightPercent: ((end - start) / total) * 100,
  }
}

/** Graduation horaire de la fenêtre, bornes comprises. */
export type HourTick = { instant: Date; offsetPercent: number }

/**
 * Une graduation par heure écoulée, et non par heure murale : le jour du retour
 * à l'heure d'hiver, 02h00 apparaît deux fois, ce qui est exactement ce que
 * vit le centre.
 */
export function hourTicks(window: PlanningWindow): HourTick[] {
  const total = window.endsAt.getTime() - window.startsAt.getTime()
  if (total <= 0) return []

  const ticks: HourTick[] = []
  for (let elapsed = 0; elapsed <= total; elapsed += HOUR_MS) {
    ticks.push({
      instant: new Date(window.startsAt.getTime() + elapsed),
      offsetPercent: (elapsed / total) * 100,
    })
  }
  return ticks
}

/** Hauteur du planning : assez de place pour lire une réservation d'une heure. */
export function planningHeightPx(window: PlanningWindow, pixelsPerHour = 56): number {
  const hours = (window.endsAt.getTime() - window.startsAt.getTime()) / HOUR_MS
  return Math.max(1, Math.round(hours * pixelsPerHour))
}
