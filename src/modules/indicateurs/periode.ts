import { addDaysToIsoDate, addMonthsToIsoMonth, isCalendarDate } from '../../lib/dates.ts'

/**
 * Période d'observation des indicateurs (R31) : deux jours civils du centre,
 * bornes comprises, lus dans l'URL (`?du=2026-09-01&au=2026-09-30`).
 *
 * Formulaire en GET : la période reste dans l'adresse, l'écran se partage et
 * se rafraîchit sans rien perdre. Module pur, sans base ni fuseau : « aujourd'hui »
 * est fourni par l'appelant, déjà dans le fuseau du centre.
 */

/** Plus longue période acceptée, en jours : une année, bissextile comprise. */
export const MAX_PERIOD_DAYS = 366

/** Nombre de mois de la courbe d'évolution, mois de fin de période compris. */
export const EVOLUTION_MONTHS = 12

export type Period = { from: string; to: string }

export type PeriodField = 'du' | 'au'

export const periodFieldLabels: Record<PeriodField, string> = {
  du: 'Du',
  au: 'Au',
}

export type ParsedPeriod = {
  /** Période retenue : celle demandée, ou la période par défaut si elle est invalide. */
  period: Period
  /** Ce qui a été saisi, pour le réafficher tel quel dans le formulaire. */
  input: { du: string; au: string }
  errors: Partial<Record<PeriodField, string>>
}

/** Vrai pour une date ISO qui existe : « 2026-02-30 » est refusé. */
export const isIsoDate = isCalendarDate

/** Premier et dernier jour d'un mois ISO. */
export function monthPeriod(isoMonth: string): Period {
  return {
    from: `${isoMonth}-01`,
    to: addDaysToIsoDate(`${addMonthsToIsoMonth(isoMonth, 1)}-01`, -1),
  }
}

/** Jours de la période, bornes comprises. */
export function periodDays(period: Period): string[] {
  const days: string[] = []
  for (let day = period.from; day <= period.to; day = addDaysToIsoDate(day, 1)) days.push(day)
  return days
}

/** Nombre de jours de la période, bornes comprises. */
export function periodLength(period: Period): number {
  const [fy, fm, fd] = period.from.split('-').map(Number)
  const [ty, tm, td] = period.to.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1
}

/** Mois ISO couverts par la période, dans l'ordre. */
export function periodMonths(period: Period): string[] {
  const months: string[] = []
  const last = period.to.slice(0, 7)
  for (let month = period.from.slice(0, 7); month <= last; month = addMonthsToIsoMonth(month, 1)) {
    months.push(month)
  }
  return months
}

/** Vrai si le jour tombe dans la période, bornes comprises. */
export function inPeriod(isoDate: string, period: Period): boolean {
  return period.from <= isoDate && isoDate <= period.to
}

/**
 * Les `EVOLUTION_MONTHS` mois qui finissent avec le mois de fin de la période :
 * la courbe montre d'où l'on vient, quelle que soit la longueur de la période.
 */
export function evolutionMonths(period: Period, count = EVOLUTION_MONTHS): string[] {
  const last = period.to.slice(0, 7)
  return Array.from({ length: count }, (_, index) => addMonthsToIsoMonth(last, index - count + 1))
}

/** Plus petite période qui contient les deux. */
export function unionPeriod(a: Period, b: Period): Period {
  return { from: a.from < b.from ? a.from : b.from, to: a.to > b.to ? a.to : b.to }
}

const single = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value)?.trim() ?? ''

/**
 * Lit la période demandée.
 *
 * Sans paramètre : le mois en cours, du 1er au dernier jour — les réservations
 * et les contrats déjà posés pour la fin du mois comptent dans le taux. Une
 * saisie invalide n'est pas devinée : l'écran dit ce qui ne va pas, champ par
 * champ, et montre le mois en cours en attendant.
 */
export function parsePeriod(
  params: { du?: string | string[]; au?: string | string[] },
  today: string,
): ParsedPeriod {
  const fallback = monthPeriod(today.slice(0, 7))
  const du = single(params.du)
  const au = single(params.au)
  if (!du && !au) return { period: fallback, input: { du: fallback.from, au: fallback.to }, errors: {} }

  const errors: Partial<Record<PeriodField, string>> = {}
  if (!du) errors.du = 'indiquez le premier jour de la période.'
  else if (!isIsoDate(du)) errors.du = 'date invalide, au format jj/mm/aaaa.'
  if (!au) errors.au = 'indiquez le dernier jour de la période.'
  else if (!isIsoDate(au)) errors.au = 'date invalide, au format jj/mm/aaaa.'

  if (!errors.du && !errors.au) {
    if (au < du) errors.au = 'le dernier jour doit suivre le premier, ou être le même.'
    else if (periodLength({ from: du, to: au }) > MAX_PERIOD_DAYS) {
      errors.au = `la période ne peut pas dépasser ${MAX_PERIOD_DAYS} jours.`
    }
  }

  if (Object.keys(errors).length > 0) return { period: fallback, input: { du, au }, errors }
  return { period: { from: du, to: au }, input: { du, au }, errors }
}

export type PeriodPreset = { label: string; period: Period }

/**
 * Raccourcis proposés au-dessus du formulaire. Les mois sont civils et entiers,
 * l'année est l'année civile : ce sont les découpages de la comptabilité.
 */
export function periodPresets(today: string): PeriodPreset[] {
  const month = today.slice(0, 7)
  const year = today.slice(0, 4)
  return [
    { label: 'Ce mois-ci', period: monthPeriod(month) },
    { label: 'Mois précédent', period: monthPeriod(addMonthsToIsoMonth(month, -1)) },
    {
      label: '3 derniers mois',
      period: { from: `${addMonthsToIsoMonth(month, -2)}-01`, to: monthPeriod(month).to },
    },
    {
      label: '12 derniers mois',
      period: { from: `${addMonthsToIsoMonth(month, -11)}-01`, to: monthPeriod(month).to },
    },
    { label: `Année ${year}`, period: { from: `${year}-01-01`, to: `${year}-12-31` } },
  ]
}

export function samePeriod(a: Period, b: Period): boolean {
  return a.from === b.from && a.to === b.to
}
