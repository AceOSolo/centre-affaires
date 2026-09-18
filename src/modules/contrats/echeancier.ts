import type { BillingPeriod } from './schema.ts'

/**
 * Échéancier d'un contrat : quelles périodes sont dues, et pour combien.
 *
 * Tout est en dates de calendrier, jamais en instants : une période de
 * facturation va « du 1er au 31 mars », ce qui ne dépend d'aucun fuseau. Les
 * calculs passent par `Date.UTC`, qui sert ici de simple arithmétique de
 * calendrier.
 *
 * Deux conventions, qui sont des choix de gestion et non des évidences (ADR 006) :
 *
 * 1. **Périodes alignées sur le calendrier** — un contrat mensuel est facturé
 *    par mois civil, pas par mois anniversaire. Un contrat qui commence le 10
 *    mars donne une première période du 10 au 31 mars.
 * 2. **Prorata temporis au jour** — une période partielle est due au prorata
 *    des jours couverts, bornes comprises.
 */

const MS_PER_DAY = 86_400_000

const toUtc = (isoDate: string): number =>
  Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)))

const toIso = (utc: number): string => new Date(utc).toISOString().slice(0, 10)

/** Les dates ISO se comparent comme des chaînes : le format est ordonné. */
const min = (a: string, b: string) => (a <= b ? a : b)
const max = (a: string, b: string) => (a >= b ? a : b)

/** Nombre de jours d'une période, bornes comprises. Du 1er au 31 mars : 31. */
export function daysInclusive(startsOn: string, endsOn: string): number {
  return Math.round((toUtc(endsOn) - toUtc(startsOn)) / MS_PER_DAY) + 1
}

/** Décale une date de calendrier d'un nombre de jours. */
export function addDays(isoDate: string, days: number): string {
  return toIso(toUtc(isoDate) + days * MS_PER_DAY)
}

/** Premier mois de la période qui contient ce mois : 1, 4, 7 ou 10 au trimestre. */
function periodStartMonth(month: number, period: BillingPeriod): number {
  if (period === 'monthly') return month
  if (period === 'quarterly') return month - ((month - 1) % 3)
  return 1
}

/** Premier jour de la période de facturation qui contient cette date. */
export function periodStart(isoDate: string, period: BillingPeriod): string {
  const year = Number(isoDate.slice(0, 4))
  const month = periodStartMonth(Number(isoDate.slice(5, 7)), period)
  return `${year}-${String(month).padStart(2, '0')}-01`
}

/** Dernier jour de la période de facturation qui contient cette date. */
export function periodEnd(isoDate: string, period: BillingPeriod): string {
  const start = periodStart(isoDate, period)
  const months = period === 'monthly' ? 1 : period === 'quarterly' ? 3 : 12
  const year = Number(start.slice(0, 4))
  const month = Number(start.slice(5, 7))
  // Le jour 0 du mois suivant est le dernier jour du mois courant, quelle que
  // soit sa longueur et sans table d'années bissextiles à tenir.
  return toIso(Date.UTC(year, month - 1 + months, 0))
}

/**
 * Montant dû pour une période partielle.
 *
 * Arrondi au centime le plus proche : les montants sont des entiers de centimes
 * (décision 5), et un flottant qui traîne finit par produire une facture à
 * 149,999999 €. Une période entière rend exactement le montant du contrat, sans
 * passer par la division.
 */
export function prorataCents(amountCents: number, coveredDays: number, periodDays: number): number {
  if (periodDays <= 0 || coveredDays <= 0) return 0
  if (coveredDays >= periodDays) return amountCents
  return Math.round((amountCents * coveredDays) / periodDays)
}

export type ScheduledPeriod = {
  startsOn: string
  endsOn: string
  /** Faux quand le contrat ne couvre qu'une partie de la période civile. */
  full: boolean
  amountCents: number
}

export type ScheduledContract = {
  startsOn: string
  endsOn?: string | null
  terminatedOn?: string | null
  billingPeriod: BillingPeriod
  amountCents: number
}

/**
 * Périodes dues entre le début du contrat et `until` inclus.
 *
 * `until` borne la génération : un contrat à durée indéterminée n'a pas de fin,
 * et l'appelant décide jusqu'où il veut regarder — l'année en cours pour un
 * écran, la période suivante pour une facturation.
 *
 * Une résiliation l'emporte sur le terme prévu : un contrat résilié le 15 avril
 * ne doit rien après le 15 avril, même si son échéance était en décembre.
 */
export function billingSchedule(contract: ScheduledContract, until: string): ScheduledPeriod[] {
  const bounds = [contract.endsOn, contract.terminatedOn].filter(
    (date): date is string => Boolean(date),
  )
  const lastDay = bounds.reduce((earliest, date) => min(earliest, date), until)
  if (lastDay < contract.startsOn) return []

  const periods: ScheduledPeriod[] = []
  let cursor = periodStart(contract.startsOn, contract.billingPeriod)

  // La borne de sécurité couvre un siècle de mensualités : elle ne se déclenche
  // que sur un `until` aberrant, jamais sur un contrat réel.
  for (let guard = 0; guard < 1200; guard += 1) {
    const civilStart = cursor
    const civilEnd = periodEnd(cursor, contract.billingPeriod)

    const startsOn = max(civilStart, contract.startsOn)
    const endsOn = min(civilEnd, lastDay)
    if (startsOn > endsOn) break

    const coveredDays = daysInclusive(startsOn, endsOn)
    const periodDays = daysInclusive(civilStart, civilEnd)
    periods.push({
      startsOn,
      endsOn,
      full: coveredDays === periodDays,
      amountCents: prorataCents(contract.amountCents, coveredDays, periodDays),
    })

    if (civilEnd >= lastDay) break
    cursor = addDays(civilEnd, 1)
  }

  return periods
}

/** Total dû sur l'échéancier, en centimes. */
export function scheduleTotalCents(periods: readonly ScheduledPeriod[]): number {
  return periods.reduce((total, period) => total + period.amountCents, 0)
}

/**
 * Dernier jour du contrat si le préavis était déposé à cette date.
 *
 * Le préavis court à partir du jour de la demande, celui-ci compris : 90 jours
 * déposés le 1er mars mènent au 29 mai inclus. Sans préavis, le contrat
 * s'arrête le jour même.
 */
export function noticeEndsOn(requestedOn: string, noticeDays: number): string {
  return addDays(requestedOn, Math.max(0, noticeDays - 1))
}
