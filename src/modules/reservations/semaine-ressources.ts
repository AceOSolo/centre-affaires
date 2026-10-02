import { dayRangeUtc, toWallClock } from '../../lib/dates.ts'
import type { TimeRange } from '../ressources/ouverture.ts'
import { coversDay, isContractOccupation, type DisplayableBooking } from './affichage.ts'
import { blockGeometry } from './planning.ts'
import { columnsForDays, type WeekColumn } from './semaine.ts'
import { freeRanges } from './slots.ts'

/**
 * Semaine de toutes les ressources d'un type (R03, ADR 017).
 *
 * Une ligne par ressource, une colonne par jour : c'est l'inverse de la vue
 * jour (une colonne par ressource) et le complément de la semaine d'une
 * ressource (ADR 011). Les ressources vont en lignes pour que la grille
 * s'allonge au lieu de s'élargir : cinquante boîtes aux lettres font une liste
 * qui défile, pas une grille à cinquante colonnes.
 *
 * Chaque case porte une barre d'occupation sur l'amplitude murale commune de
 * la semaine — les cases sont comparables d'un coup d'œil — et de quoi
 * pré-remplir une réservation : le premier quart d'heure libre.
 *
 * Fonctions pures : instants en entrée, pourcentages et heures murales en
 * sortie. La journée d'un changement d'heure reste juste, chaque colonne ayant
 * sa propre fenêtre en instants (`columnsForDays`).
 */

/** Une réservation telle que la grille la place : il lui faut sa ressource. */
export type GridBooking = DisplayableBooking & { resourceId: string }

/** Portion d'une barre d'occupation, en pourcentage de sa largeur. */
export type BarSegment = { leftPercent: number; widthPercent: number }

export type WeekCell = {
  isoDate: string
  /** Aucune plage d'ouverture ce jour-là, pour cette ressource. */
  closed: boolean
  /** Occupation de contrat qui couvre toute la journée, s'il y en a une. */
  contract?: GridBooking
  /** Réservations qui occupent la ressource ce jour-là, par heure de début. */
  bookings: GridBooking[]
  /** Leur place sur la barre, rognée sur l'amplitude affichée. */
  segments: (BarSegment & { booking: GridBooking })[]
  /** Heures d'ouverture sur la même barre : le reste est fermé. */
  opening: BarSegment[]
  /** Heure murale « HH:MM » du premier quart d'heure libre dans l'ouverture. */
  firstFree?: string
  /** Ouvert, mais plus un quart d'heure de libre dans l'ouverture. */
  full: boolean
}

export type WeekRow<R> = { resource: R; cells: WeekCell[] }

const QUARTER_MS = 15 * 60_000

/** Arrondi au quart d'heure supérieur — le pas du formulaire de réservation. */
function ceilToQuarter(instant: Date): Date {
  return new Date(Math.ceil(instant.getTime() / QUARTER_MS) * QUARTER_MS)
}

/**
 * Premier quart d'heure libre dans les plages d'ouverture.
 *
 * Arrondi au quart d'heure : une réservation qui finit à 10h10 propose 10h15,
 * l'heure que le champ du formulaire accepte. Un reste de moins d'un quart
 * d'heure ne compte pas comme libre.
 */
export function firstFreeStart(
  opening: readonly TimeRange[],
  busy: readonly TimeRange[],
): Date | undefined {
  for (const window of opening) {
    for (const free of freeRanges(window, busy)) {
      const start = ceilToQuarter(free.startsAt)
      if (start.getTime() + QUARTER_MS <= free.endsAt.getTime()) return start
    }
  }
  return undefined
}

const toBar = (geometry: { topPercent: number; heightPercent: number }): BarSegment => ({
  leftPercent: geometry.topPercent,
  widthPercent: geometry.heightPercent,
})

/**
 * Une case : une ressource, un jour.
 *
 * `bookings` ne doit contenir que des réservations qui occupent — les
 * annulées libèrent leur créneau et ne se dessinent pas.
 */
export function weekCell(
  column: WeekGridColumn,
  opening: readonly TimeRange[],
  bookings: readonly GridBooking[],
  timeZone: string,
): WeekCell {
  const day = bookings
    .filter(
      (booking) =>
        booking.startsAt.getTime() < column.dayEndsAt.getTime() &&
        booking.endsAt.getTime() > column.dayStartsAt.getTime(),
    )
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())

  const contract = day.find(
    (booking) => isContractOccupation(booking) && coversDay(booking, column.isoDate, timeZone),
  )
  const free = firstFreeStart(opening, day)

  return {
    isoDate: column.isoDate,
    closed: opening.length === 0,
    contract,
    bookings: day,
    segments: day.flatMap((booking) => {
      const geometry = blockGeometry(booking, column.window)
      return geometry ? [{ booking, ...toBar(geometry) }] : []
    }),
    opening: opening.flatMap((range) => {
      const geometry = blockGeometry(range, column.window)
      return geometry ? [toBar(geometry)] : []
    }),
    firstFree: free ? toWallClock(free, timeZone).slice(11, 16) : undefined,
    full: opening.length > 0 && !free,
  }
}

/** Colonne de la semaine, augmentée des bornes de la journée civile du centre. */
export type WeekGridColumn = WeekColumn & { dayStartsAt: Date; dayEndsAt: Date }

/**
 * Colonnes communes à toutes les lignes : même amplitude murale, chacune avec
 * sa fenêtre en instants. L'ouverture se lit case par case, chaque ressource
 * pouvant avoir ses horaires (ADR 012).
 */
export function weekGridColumns(
  days: readonly string[],
  timeZone: string,
  extent: { openHour: number; closeHour: number },
): WeekGridColumn[] {
  return columnsForDays(days, timeZone, extent, {}).map((column) => {
    const day = dayRangeUtc(column.isoDate, timeZone)
    return { ...column, closed: false, dayStartsAt: day.startsAt, dayEndsAt: day.endsAt }
  })
}

/**
 * Lignes de la semaine, une par ressource, dans l'ordre reçu.
 *
 * `openingByResource[resourceId][isoDate]` : les plages d'ouverture déjà
 * résolues pour la ressource (horaires propres, fermetures exceptionnelles).
 */
export function weekResourceRows<R extends { id: string }>(input: {
  resources: readonly R[]
  columns: readonly WeekGridColumn[]
  bookings: readonly GridBooking[]
  openingByResource: Record<string, Record<string, TimeRange[]>>
  timeZone: string
}): WeekRow<R>[] {
  const byResource = new Map<string, GridBooking[]>()
  for (const booking of input.bookings) {
    if (booking.status === 'cancelled') continue
    const list = byResource.get(booking.resourceId) ?? []
    list.push(booking)
    byResource.set(booking.resourceId, list)
  }

  return input.resources.map((resource) => ({
    resource,
    cells: input.columns.map((column) =>
      weekCell(
        column,
        input.openingByResource[resource.id]?.[column.isoDate] ?? [],
        byResource.get(resource.id) ?? [],
        input.timeZone,
      ),
    ),
  }))
}

/**
 * Suite de cases d'une ligne : une case seule, ou plusieurs jours consécutifs
 * entièrement couverts par la même occupation de contrat.
 *
 * Un bureau loué trois ans ne doit pas répéter « Occupé — contrat … » dans
 * chaque case : la suite est fusionnée en une seule, qui dit le contrat une
 * fois et s'étend sur les jours qu'il couvre.
 */
export type CellRun<C> = { start: number; span: number; cells: C[]; contract?: GridBooking }

export function contractRuns<C extends { contract?: GridBooking }>(cells: readonly C[]): CellRun<C>[] {
  const runs: CellRun<C>[] = []
  cells.forEach((cell, index) => {
    const last = runs[runs.length - 1]
    if (cell.contract && last?.contract && last.contract.id === cell.contract.id) {
      last.span += 1
      last.cells.push(cell)
      return
    }
    runs.push({ start: index, span: 1, cells: [cell], contract: cell.contract })
  })
  return runs
}
