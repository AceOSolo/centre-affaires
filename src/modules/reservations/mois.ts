import { addDaysToIsoDate, addMonthsToIsoMonth, dayRangeUtc } from '../../lib/dates.ts'
import type { TimeRange } from '../ressources/ouverture.ts'
import { coversDay, isContractOccupation } from './affichage.ts'
import type { GridBooking } from './semaine-ressources.ts'
import { freeMinutes, freeRanges } from './slots.ts'

/**
 * Vue mois du planning : un taux d'occupation par ressource et par jour (R03,
 * décision D2 de l'ADR 016, ADR 017).
 *
 * À l'échelle du mois, les créneaux ne se lisent plus ; ce qui se lit, c'est
 * « quels jours cette salle est pleine » et « quels bureaux sont loués ». Le
 * taux rapporte le temps occupé aux heures d'ouverture de la ressource ce
 * jour-là — un jour fermé n'a pas de taux, il est dit fermé.
 *
 * Fonctions pures, sur des instants déjà résolus : aucune ne connaît la base.
 */

/** Mois ISO « 2026-10 » du jour donné. */
export function monthOfDate(isoDate: string): string {
  return isoDate.slice(0, 7)
}

/** Tous les jours du mois, du 1er au dernier. */
export function monthDays(isoMonth: string): string[] {
  const first = `${isoMonth}-01`
  const next = `${addMonthsToIsoMonth(isoMonth, 1)}-01`
  const days: string[] = []
  for (let day = first; day < next; day = addDaysToIsoDate(day, 1)) days.push(day)
  return days
}

/**
 * Lecture d'une case, du plus particulier au plus général :
 *
 * - `contrat` : la journée entière est louée par un contrat ;
 * - `ferme` : aucune heure d'ouverture, rien de réservé ;
 * - `hors` : jour fermé, mais une réservation y est posée quand même ;
 * - `libre`, `faible` (moins de la moitié), `fort`, `complet` : le taux.
 */
export const occupancyLevels = ['contrat', 'ferme', 'hors', 'libre', 'faible', 'fort', 'complet'] as const
export type OccupancyLevel = (typeof occupancyLevels)[number]

/** Minutes ouvertes et minutes occupées dans l'ouverture, pour une journée. */
export function dayOccupancy(
  opening: readonly TimeRange[],
  busy: readonly TimeRange[],
): { openMinutes: number; busyMinutes: number } {
  const openMinutes = freeMinutes(opening)
  const left = freeMinutes(opening.flatMap((window) => freeRanges(window, busy)))
  return { openMinutes, busyMinutes: openMinutes - left }
}

/**
 * Taux en pour cent, ou `null` sans heure d'ouverture.
 *
 * 100 n'est affiché que si tout est pris, 0 que si rien ne l'est : un quart
 * d'heure réservé sur onze heures donne 1, pas 0, et une salle presque pleine
 * donne 99, pas 100. L'arrondi ne doit pas faire mentir la case.
 */
export function occupancyPercent(openMinutes: number, busyMinutes: number): number | null {
  if (openMinutes <= 0) return null
  if (busyMinutes <= 0) return 0
  if (busyMinutes >= openMinutes) return 100
  return Math.min(99, Math.max(1, Math.round((busyMinutes / openMinutes) * 100)))
}

export function occupancyLevel(input: {
  openMinutes: number
  busyMinutes: number
  bookingCount: number
  contract?: GridBooking
}): OccupancyLevel {
  if (input.contract) return 'contrat'
  const percent = occupancyPercent(input.openMinutes, input.busyMinutes)
  if (percent === null) return input.bookingCount > 0 ? 'hors' : 'ferme'
  if (percent === 0) return 'libre'
  if (percent === 100) return 'complet'
  return percent < 50 ? 'faible' : 'fort'
}

export type MonthCell = {
  isoDate: string
  openMinutes: number
  busyMinutes: number
  percent: number | null
  level: OccupancyLevel
  /** Réservations qui occupent la ressource ce jour-là, occupations comprises. */
  bookingCount: number
  /** Occupation de contrat qui couvre toute la journée, s'il y en a une. */
  contract?: GridBooking
  /** Le client filtré occupe la ressource ce jour-là. */
  clientPresent: boolean
}

export type MonthRow<R> = {
  resource: R
  cells: MonthCell[]
  /** Taux du mois : minutes occupées sur minutes ouvertes, jours fermés exclus. */
  total: { openMinutes: number; busyMinutes: number; percent: number | null }
}

/**
 * Lignes du mois, une par ressource, dans l'ordre reçu.
 *
 * Les annulées sont écartées ici : elles ne comptent ni dans le taux ni dans
 * le nombre de réservations.
 */
export function monthResourceRows<R extends { id: string }>(input: {
  resources: readonly R[]
  days: readonly string[]
  bookings: readonly GridBooking[]
  openingByResource: Record<string, Record<string, TimeRange[]>>
  timeZone: string
  clientId?: string
}): MonthRow<R>[] {
  const ranges = new Map(input.days.map((day) => [day, dayRangeUtc(day, input.timeZone)]))
  const byResource = new Map<string, GridBooking[]>()
  for (const booking of input.bookings) {
    if (booking.status === 'cancelled') continue
    const list = byResource.get(booking.resourceId) ?? []
    list.push(booking)
    byResource.set(booking.resourceId, list)
  }

  return input.resources.map((resource) => {
    const own = byResource.get(resource.id) ?? []
    const cells = input.days.map((isoDate): MonthCell => {
      const range = ranges.get(isoDate)!
      const day = own.filter(
        (booking) =>
          booking.startsAt.getTime() < range.endsAt.getTime() &&
          booking.endsAt.getTime() > range.startsAt.getTime(),
      )
      const opening = input.openingByResource[resource.id]?.[isoDate] ?? []
      const { openMinutes, busyMinutes } = dayOccupancy(opening, day)
      const contract = day.find(
        (booking) => isContractOccupation(booking) && coversDay(booking, isoDate, input.timeZone),
      )
      return {
        isoDate,
        openMinutes,
        busyMinutes,
        percent: occupancyPercent(openMinutes, busyMinutes),
        level: occupancyLevel({ openMinutes, busyMinutes, bookingCount: day.length, contract }),
        bookingCount: day.length,
        contract,
        clientPresent: Boolean(input.clientId) && day.some((booking) => booking.clientId === input.clientId),
      }
    })

    const openMinutes = cells.reduce((sum, cell) => sum + cell.openMinutes, 0)
    const busyMinutes = cells.reduce((sum, cell) => sum + cell.busyMinutes, 0)
    return {
      resource,
      cells,
      total: { openMinutes, busyMinutes, percent: occupancyPercent(openMinutes, busyMinutes) },
    }
  })
}

/**
 * Classes d'une case selon son niveau, sur les jetons `--statut-*` : du blanc
 * (disponible) au bleu foncé plein (complet), en passant par le bleu clair.
 * Le texte de la case porte toujours le taux ou l'état : la teinte ne fait
 * que le redoubler.
 */
export const occupancyLevelStyles: Record<OccupancyLevel, string> = {
  contrat: 'bg-statut-confirme/15 text-foreground',
  ferme: 'bg-statut-annule text-muted-foreground',
  hors: 'bg-statut-annule text-foreground',
  libre: 'bg-statut-disponible text-muted-foreground',
  faible: 'bg-statut-reserve/15 text-foreground',
  fort: 'bg-statut-reserve/40 text-foreground',
  complet: 'bg-statut-confirme text-primary-foreground',
}

/** Ce que la case écrit, dans une colonne de trois caractères. */
export function occupancyCellText(cell: Pick<MonthCell, 'level' | 'percent'>): string {
  switch (cell.level) {
    case 'ferme':
      return '–'
    case 'hors':
      return 'hors'
    case 'contrat':
      return 'C'
    default:
      return String(cell.percent ?? 0)
  }
}

/** Ce que la case dit aux lecteurs d'écran, en toutes lettres. */
export function occupancyCellDescription(cell: MonthCell): string {
  switch (cell.level) {
    case 'ferme':
      return 'fermé'
    case 'hors':
      return `fermé, ${cell.bookingCount} réservation${cell.bookingCount > 1 ? 's' : ''} hors ouverture`
    case 'contrat':
      return 'occupé par un contrat'
    case 'libre':
      return 'libre'
    case 'complet':
      return 'complet'
    default:
      return `occupé à ${cell.percent} %`
  }
}
