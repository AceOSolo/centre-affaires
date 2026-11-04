import {
  addDaysToIsoDate,
  dayRangeUtc,
  formatLongDate,
  formatMinutes,
  formatTime,
  toIsoDate,
  toWallClock,
  wallClockToUtc,
} from '../../lib/dates.ts'
import { closuresForResource, isClosedOn, openingWindows, type ClosurePeriod, type OpeningRule } from '../ressources/ouverture.ts'
import type { TimeRange } from './availability.ts'
import { formatDays } from './durees.ts'
import { availableEnds, fitsFreeRange } from './public-selection.ts'
import { MIN_REQUEST_MINUTES } from './requests.ts'
import { freeRanges } from './slots.ts'

/**
 * Demandes sur plusieurs jours (ADR 061) : ce qu'une période continue, d'un
 * jour et d'une heure à un autre jour et une autre heure, demande au moteur de
 * disponibilité. Le même module sert la page publique, l'espace client et
 * leurs actions serveur, qui revérifient avec des données fraîches ; le
 * trigger anti-chevauchement reste le garde final (décision 3).
 *
 * La règle, qui ne vaut que pour les demandes en ligne (l'équipe réserve
 * librement au back-office, ADR 010) :
 *
 * - **le jour même**, rien ne change : le créneau tient dans une seule plage
 *   libre, sans enjamber une pause ni une réservation ;
 * - **sur plusieurs jours**, la période est une seule réservation, tenue jour
 *   et nuit : personne d'autre ne peut prendre la ressource entre le début et
 *   la fin. Le début et la fin tombent dans les heures d'ouverture de la
 *   ressource (on la prend et on la rend quand le centre est ouvert) ; les
 *   nuits, les pauses et les jours habituellement fermés qu'elle enjambe lui
 *   appartiennent ; une **fermeture exceptionnelle** comprise dans la période
 *   la rend indisponible en ligne, comme une réservation.
 *
 * Tout est en instants, les jours sont ceux du centre (décision 4) : une
 * période qui traverse le changement d'heure garde ses heures murales.
 * Module pur, éprouvé seul (`periode.test.ts`).
 */

const QUARTER_HOUR = 15 * 60_000

/** Dernier jour du centre occupé : la fin est exclue, une fin à minuit reste sur la veille. */
export function lastDayOf(range: TimeRange, timeZone: string): string {
  return toIsoDate(new Date(range.endsAt.getTime() - 1), timeZone)
}

/** Vrai quand la période déborde de son premier jour. */
export function spansSeveralDays(range: TimeRange, timeZone: string): boolean {
  return lastDayOf(range, timeZone) !== toIsoDate(range.startsAt, timeZone)
}

/**
 * Jours du centre touchés par la période, fin exclue : 9 h – 18 h le même
 * jour, 1 ; du lundi 9 h au mercredi 18 h, 3 ; du lundi 9 h au mardi 9 h, 2.
 * C'est ce que compte la durée maximale d'une demande (`durees.ts`).
 */
export function periodDayCount(range: TimeRange, timeZone: string): number {
  const first = Date.parse(`${toIsoDate(range.startsAt, timeZone)}T00:00:00Z`)
  const last = Date.parse(`${lastDayOf(range, timeZone)}T00:00:00Z`)
  return Math.round((last - first) / 86_400_000) + 1
}

/**
 * Saisie du back-office : un jour et une heure de début, un jour et une heure
 * de fin, sans contrôle d'ouverture — l'équipe réserve aussi hors des heures
 * (ADR 010). `undefined` tant que la saisie est incomplète ou que la fin ne
 * suit pas le début.
 */
export function adminSelection(
  date: string,
  startTime: string,
  endDate: string,
  endTime: string,
  timeZone: string,
): TimeRange | undefined {
  if (!date || !startTime || !endDate || !endTime) return undefined
  try {
    const startsAt = wallClockToUtc(`${date}T${startTime}`, timeZone)
    const endsAt = wallClockToUtc(`${endDate}T${endTime}`, timeZone)
    return endsAt > startsAt ? { startsAt, endsAt } : undefined
  } catch {
    return undefined
  }
}

/** Un jour de la période et ses plages d'ouverture, en instants. */
export type PeriodDay = { date: string; windows: TimeRange[] }

/**
 * Ce qu'il faut pour choisir une période sur une ressource, à partir d'un
 * jour : les plages d'ouverture de chaque jour, et les plages **libres en
 * continu** sur toute l'étendue — nuits comprises, réservations et fermetures
 * exceptionnelles retirées. Rien de ce qui occupe la ressource n'y figure.
 */
export type PeriodAvailability = { days: PeriodDay[]; free: TimeRange[] }

export function periodAvailability(input: {
  firstDate: string
  dayCount: number
  timeZone: string
  resourceId: string
  rules: readonly OpeningRule[]
  closures: readonly ClosurePeriod[]
  /** Ce qui occupe la ressource : réservations non annulées, demandes en attente comprises. */
  busy: readonly TimeRange[]
}): PeriodAvailability {
  const { timeZone, resourceId } = input
  const dates = Array.from({ length: Math.max(1, input.dayCount) }, (_, index) =>
    addDaysToIsoDate(input.firstDate, index),
  )
  const own = closuresForResource(input.closures, resourceId)
  const days = dates.map((date) => ({
    date,
    windows: openingWindows(date, timeZone, { rules: input.rules, closures: input.closures, resourceId }),
  }))
  // Une fermeture exceptionnelle occupe toute sa journée : une période qui la
  // contient ne se demande pas en ligne.
  const closed = dates.filter((date) => isClosedOn(own, date)).map((date) => dayRangeUtc(date, timeZone))
  const span = {
    startsAt: dayRangeUtc(dates[0], timeZone).startsAt,
    endsAt: dayRangeUtc(dates[dates.length - 1], timeZone).endsAt,
  }
  return { days, free: freeRanges(span, [...input.busy, ...closed]) }
}

/** La même, en instants ISO : ce qu'une page serveur passe à un formulaire client. */
export type SerializedPeriodAvailability = {
  days: { date: string; windows: { startsAt: string; endsAt: string }[] }[]
  free: { startsAt: string; endsAt: string }[]
}

const isoRange = (range: TimeRange) => ({ startsAt: range.startsAt.toISOString(), endsAt: range.endsAt.toISOString() })
const dateRange = (range: { startsAt: string; endsAt: string }) => ({
  startsAt: new Date(range.startsAt),
  endsAt: new Date(range.endsAt),
})

export function serializePeriod(availability: PeriodAvailability): SerializedPeriodAvailability {
  return {
    days: availability.days.map((day) => ({ date: day.date, windows: day.windows.map(isoRange) })),
    free: availability.free.map(isoRange),
  }
}

export function revivePeriod(serialized: SerializedPeriodAvailability): PeriodAvailability {
  return {
    days: serialized.days.map((day) => ({ date: day.date, windows: day.windows.map(dateRange) })),
    free: serialized.free.map(dateRange),
  }
}

function windowsOf(availability: PeriodAvailability, date: string): TimeRange[] {
  return availability.days.find((day) => day.date === date)?.windows ?? []
}

/**
 * Plages libres d'un jour, à l'intérieur de ses heures d'ouverture : ce que
 * `dayAvailability` (`disponibilites.ts`) rend pour ce jour-là.
 */
export function dayFreeRanges(availability: PeriodAvailability, date: string): TimeRange[] {
  return windowsOf(availability, date).flatMap((window) =>
    availability.free.flatMap((range) => {
      const startsAt = Math.max(window.startsAt.getTime(), range.startsAt.getTime())
      const endsAt = Math.min(window.endsAt.getTime(), range.endsAt.getTime())
      return endsAt > startsAt ? [{ startsAt: new Date(startsAt), endsAt: new Date(endsAt) }] : []
    }),
  )
}

function startsInWindow(start: Date, windows: readonly TimeRange[]): boolean {
  return windows.some((window) => start >= window.startsAt && start < window.endsAt)
}

/** Une fin à l'heure d'ouverture compte : le camion pris lundi 9 h se rend mardi 9 h. */
function endsInWindow(end: Date, windows: readonly TimeRange[]): boolean {
  return windows.some((window) => end >= window.startsAt && end <= window.endsAt)
}

export type PeriodRejection =
  | 'duree-trop-courte'
  | 'duree-trop-longue'
  | 'debut-hors-ouverture'
  | 'fin-hors-ouverture'
  | 'creneau-indisponible'

/**
 * Première raison de refuser la période, ou `undefined`. `availability` part
 * du jour du début ; `maxDays` est la durée maximale du produit, en jours
 * touchés. Le préavis et l'horizon du centre se vérifient à part, sur le
 * début (`requestTimingRejection`).
 */
export function periodRejection(
  range: TimeRange,
  availability: PeriodAvailability,
  timeZone: string,
  maxDays: number,
): PeriodRejection | undefined {
  if (range.endsAt.getTime() - range.startsAt.getTime() < MIN_REQUEST_MINUTES * 60_000) return 'duree-trop-courte'
  if (periodDayCount(range, timeZone) > maxDays) return 'duree-trop-longue'
  const startDay = toIsoDate(range.startsAt, timeZone)
  if (!spansSeveralDays(range, timeZone)) {
    return fitsFreeRange(range, dayFreeRanges(availability, startDay)) ? undefined : 'creneau-indisponible'
  }
  if (!startsInWindow(range.startsAt, windowsOf(availability, startDay))) return 'debut-hors-ouverture'
  if (!availability.days.some((day) => day.date === lastDayOf(range, timeZone))) return 'creneau-indisponible'
  // Toutes les plages : celle d'un jour qui ferme à 24:00 finit le lendemain.
  if (!endsInWindow(range.endsAt, availability.days.flatMap((day) => day.windows))) return 'fin-hors-ouverture'
  return fitsFreeRange(range, availability.free) ? undefined : 'creneau-indisponible'
}

/** Ce que dit l'écran pour chaque refus. */
export function periodRejectionMessage(rejection: PeriodRejection, maxDays: number): string {
  switch (rejection) {
    case 'duree-trop-courte':
      return `La durée minimale est de ${MIN_REQUEST_MINUTES} minutes.`
    case 'duree-trop-longue':
      return maxDays === 1
        ? 'En ligne, une demande tient sur une seule journée. Pour plusieurs jours, contactez le centre.'
        : `En ligne, une demande couvre ${formatDays(maxDays)} d’affilée au plus. Au-delà, contactez le centre.`
    case 'debut-hors-ouverture':
      return 'Le début doit tomber pendant les heures d’ouverture.'
    case 'fin-hors-ouverture':
      return 'La fin doit tomber pendant les heures d’ouverture : la ressource se rend quand le centre est ouvert.'
    case 'creneau-indisponible':
      return 'Ce créneau n’est plus disponible. Choisissez de nouveaux horaires.'
  }
}

/**
 * Fins proposées pour ce départ, le jour `endDate`.
 *
 * - Le jour même : jusqu'à la fin de la plage libre, comme avant.
 * - Un autre jour : chaque quart d'heure des plages d'ouverture de ce jour,
 *   tant que la ressource reste libre depuis le départ et que la période ne
 *   dépasse pas `maxDays` jours.
 *
 * Une fin à minuit pile n'est pas proposée : elle se lirait « 00:00 » du jour
 * suivant.
 */
export function periodEnds(
  start: Date,
  endDate: string,
  availability: PeriodAvailability,
  timeZone: string,
  maxDays: number,
): Date[] {
  const startDay = toIsoDate(start, timeZone)
  if (endDate === startDay) return availableEnds(start, dayFreeRanges(availability, startDay), timeZone)
  if (endDate < startDay || !startsInWindow(start, windowsOf(availability, startDay))) return []
  const run = availability.free.find((range) => start >= range.startsAt && start < range.endsAt)
  if (!run) return []
  const ends: Date[] = []
  for (const window of windowsOf(availability, endDate)) {
    const first = Math.ceil(window.startsAt.getTime() / QUARTER_HOUR) * QUARTER_HOUR
    const last = Math.min(window.endsAt.getTime(), run.endsAt.getTime())
    for (let at = first; at <= last; at += QUARTER_HOUR) {
      const end = new Date(at)
      if (toIsoDate(end, timeZone) !== endDate) continue
      if (at - start.getTime() < MIN_REQUEST_MINUTES * 60_000) continue
      if (periodDayCount({ startsAt: start, endsAt: end }, timeZone) > maxDays) continue
      ends.push(end)
    }
  }
  return ends
}

/** Jours où ce départ peut finir : le jour même d'abord, puis les suivants qui proposent une fin. */
export function periodEndDates(
  start: Date,
  availability: PeriodAvailability,
  timeZone: string,
  maxDays: number,
): string[] {
  const startDay = toIsoDate(start, timeZone)
  return availability.days
    .map((day) => day.date)
    .filter((date) => date >= startDay && periodEnds(start, date, availability, timeZone, maxDays).length > 0)
}

/**
 * La période en toutes lettres : « le mardi 3 novembre 2026, de 09:00 à
 * 13:00 », ou « du mardi 3 novembre 2026 à 09:00 au jeudi 5 novembre 2026 à
 * 18:00 ».
 */
export function periodLabel(range: TimeRange, timeZone: string): string {
  const startDay = toIsoDate(range.startsAt, timeZone)
  const start = formatTime(range.startsAt, timeZone)
  const end = formatTime(range.endsAt, timeZone)
  if (!spansSeveralDays(range, timeZone)) return `le ${formatLongDate(startDay, timeZone)}, de ${start} à ${end}`
  return `du ${formatLongDate(startDay, timeZone)} à ${start} au ${formatLongDate(toIsoDate(range.endsAt, timeZone), timeZone)} à ${end}`
}

/**
 * Durée lisible, en heure murale du centre : « 9 h », « 1 h 30 », et au-delà
 * de 24 heures « 1 jour », « 2 jours 9 h ». Du samedi 10 h au lundi 10 h :
 * « 2 jours », même si la nuit du changement d'heure compte 23 ou 25 heures.
 */
export function periodDuration(range: TimeRange, timeZone: string): string {
  const minutes =
    (Date.parse(`${toWallClock(range.endsAt, timeZone)}:00Z`) - Date.parse(`${toWallClock(range.startsAt, timeZone)}:00Z`)) /
    60_000
  if (minutes < 24 * 60) return formatMinutes(Math.round((range.endsAt.getTime() - range.startsAt.getTime()) / 60_000))
  const days = Math.floor(minutes / (24 * 60))
  const rest = minutes - days * 24 * 60
  return `${formatDays(days)}${rest > 0 ? ` ${formatMinutes(rest)}` : ''}`
}
