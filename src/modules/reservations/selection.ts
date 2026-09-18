import type { TimeRange } from './availability.ts'

/**
 * Découpe d'une journée en cellules sélectionnables.
 *
 * Le planning du back-office dessine ce qui est pris, en positionnant des blocs
 * au pourcentage (`planning.ts`). Choisir un créneau demande l'inverse : une
 * grille régulière dont chaque case est cliquable ou ne l'est pas. D'où ce
 * second découpage, en cellules de durée fixe.
 *
 * Tout est calculé sur des instants, jamais sur des durées supposées. Le jour
 * d'un changement d'heure, une fenêtre d'ouverture « 8h-22h » ne fait pas
 * quatorze heures, et compter les cellules à partir du début de la fenêtre est
 * la seule façon de rester juste (décision 4).
 */

/**
 * Pas de la grille.
 *
 * Trente minutes : assez fin pour un entretien d'une demi-heure, assez large
 * pour qu'une journée de 8h à 22h tienne en vingt-huit lignes lisibles au
 * téléphone. Le pas de saisie du formulaire est le même (`step={900}` accepte
 * le quart d'heure, la grille propose la demi-heure).
 */
export const SLOT_MINUTES = 30

const MINUTE_MS = 60_000

/**
 * État d'une cellule, dans l'ordre de priorité où il est décidé.
 *
 * `closed` d'abord : hors ouverture, rien d'autre ne compte. `busy` ensuite,
 * avant `past` : une réservation passée reste une information pour le staff,
 * alors que « passé » n'en est pas une. `free` est le seul état sélectionnable.
 */
export type CellState = 'free' | 'busy' | 'closed' | 'past'

export type Cell = TimeRange & { state: CellState }

/** Une cellule est-elle entièrement contenue dans l'une des plages ? */
function isWithin(cell: TimeRange, ranges: readonly TimeRange[]): boolean {
  return ranges.some(
    (range) =>
      range.startsAt.getTime() <= cell.startsAt.getTime() &&
      range.endsAt.getTime() >= cell.endsAt.getTime(),
  )
}

/**
 * Bornes `[)` partout, comme la contrainte d'exclusion : une réservation qui
 * finit à 10h00 laisse la cellule de 10h00 libre.
 */
function intersects(cell: TimeRange, ranges: readonly TimeRange[]): boolean {
  return ranges.some(
    (range) =>
      cell.startsAt.getTime() < range.endsAt.getTime() &&
      range.startsAt.getTime() < cell.endsAt.getTime(),
  )
}

/**
 * Cellules d'une journée.
 *
 * `opening` vient de `openingWindows()`, `busy` ne doit contenir que des
 * réservations qui occupent réellement la ressource — les annulées libèrent
 * leur créneau (`occupiesResource`).
 *
 * La dernière cellule incomplète est écartée : une grille ne propose pas un
 * quart d'heure quand son pas est la demi-heure.
 */
export function dayCells(
  window: TimeRange,
  opening: readonly TimeRange[],
  busy: readonly TimeRange[],
  now: Date,
): Cell[] {
  const step = SLOT_MINUTES * MINUTE_MS
  const cells: Cell[] = []

  for (
    let start = window.startsAt.getTime();
    start + step <= window.endsAt.getTime();
    start += step
  ) {
    const cell = { startsAt: new Date(start), endsAt: new Date(start + step) }
    cells.push({ ...cell, state: cellState(cell, opening, busy, now) })
  }

  return cells
}

function cellState(
  cell: TimeRange,
  opening: readonly TimeRange[],
  busy: readonly TimeRange[],
  now: Date,
): CellState {
  if (!isWithin(cell, opening)) return 'closed'
  if (intersects(cell, busy)) return 'busy'
  if (cell.endsAt.getTime() <= now.getTime()) return 'past'
  return 'free'
}

/**
 * Créneau couvert par deux cellules cliquées, quel que soit l'ordre des clics.
 *
 * Le deuxième clic ferme la sélection sur la fin de sa cellule : cliquer 10h00
 * puis 11h30 demande de 10h00 à 12h00, ce qui est ce qu'on lit à l'écran quand
 * les deux cases sont surlignées.
 */
export function rangeBetween(a: TimeRange, b: TimeRange): TimeRange {
  return {
    startsAt: new Date(Math.min(a.startsAt.getTime(), b.startsAt.getTime())),
    endsAt: new Date(Math.max(a.endsAt.getTime(), b.endsAt.getTime())),
  }
}

/**
 * Le créneau ne couvre-t-il que des cellules libres ?
 *
 * Empêche de sélectionner « par-dessus » une réservation en cliquant de part et
 * d'autre. Ce n'est qu'un confort de saisie : l'autorité reste la contrainte
 * d'exclusion en base (décision 3), et le serveur revérifie.
 */
export function isSelectable(range: TimeRange, cells: readonly Cell[]): boolean {
  if (range.endsAt.getTime() <= range.startsAt.getTime()) return false

  const covered = cells.filter((cell) => intersects(cell, [range]))
  return covered.length > 0 && covered.every((cell) => cell.state === 'free')
}

/** Cellules couvertes par la sélection, pour les surligner. */
export function cellsInRange(range: TimeRange | undefined, cells: readonly Cell[]): Set<number> {
  if (!range) return new Set()
  const indexes = new Set<number>()
  cells.forEach((cell, index) => {
    if (intersects(cell, [range])) indexes.add(index)
  })
  return indexes
}

/** Durée d'un créneau en minutes — « 1 h 30 » se calcule à l'affichage. */
export function rangeMinutes(range: TimeRange): number {
  return Math.round((range.endsAt.getTime() - range.startsAt.getTime()) / MINUTE_MS)
}
