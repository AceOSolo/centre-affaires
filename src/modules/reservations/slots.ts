import type { TimeRange } from './availability.ts'

/**
 * Créneaux libres d'une ressource.
 *
 * Le back-office affiche ce qui est pris ; une page publique doit afficher
 * l'inverse — ce qui reste. Les deux lectures doivent s'accorder exactement,
 * d'où les mêmes bornes `[)` qu'`availability.ts` et que la contrainte
 * d'exclusion : un créneau qui finit à 10h00 laisse 10h00 libre.
 *
 * Tout est calculé sur des instants. Aucune de ces fonctions ne connaît de
 * fuseau : elles reçoivent une fenêtre déjà convertie en UTC.
 */

/** Rogne un intervalle sur la fenêtre, ou `undefined` s'il n'en reste rien. */
function clip(range: TimeRange, window: TimeRange): TimeRange | undefined {
  const startsAt = new Date(Math.max(range.startsAt.getTime(), window.startsAt.getTime()))
  const endsAt = new Date(Math.min(range.endsAt.getTime(), window.endsAt.getTime()))
  return endsAt.getTime() > startsAt.getTime() ? { startsAt, endsAt } : undefined
}

/**
 * Fusionne les intervalles qui se chevauchent ou se touchent.
 *
 * Deux réservations jointives — 9h-10h et 10h-11h — ne se chevauchent pas au
 * sens de la contrainte, mais elles ne laissent aucun créneau libre entre
 * elles. Les fusionner évite de proposer un trou de durée nulle.
 */
function merge(ranges: readonly TimeRange[]): TimeRange[] {
  const sorted = [...ranges].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  const merged: TimeRange[] = []

  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.startsAt.getTime() <= last.endsAt.getTime()) {
      if (range.endsAt.getTime() > last.endsAt.getTime()) last.endsAt = range.endsAt
      continue
    }
    merged.push({ startsAt: range.startsAt, endsAt: range.endsAt })
  }

  return merged
}

/**
 * Ce qui reste libre dans la fenêtre une fois les réservations retirées.
 *
 * `busy` ne doit contenir que des réservations qui occupent réellement la
 * ressource — les annulées libèrent leur créneau (voir `occupiesResource`).
 */
export function freeRanges(window: TimeRange, busy: readonly TimeRange[]): TimeRange[] {
  if (window.endsAt.getTime() <= window.startsAt.getTime()) return []

  const occupied = merge(
    busy.map((range) => clip(range, window)).filter((range): range is TimeRange => Boolean(range)),
  )

  const free: TimeRange[] = []
  let cursor = window.startsAt

  for (const range of occupied) {
    if (range.startsAt.getTime() > cursor.getTime()) {
      free.push({ startsAt: cursor, endsAt: range.startsAt })
    }
    if (range.endsAt.getTime() > cursor.getTime()) cursor = range.endsAt
  }

  if (cursor.getTime() < window.endsAt.getTime()) {
    free.push({ startsAt: cursor, endsAt: window.endsAt })
  }

  return free
}

/**
 * Découpe un intervalle libre en créneaux réguliers proposables.
 *
 * Les créneaux sont alignés sur le début de l'intervalle, pas sur l'heure
 * ronde : un trou de 9h30 à 11h00 propose 9h30 et 10h00, jamais 9h00. Le
 * dernier créneau incomplet est écarté — on ne propose pas une demi-heure
 * quand la durée demandée est d'une heure.
 */
export function slotsWithin(range: TimeRange, minutes: number): TimeRange[] {
  if (minutes <= 0) return []

  const step = minutes * 60_000
  const slots: TimeRange[] = []

  for (
    let start = range.startsAt.getTime();
    start + step <= range.endsAt.getTime();
    start += step
  ) {
    slots.push({ startsAt: new Date(start), endsAt: new Date(start + step) })
  }

  return slots
}

/** Durée cumulée réellement libre, en minutes — l'argument « il reste 3 h ». */
export function freeMinutes(ranges: readonly TimeRange[]): number {
  return Math.round(
    ranges.reduce((total, range) => total + (range.endsAt.getTime() - range.startsAt.getTime()), 0) /
      60_000,
  )
}
