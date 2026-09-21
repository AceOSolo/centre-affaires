import { toIsoDate, toWallClock, wallClockToUtc } from '../../lib/dates.ts'
import type { TimeRange } from './availability.ts'
import { MAX_REQUEST_MINUTES, MIN_REQUEST_MINUTES } from './requests.ts'

const QUARTER_HOUR = 15 * 60_000

/** Refuse les dates normalisées par Date (31 février, 25:00, etc.). */
export function publicSelection(
  date: string,
  start: string,
  end: string,
  timeZone: string,
): TimeRange | undefined {
  try {
    const startsAt = wallClockToUtc(`${date}T${start}`, timeZone)
    const endsAt = wallClockToUtc(`${date}T${end}`, timeZone)
    if (toWallClock(startsAt, timeZone) !== `${date}T${start}`) return undefined
    if (toWallClock(endsAt, timeZone) !== `${date}T${end}`) return undefined
    if (endsAt <= startsAt) return undefined
    return { startsAt, endsAt }
  } catch {
    return undefined
  }
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

/** Fins possibles pour ce départ, sans traverser une fermeture ni changer de jour. */
export function availableEnds(start: Date, free: readonly TimeRange[], timeZone: string): Date[] {
  const window = free.find((range) => start >= range.startsAt && start < range.endsAt)
  if (!window) return []
  const ends: Date[] = []
  const last = Math.min(window.endsAt.getTime(), start.getTime() + MAX_REQUEST_MINUTES * 60_000)
  for (let at = start.getTime() + MIN_REQUEST_MINUTES * 60_000; at <= last; at += QUARTER_HOUR) {
    const end = new Date(at)
    if (toIsoDate(end, timeZone) === toIsoDate(start, timeZone)) ends.push(end)
  }
  return ends
}
