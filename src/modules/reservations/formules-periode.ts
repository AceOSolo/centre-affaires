import { addDaysToIsoDate, toIsoDate, wallClockToUtc, toWallClock } from '../../lib/dates.ts'
import { rentalFormulaUnits, type RentalFormula } from '../ressources/formules.ts'
import type { QuotableUnit } from '../facturation/devis.ts'
import type { TimeRange } from './availability.ts'
import { formatDays } from './durees.ts'
import {
  periodDayCount,
  periodRejection,
  periodRejectionMessage,
  type PeriodAvailability,
  type PeriodRejection,
} from './periode.ts'
import { fitsFreeRange, periodSelection } from './public-selection.ts'

/**
 * Ce qu'une demande de réservation en ligne choisit (ADR 076) : une formule
 * de location, puis les jours et les heures qu'elle permet. Le même calcul
 * sert la page publique, l'espace client, la modification d'une réservation
 * par son client et leurs actions serveur, qui le refont avec des données
 * fraîches ; le trigger anti-chevauchement reste le garde final (décision 3).
 *
 * - **libre** (ressource sans formule réglée) : le formulaire de l'ADR 061 —
 *   une heure d'arrivée, un jour et une heure de départ ;
 * - **à l'heure** : une arrivée et un départ le même jour ;
 * - **à la demi-journée** : une arrivée, le départ une demi-journée plus tard
 *   (`tenants.half_day_minutes`) ;
 * - **à la journée** : un jour d'arrivée et un jour de départ, librement
 *   choisi, de l'ouverture du premier à la fermeture du dernier ;
 * - **à la semaine**, **au mois** : un jour d'arrivée et un nombre de
 *   semaines ou de mois ; le départ est à la fermeture du dernier jour ouvert
 *   de la période. Un jour de fermeture exceptionnelle pendant la période ne
 *   l'interrompt pas : le bureau reste loué.
 *
 * Tout est en instants, les jours sont ceux du centre (décision 4). Module
 * pur, éprouvé seul (`formules-periode.test.ts`).
 */

/** La formule choisie ; `libre` pour une ressource qui n'en a pas de réglée. */
export type ChosenFormula = RentalFormula | 'libre'

export type PeriodChoice = {
  formula: ChosenFormula
  /** Heure d'arrivée `HH:MM` : libre, à l'heure, à la demi-journée. */
  startTime: string
  /** Jour du départ : libre, à la journée. */
  endDate: string
  /** Heure du départ `HH:MM` : libre, à l'heure. */
  endTime: string
  /** Semaines ou mois : à la semaine, au mois. */
  count: number
}

/** Ce que le centre règle pour les formules (ADR 076). */
export type FormulaLimits = {
  /** Semaines d'affilée au plus, pour une demande en ligne à la semaine. */
  maxWeeks: number
  /** Mois d'affilée au plus, pour une demande en ligne au mois. */
  maxMonths: number
  /** Durée d'une demi-journée vendue (`tenants.half_day_minutes`). */
  halfDayMinutes: number
}

/** Valeurs par défaut des colonnes du centre (ADR 076), *à confirmer en recette*. */
export const DEFAULT_FORMULA_LIMITS: FormulaLimits = { maxWeeks: 4, maxMonths: 12, halfDayMinutes: 240 }

/** Plafonds lus sur la ligne du centre (`tenants`). */
export function formulaLimitsOf(tenant: {
  bookingMaxWeeks: number
  bookingMaxMonths: number
  halfDayMinutes: number
}): FormulaLimits {
  return { maxWeeks: tenant.bookingMaxWeeks, maxMonths: tenant.bookingMaxMonths, halfDayMinutes: tenant.halfDayMinutes }
}

/** Lit un choix envoyé par un formulaire (`choiceFormValues`). */
export function readChoice(
  source: { get(name: string): unknown },
  formula: ChosenFormula,
  date: string,
): PeriodChoice {
  const text = (name: string) => String(source.get(name) ?? '').trim()
  const count = Number(text('count') || '1')
  return {
    formula,
    startTime: text('startTime'),
    endDate: text('endDate') || date,
    endTime: text('endTime'),
    count: Number.isFinite(count) ? count : 0,
  }
}

export type ChoiceContext = {
  /** Jour de l'arrivée, jour du centre. */
  date: string
  timeZone: string
  /** La ressource à partir de `date`, sur toute l'étendue que la formule peut couvrir. */
  availability: PeriodAvailability
  /** Premier instant permis pour une arrivée : maintenant et le préavis du centre. */
  earliest: Date
  /** Durée maximale d'une demande en ligne pour le produit, en jours touchés (ADR 061). */
  maxDays: number
  limits: FormulaLimits
}

const QUARTER_HOUR = 15 * 60_000

/** Unité de prix de la formule ; `undefined` pour le formulaire libre : le moins cher (ADR 023). */
export function choiceUnit(formula: ChosenFormula): QuotableUnit | undefined {
  return formula === 'libre' ? undefined : rentalFormulaUnits[formula]
}

/** Lit une formule envoyée par un formulaire : une de celles réglées, ou `libre` s'il n'y en a pas. */
export function parseChosenFormula(raw: unknown, offered: readonly RentalFormula[]): ChosenFormula | undefined {
  const value = String(raw ?? '').trim()
  if (offered.length === 0) return value === '' || value === 'libre' ? 'libre' : undefined
  return offered.find((formula) => formula === value)
}

/** Choix vide d'une formule : rien n'est encore saisi, le départ est le jour même. */
export function emptyChoice(formula: ChosenFormula, date: string): PeriodChoice {
  return { formula, startTime: '', endDate: date, endTime: '', count: 1 }
}

/**
 * Jour ISO décalé de `months` mois, le quantième ramené au dernier jour du mois
 * s'il n'existe pas : un mois à partir du 31 janvier va jusqu'au 27 février
 * inclus (départ avant le 28).
 */
export function addMonthsToIsoDate(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  const index = year * 12 + (month - 1) + months
  const targetYear = Math.floor(index / 12)
  const targetMonth = index - targetYear * 12
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay))).toISOString().slice(0, 10)
}

/** Dernier jour d'une location de `count` semaines ou mois à partir de `date`, inclus. */
export function lastDayOfLongFormula(formula: 'semaine' | 'mois', date: string, count: number): string {
  return formula === 'semaine'
    ? addDaysToIsoDate(date, 7 * count - 1)
    : addDaysToIsoDate(addMonthsToIsoDate(date, count), -1)
}

/**
 * Jours à charger pour proposer toutes les formules d'une ressource, à partir
 * de `date` : la durée maximale du produit pour les formules d'un jour ou de
 * quelques jours, et la plus longue des locations à la semaine ou au mois.
 */
export function choiceSpanDays(
  formulas: readonly RentalFormula[],
  date: string,
  maxDays: number,
  limits: Pick<FormulaLimits, 'maxWeeks' | 'maxMonths'>,
): number {
  let span = formulas.length === 0 || formulas.includes('journee') ? maxDays : 1
  if (formulas.includes('semaine')) span = Math.max(span, 7 * limits.maxWeeks)
  if (formulas.includes('mois')) {
    const last = lastDayOfLongFormula('mois', date, limits.maxMonths)
    span = Math.max(span, Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000) + 1)
  }
  return Math.max(1, span)
}

function windowsOf(availability: PeriodAvailability, date: string): TimeRange[] {
  return availability.days.find((day) => day.date === date)?.windows ?? []
}

/**
 * Arrivée d'une location à la journée, à la semaine ou au mois : l'ouverture
 * du jour, ou le premier quart d'heure permis si la journée a commencé (ou
 * que le préavis du centre la coupe). `undefined` : plus rien ce jour-là.
 */
export function dayArrival(availability: PeriodAvailability, date: string, earliest: Date): Date | undefined {
  const first = Math.ceil((earliest.getTime() + 1) / QUARTER_HOUR) * QUARTER_HOUR
  for (const window of windowsOf(availability, date)) {
    const start = Math.max(window.startsAt.getTime(), first)
    if (start < window.endsAt.getTime()) return new Date(start)
  }
  return undefined
}

/** Départ d'un jour : la fermeture du centre ce jour-là ; `undefined` s'il est fermé. */
export function dayDeparture(availability: PeriodAvailability, date: string): Date | undefined {
  const windows = windowsOf(availability, date)
  return windows.length > 0 ? windows[windows.length - 1].endsAt : undefined
}

/** Dernier jour ouvert entre `first` et `last`, en remontant depuis `last`. */
function lastOpenDay(availability: PeriodAvailability, first: string, last: string): string | undefined {
  for (let day = last; day >= first; day = addDaysToIsoDate(day, -1)) {
    if (windowsOf(availability, day).length > 0) return day
  }
  return undefined
}

/** Raisons de refuser un choix, en plus de celles d'une période (ADR 061). */
export type ChoiceRejection =
  | PeriodRejection
  | 'creneau-illisible'
  | 'formule-indisponible'
  | 'jour-ferme'
  | 'depart-ferme'
  | 'duree-hors-formule'

export type EvaluatedChoice = { range: TimeRange; rejection?: ChoiceRejection } | { range?: undefined; rejection: ChoiceRejection }

function wallClock(date: string, time: string, timeZone: string): Date | undefined {
  if (!/^\d{2}:\d{2}$/.test(time)) return undefined
  try {
    const instant = wallClockToUtc(`${date}T${time}`, timeZone)
    // Refuse une heure qui n'existe pas (25:00, l'heure sautée au printemps).
    return toWallClock(instant, timeZone) === `${date}T${time}` ? instant : undefined
  } catch {
    return undefined
  }
}

/**
 * La période d'un choix et, s'il y a lieu, la première raison de la refuser.
 * `offered` : les formules réglées sur la ressource (vide : le formulaire
 * libre). Le préavis et l'horizon du centre se vérifient à part, sur le
 * début (`requestTimingRejection`).
 */
export function evaluateChoice(
  choice: PeriodChoice,
  context: ChoiceContext,
  offered: readonly RentalFormula[],
): EvaluatedChoice {
  const { date, timeZone, availability, maxDays, limits } = context
  const offeredHere = offered.length === 0 ? choice.formula === 'libre' : choice.formula !== 'libre' && offered.includes(choice.formula)
  if (!offeredHere) return { rejection: 'formule-indisponible' }

  switch (choice.formula) {
    case 'libre':
    case 'heure': {
      const endDate = choice.formula === 'heure' ? date : choice.endDate || date
      const range = periodSelection(date, choice.startTime, endDate, choice.endTime, timeZone)
      if (!range) return { rejection: 'creneau-illisible' }
      const rejection = periodRejection(range, availability, timeZone, choice.formula === 'heure' ? 1 : maxDays)
      return { range, rejection }
    }
    case 'demi_journee': {
      const startsAt = wallClock(date, choice.startTime, timeZone)
      if (!startsAt) return { rejection: 'creneau-illisible' }
      const range = { startsAt, endsAt: new Date(startsAt.getTime() + limits.halfDayMinutes * 60_000) }
      return { range, rejection: periodRejection(range, availability, timeZone, 1) }
    }
    case 'journee': {
      const startsAt = dayArrival(availability, date, context.earliest)
      if (!startsAt) return { rejection: 'jour-ferme' }
      const endDate = choice.endDate || date
      if (endDate < date) return { rejection: 'creneau-illisible' }
      const endsAt = dayDeparture(availability, endDate)
      if (!endsAt) {
        // Un jour hors de l'étendue chargée est au-delà de la durée maximale.
        return { rejection: availability.days.some((day) => day.date === endDate) ? 'depart-ferme' : 'duree-trop-longue' }
      }
      const range = { startsAt, endsAt }
      if (periodDayCount(range, timeZone) > maxDays) return { range, rejection: 'duree-trop-longue' }
      return { range, rejection: fitsFreeRange(range, availability.free) ? undefined : 'creneau-indisponible' }
    }
    case 'semaine':
    case 'mois': {
      const max = choice.formula === 'semaine' ? limits.maxWeeks : limits.maxMonths
      if (!Number.isInteger(choice.count) || choice.count < 1 || choice.count > max) {
        return { rejection: 'duree-hors-formule' }
      }
      const startsAt = dayArrival(availability, date, context.earliest)
      if (!startsAt) return { rejection: 'jour-ferme' }
      const last = lastDayOfLongFormula(choice.formula, date, choice.count)
      if (!availability.days.some((day) => day.date === last)) return { rejection: 'duree-hors-formule' }
      const departureDay = lastOpenDay(availability, date, last)
      const endsAt = departureDay ? dayDeparture(availability, departureDay) : undefined
      if (!endsAt || endsAt <= startsAt) return { rejection: 'depart-ferme' }
      const range = { startsAt, endsAt }
      // Les fermetures exceptionnelles ne coupent pas une location longue :
      // seules les réservations comptent.
      return { range, rejection: fitsFreeRange(range, availability.unbooked) ? undefined : 'creneau-indisponible' }
    }
  }
}

/** Ce que l'écran dit pour chaque refus. */
export function choiceRejectionMessage(rejection: ChoiceRejection, maxDays: number, limits: FormulaLimits): string {
  switch (rejection) {
    case 'creneau-illisible':
      return 'Choisissez le jour et les heures de votre réservation.'
    case 'formule-indisponible':
      return 'Cette formule n’est pas proposée pour cet espace. Choisissez-en une autre.'
    case 'jour-ferme':
      return 'Le centre est fermé ce jour-là, ou la journée est passée : choisissez un autre jour d’arrivée.'
    case 'depart-ferme':
      return 'Le centre est fermé le jour du départ : choisissez un autre jour.'
    case 'duree-hors-formule':
      return `En ligne, une location dure de 1 à ${limits.maxWeeks} semaine${limits.maxWeeks > 1 ? 's' : ''} à la semaine, de 1 à ${limits.maxMonths} mois au mois. Au-delà, contactez le centre.`
    default:
      return periodRejectionMessage(rejection, maxDays)
  }
}

/**
 * Pourquoi un jour de départ choisi librement ne propose aucune heure, dans
 * le formulaire libre (ADR 076) : le jour est avant l'arrivée, au-delà de la
 * durée maximale, fermé, ou la ressource est prise avant.
 */
export type EndDayIssue =
  | { kind: 'avant-arrivee' }
  | { kind: 'trop-loin' }
  | { kind: 'ferme' }
  | { kind: 'occupe'; freeUntil?: Date }

export function endDayIssue(
  start: Date,
  endDate: string,
  availability: PeriodAvailability,
  timeZone: string,
  maxDays: number,
): EndDayIssue {
  const startDay = toIsoDate(start, timeZone)
  if (endDate < startDay) return { kind: 'avant-arrivee' }
  const dayCount = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`)) / 86_400_000) + 1
  if (dayCount > maxDays || !availability.days.some((day) => day.date === endDate)) return { kind: 'trop-loin' }
  if (windowsOf(availability, endDate).length === 0) return { kind: 'ferme' }
  const run = availability.free.find((range) => start >= range.startsAt && start < range.endsAt)
  return { kind: 'occupe', freeUntil: run?.endsAt }
}

export function endDayIssueMessage(issue: EndDayIssue, maxDays: number, describeInstant: (instant: Date) => string): string {
  switch (issue.kind) {
    case 'avant-arrivee':
      return 'Le départ ne peut pas précéder l’arrivée.'
    case 'trop-loin':
      return `En ligne, une demande couvre ${formatDays(maxDays)} d’affilée au plus. Au-delà, contactez le centre.`
    case 'ferme':
      return 'Le centre est fermé ce jour-là : choisissez un autre jour de départ.'
    case 'occupe':
      return issue.freeUntil
        ? `L’espace est déjà réservé ensuite : il est libre jusqu’au ${describeInstant(issue.freeUntil)}. Choisissez un départ plus tôt.`
        : 'L’espace n’est pas libre jusqu’à ce jour-là. Choisissez un départ plus tôt.'
  }
}

/**
 * Heures d'ouverture des jours d'une période, jours consécutifs aux mêmes
 * horaires regroupés : ce que l'écran montre à la place des « nuits
 * comprises » (ADR 076). `hours` vide : fermé.
 */
export type OpeningGroup = { from: string; to: string; hours: TimeRange[] }

export function openingGroups(
  availability: PeriodAvailability,
  fromDate: string,
  toDate: string,
  formatRange: (range: TimeRange) => string,
): OpeningGroup[] {
  const groups: (OpeningGroup & { key: string })[] = []
  for (const day of availability.days) {
    if (day.date < fromDate || day.date > toDate) continue
    const key = day.windows.map(formatRange).join(',')
    const previous = groups[groups.length - 1]
    if (previous && previous.key === key && addDaysToIsoDate(previous.to, 1) === day.date) {
      previous.to = day.date
    } else {
      groups.push({ from: day.date, to: day.date, hours: day.windows, key })
    }
  }
  return groups.map(({ from, to, hours }) => ({ from, to, hours }))
}
