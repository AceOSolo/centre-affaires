import { dayRangeUtc, toIsoDate } from '../../lib/dates.ts'
import { dayOccupancy } from '../reservations/mois.ts'
import type { BookingKind, BookingStatus } from '../reservations/schema.ts'
import {
  closuresForResource,
  isClosedOn,
  openingWindows,
  type ClosurePeriod,
  type OpeningRule,
  type TimeRange,
} from '../ressources/ouverture.ts'
import type { ResourceStatus, ResourceType } from '../ressources/schema.ts'
import { inPeriod, type Period } from './periode.ts'

/**
 * Taux d'occupation des ressources (R31).
 *
 * **Définition.** Heures occupées sur heures d'ouverture de la ressource, jour
 * par jour, sur ses propres horaires (`ouverture.ts` : les règles de la
 * ressource remplacent celles du centre, une fermeture exceptionnelle retire
 * la journée). Comptent comme occupées :
 *
 * - les réservations confirmées (`kind = 'booking'`) ;
 * - les occupations de contrat (`kind = 'contract'`, ADR 018 et 025) : un
 *   bureau ou une boîte aux lettres loué compte comme occupé toutes ses heures
 *   d'ouverture, sur chacun de ses jours d'occupation.
 *
 * Ne comptent pas : les demandes en attente (rien n'est encore vendu), les
 * annulées, les indisponibilités posées par l'équipe (un entretien n'est pas
 * une vente), ni ce qui déborde des heures d'ouverture. Le dénominateur reste
 * l'ouverture entière : une salle en travaux une semaine voit son taux baisser,
 * c'est une information. Définition par défaut, à valider par le centre.
 *
 * Fonctions pures, sur des instants déjà résolus : aucune ne connaît la base.
 * Le calcul d'une journée est celui de la vue mois du planning (`dayOccupancy`,
 * ADR 017), pour que les deux écrans ne divergent jamais.
 */

/** Ce qu'il faut d'une réservation pour compter l'occupation. */
export type OccupyingBooking = TimeRange & {
  resourceId: string
  kind: BookingKind
  status: BookingStatus
}

/** Vrai pour ce qui compte comme occupé dans le taux. */
export function countsAsOccupied(booking: Pick<OccupyingBooking, 'kind' | 'status'>): boolean {
  return booking.status === 'confirmed' && (booking.kind === 'booking' || booking.kind === 'contract')
}

/** Minutes d'une ressource un jour donné. */
export type DayMinutes = {
  /** Heures d'ouverture de la journée, en minutes. */
  openMinutes: number
  /** Minutes d'ouverture occupées par une réservation ou un contrat. */
  busyMinutes: number
  /** Dont occupées par un contrat. */
  contractMinutes: number
}

/** Minutes cumulées : une ressource, un type, un mois, tout le parc. */
export type OccupancyTotals = DayMinutes

const zero = (): OccupancyTotals => ({ openMinutes: 0, busyMinutes: 0, contractMinutes: 0 })

function add(into: OccupancyTotals, day: DayMinutes): void {
  into.openMinutes += day.openMinutes
  into.busyMinutes += day.busyMinutes
  into.contractMinutes += day.contractMinutes
}

/**
 * Une ressource et ses jours d'existence, jours civils du centre : le jour de
 * sa déclaration et, si elle est archivée, celui de son archivage. Nuls : pas
 * de borne.
 */
export type ObservedResource = { id: string; firstDay?: string | null; lastDay?: string | null }

/** Occupation jour par jour : ressource → jour ISO → minutes. */
export type DailyOccupancy = Map<string, Map<string, DayMinutes>>

/**
 * Occupation de chaque ressource, chaque jour.
 *
 * Une ressource n'est ouverte qu'à partir de son premier jour (sa
 * déclaration) et jusqu'à son dernier (son archivage) : un bureau déclaré le
 * 15 n'a pas été « libre » du 1er au 14. Une réservation antérieure à la
 * déclaration — une reprise de l'historique — avance ce premier jour.
 *
 * Les fenêtres d'ouverture sont calculées une fois par jour et par jeu de
 * règles (celles du centre, ou celles propres à une ressource), puis
 * partagées : sur un an et quelques dizaines de ressources, recalculer les
 * conversions de fuseau pour chacune coûterait des dizaines de milliers
 * d'appels à `Intl` pour le même résultat.
 */
export function dailyOccupancy(input: {
  resources: readonly ObservedResource[]
  days: readonly string[]
  bookings: readonly OccupyingBooking[]
  rules: readonly OpeningRule[]
  closures: readonly ClosurePeriod[]
  timeZone: string
}): DailyOccupancy {
  const { days, timeZone, rules } = input
  const ranges = new Map(days.map((day) => [day, dayRangeUtc(day, timeZone)]))

  const byResource = new Map<string, OccupyingBooking[]>()
  for (const booking of input.bookings) {
    if (!countsAsOccupied(booking)) continue
    const list = byResource.get(booking.resourceId) ?? []
    list.push(booking)
    byResource.set(booking.resourceId, list)
  }

  const ownRules = new Set(rules.filter((rule) => rule.resourceId !== null).map((rule) => rule.resourceId))
  const windowsCache = new Map<string, TimeRange[]>()
  const windowsFor = (resourceId: string, day: string): TimeRange[] => {
    const owner = ownRules.has(resourceId) ? resourceId : 'centre'
    const key = `${owner}|${day}`
    let windows = windowsCache.get(key)
    if (!windows) {
      // Les fermetures sont appliquées à part, par ressource : le cache ne
      // porte que les horaires.
      windows = openingWindows(day, timeZone, { rules, resourceId })
      windowsCache.set(key, windows)
    }
    return windows
  }

  const daily: DailyOccupancy = new Map()
  for (const { id: resourceId, firstDay, lastDay } of input.resources) {
    const closures = closuresForResource(input.closures, resourceId)
    const own = byResource.get(resourceId) ?? []
    const earliest = own.reduce<Date | undefined>(
      (min, booking) => (!min || booking.startsAt < min ? booking.startsAt : min),
      undefined,
    )
    const earliestDay = earliest ? toIsoDate(earliest, timeZone) : undefined
    const from = firstDay && earliestDay && earliestDay < firstDay ? earliestDay : firstDay
    const perDay = new Map<string, DayMinutes>()
    for (const day of days) {
      const observed = (!from || day >= from) && (!lastDay || day <= lastDay)
      const opening = !observed || isClosedOn(closures, day) ? [] : windowsFor(resourceId, day)
      if (opening.length === 0) {
        perDay.set(day, { openMinutes: 0, busyMinutes: 0, contractMinutes: 0 })
        continue
      }
      const range = ranges.get(day)!
      const busy = own.filter(
        (booking) =>
          booking.startsAt.getTime() < range.endsAt.getTime() &&
          booking.endsAt.getTime() > range.startsAt.getTime(),
      )
      const { openMinutes, busyMinutes } = dayOccupancy(opening, busy)
      const contracts = busy.filter((booking) => booking.kind === 'contract')
      const contractMinutes = contracts.length > 0 ? dayOccupancy(opening, contracts).busyMinutes : 0
      perDay.set(day, { openMinutes, busyMinutes, contractMinutes })
    }
    daily.set(resourceId, perDay)
  }
  return daily
}

/**
 * Taux en dixièmes de pour cent (473 = 47,3 %), ou `null` sans heure
 * d'ouverture.
 *
 * Même règle que la vue mois : 0 seulement si rien n'est occupé, 100 % seulement
 * si tout l'est. Un quart d'heure sur un mois donne 0,1 %, pas 0 ; une salle
 * presque pleine donne 99,9 %, pas 100. L'arrondi ne doit pas faire mentir
 * l'indicateur.
 */
export function occupancyRate(totals: Pick<OccupancyTotals, 'openMinutes' | 'busyMinutes'>): number | null {
  const { openMinutes, busyMinutes } = totals
  if (openMinutes <= 0) return null
  if (busyMinutes <= 0) return 0
  if (busyMinutes >= openMinutes) return 1000
  return Math.min(999, Math.max(1, Math.round((busyMinutes * 1000) / openMinutes)))
}

/** Ce qu'il faut savoir d'une ressource pour la classer. */
export type OccupancyResource = {
  id: string
  resourceType: ResourceType
  status: ResourceStatus
  deletedAt: Date | null
}

export type ResourceOccupancy<R extends OccupancyResource> = OccupancyTotals & {
  resource: R
  /** Jours de la période où un contrat occupe la ressource. */
  contractDays: number
  rate: number | null
}

export type TypeOccupancy = OccupancyTotals & {
  resourceType: ResourceType
  resourceCount: number
  rate: number | null
}

export type OccupancySummary<R extends OccupancyResource> = {
  resources: ResourceOccupancy<R>[]
  types: TypeOccupancy[]
  total: OccupancyTotals & { rate: number | null }
}

/**
 * Une ressource fait partie du parc observé si elle est en service ou en
 * maintenance et non archivée. Une ressource retirée ou archivée n'entre dans
 * le calcul que si elle a été occupée sur la période : sa présence ne doit pas
 * diluer le taux de son type, mais son activité passée reste vraie.
 */
export function inObservedFleet(resource: OccupancyResource, busyMinutes: number): boolean {
  if (busyMinutes > 0) return true
  return resource.deletedAt === null && resource.status !== 'retired'
}

/**
 * Taux de la période, par ressource, par type et pour tout le parc.
 *
 * Les ressources gardent l'ordre reçu ; les types suivent l'ordre de leur
 * première ressource. Un type se calcule sur la somme de ses minutes, pas comme
 * la moyenne des taux : une grande salle très ouverte pèse plus qu'un casier.
 */
export function summarizeOccupancy<R extends OccupancyResource>(
  daily: DailyOccupancy,
  resources: readonly R[],
  period: Period,
): OccupancySummary<R> {
  const rows: ResourceOccupancy<R>[] = []
  for (const resource of resources) {
    const totals = zero()
    let contractDays = 0
    for (const [day, minutes] of daily.get(resource.id) ?? []) {
      if (!inPeriod(day, period)) continue
      add(totals, minutes)
      if (minutes.contractMinutes > 0) contractDays += 1
    }
    if (!inObservedFleet(resource, totals.busyMinutes)) continue
    rows.push({ resource, ...totals, contractDays, rate: occupancyRate(totals) })
  }

  const types = new Map<ResourceType, TypeOccupancy>()
  const total = zero()
  for (const row of rows) {
    const type = types.get(row.resource.resourceType) ?? {
      resourceType: row.resource.resourceType,
      resourceCount: 0,
      ...zero(),
      rate: null,
    }
    type.resourceCount += 1
    add(type, row)
    types.set(row.resource.resourceType, type)
    add(total, row)
  }
  for (const type of types.values()) type.rate = occupancyRate(type)

  return { resources: rows, types: [...types.values()], total: { ...total, rate: occupancyRate(total) } }
}

/**
 * Taux de tout le parc, mois par mois, pour la courbe d'évolution. Même parc
 * observé que `summarizeOccupancy`, évalué mois par mois.
 */
export function monthlyOccupancy(
  daily: DailyOccupancy,
  resources: readonly OccupancyResource[],
  months: readonly string[],
): { month: string; totals: OccupancyTotals; rate: number | null }[] {
  return months.map((month) => {
    const totals = zero()
    for (const resource of resources) {
      const ofMonth = zero()
      for (const [day, minutes] of daily.get(resource.id) ?? []) {
        if (day.slice(0, 7) === month) add(ofMonth, minutes)
      }
      if (!inObservedFleet(resource, ofMonth.busyMinutes)) continue
      add(totals, ofMonth)
    }
    return { month, totals, rate: occupancyRate(totals) }
  })
}

const percent = new Intl.NumberFormat('fr-FR', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

/** « 47,3 % », ou « — » sans heure d'ouverture. */
export function formatRate(rate: number | null): string {
  return rate === null ? '—' : percent.format(rate / 1000)
}

const hours = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 1 })

/** « 1 234,5 h » : des minutes en heures décimales, pour des cumuls. */
export function formatHours(minutes: number): string {
  return `${hours.format(minutes / 60)} h`
}
