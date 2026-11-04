import { toIsoDate, toWallClock, wallClockToUtc } from '../../lib/dates.ts'
import type { TimeRange } from './availability.ts'
import { MIN_REQUEST_MINUTES } from './requests.ts'

const QUARTER_HOUR = 15 * 60_000

/**
 * Période saisie en heure murale du centre : un jour et une heure de début,
 * un jour et une heure de fin (ADR 061). Refuse les dates normalisées par
 * Date (31 février, 25:00, l'heure sautée au printemps) et une fin qui ne suit
 * pas le début.
 */
export function periodSelection(
  startDate: string,
  startTime: string,
  endDate: string,
  endTime: string,
  timeZone: string,
): TimeRange | undefined {
  try {
    const startsAt = wallClockToUtc(`${startDate}T${startTime}`, timeZone)
    const endsAt = wallClockToUtc(`${endDate}T${endTime}`, timeZone)
    if (toWallClock(startsAt, timeZone) !== `${startDate}T${startTime}`) return undefined
    if (toWallClock(endsAt, timeZone) !== `${endDate}T${endTime}`) return undefined
    if (endsAt <= startsAt) return undefined
    return { startsAt, endsAt }
  } catch {
    return undefined
  }
}

/** Un créneau dans une seule journée : le cas le plus courant de `periodSelection`. */
export function publicSelection(
  date: string,
  start: string,
  end: string,
  timeZone: string,
): TimeRange | undefined {
  return periodSelection(date, start, date, end, timeZone)
}

/** Une pause ou une réservation entre deux plages ne peut pas être enjambée. */
export function fitsFreeRange(selection: TimeRange, free: readonly TimeRange[]): boolean {
  return selection.endsAt > selection.startsAt && free.some(
    (range) => selection.startsAt >= range.startsAt && selection.endsAt <= range.endsAt,
  )
}

/** Départs au quart d'heure laissant au moins trente minutes disponibles. */
export function availableStarts(free: readonly TimeRange[], now: Date, latestStart?: Date): Date[] {
  return free.flatMap((range) => {
    const starts: Date[] = []
    const first = Math.ceil(Math.max(range.startsAt.getTime(), now.getTime() + 1) / QUARTER_HOUR) * QUARTER_HOUR
    for (let at = first; at + MIN_REQUEST_MINUTES * 60_000 <= range.endsAt.getTime() && (!latestStart || at <= latestStart.getTime()); at += QUARTER_HOUR) {
      starts.push(new Date(at))
    }
    return starts
  })
}

/**
 * Fins possibles pour ce départ, le même jour, sans traverser une fermeture :
 * jusqu'à la fin de la plage libre, ou `maxMinutes` après le départ. Sur
 * plusieurs jours, `periodEnds` (`periode.ts`) propose les fins.
 */
export function availableEnds(
  start: Date,
  free: readonly TimeRange[],
  timeZone: string,
  maxMinutes: number = 24 * 60,
): Date[] {
  const window = free.find((range) => start >= range.startsAt && start < range.endsAt)
  if (!window) return []
  const ends: Date[] = []
  const last = Math.min(window.endsAt.getTime(), start.getTime() + maxMinutes * 60_000)
  for (let at = start.getTime() + MIN_REQUEST_MINUTES * 60_000; at <= last; at += QUARTER_HOUR) {
    const end = new Date(at)
    if (toIsoDate(end, timeZone) === toIsoDate(start, timeZone)) ends.push(end)
  }
  return ends
}
