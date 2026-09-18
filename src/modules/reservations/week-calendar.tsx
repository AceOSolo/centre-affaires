'use client'

import { useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { formatTime } from '../../lib/dates.ts'
import { weekdayLabels } from '../ressources/labels.ts'
import type { TimeRange } from './availability.ts'
import {
  cellsInRange,
  isSelectable,
  rangeBetween,
  SLOT_MINUTES,
  type Cell,
  type CellState,
} from './selection.ts'

/**
 * Calendrier hebdomadaire d'une ressource, sélectionnable au clic.
 *
 * Le planning du back-office montre ce qui est pris ; celui-ci sert à prendre.
 * La sélection se fait en deux clics — début puis fin — plutôt qu'au
 * glissement : c'est le seul geste identique au doigt et à la souris, donc le
 * seul qui tienne à 375 px sans un second code pour le téléphone.
 *
 * Un vrai tableau : les colonnes sont des jours, les lignes des créneaux, et un
 * lecteur d'écran annonce « mardi, 10h00 » sans que rien ne soit ajouté.
 * `role="grid"` et un `tabIndex` roulant évitent d'imposer cent-soixante
 * tabulations pour traverser la semaine.
 */

export type CalendarDay = {
  isoDate: string
  weekday: number
  cells: Cell[]
  /** Aucune plage d'ouverture ce jour-là. */
  closed: boolean
}

/**
 * Aspect de chaque état.
 *
 * `busy` est hachuré, pas seulement coloré : dans une case de cette taille il
 * n'y a pas la place d'un libellé, et la couleur ne porte jamais l'information
 * seule. La trame est un second canal, doublé par la légende et par le
 * `aria-label` de chaque case.
 */
const cellStyles: Record<CellState, string> = {
  free: 'bg-background hover:bg-primary/10 hover:border-primary/40',
  busy: 'bg-primary/10 border-primary/30 [background-image:repeating-linear-gradient(135deg,transparent,transparent_4px,var(--color-primary)_4px,var(--color-primary)_5px)]',
  closed: 'bg-muted',
  past: 'bg-muted/60',
}

const cellDescriptions: Record<CellState, string> = {
  free: 'libre',
  busy: 'déjà réservé',
  closed: 'fermé',
  past: 'passé',
}

export function WeekCalendar({
  days,
  timeZone,
  selection,
  onSelect,
  today,
  label,
}: {
  days: CalendarDay[]
  timeZone: string
  selection?: TimeRange
  onSelect: (range: TimeRange | undefined) => void
  today: string
  /** Nommé pour le lecteur d'écran : « Salle Mont Blanc, semaine du… ». */
  label: string
}) {
  /** Première case d'une sélection en cours : le deuxième clic la referme. */
  const [anchor, setAnchor] = useState<Cell>()
  const [active, setActive] = useState({ row: 0, col: 0 })
  const gridRef = useRef<HTMLTableElement>(null)

  // Les colonnes partagent la même amplitude murale ; au changement d'heure
  // elles n'ont pas toutes le même nombre de cases, d'où le maximum.
  const rowCount = Math.max(...days.map((day) => day.cells.length), 0)
  const rows = useMemo(
    () => Array.from({ length: rowCount }, (_, row) => days.map((day) => day.cells[row])),
    [days, rowCount],
  )

  const selected = useMemo(
    () => days.map((day) => cellsInRange(selection, day.cells)),
    [days, selection],
  )

  if (rowCount === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-muted px-6 py-10 text-center text-sm text-muted-foreground">
        Aucun créneau cette semaine. Choisissez une autre semaine.
      </p>
    )
  }

  function choose(dayIndex: number, cell: Cell) {
    if (cell.state !== 'free') return

    // Cliquer dans la sélection en cours l'efface : c'est le moyen de revenir
    // en arrière sans chercher un bouton « annuler ».
    if (selection && selected[dayIndex].has(days[dayIndex].cells.indexOf(cell))) {
      setAnchor(undefined)
      onSelect(undefined)
      return
    }

    if (!anchor) {
      setAnchor(cell)
      onSelect(cell)
      return
    }

    const candidate = rangeBetween(anchor, cell)
    // Un créneau ne peut pas enjamber une réservation, même si ses deux bouts
    // sont libres. Le refus relance la sélection sur la case cliquée plutôt que
    // de ne rien faire, qui passerait pour une panne.
    if (isSelectable(candidate, days[dayIndex].cells)) {
      setAnchor(undefined)
      onSelect(candidate)
    } else {
      setAnchor(cell)
      onSelect(cell)
    }
  }

  function moveTo(row: number, col: number) {
    const clampedRow = Math.min(Math.max(row, 0), rowCount - 1)
    const clampedCol = Math.min(Math.max(col, 0), days.length - 1)
    setActive({ row: clampedRow, col: clampedCol })
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-cell="${clampedRow}-${clampedCol}"]`)
      ?.focus()
  }

  function onKeyDown(event: KeyboardEvent, row: number, col: number) {
    const moves: Record<string, [number, number]> = {
      ArrowUp: [row - 1, col],
      ArrowDown: [row + 1, col],
      ArrowLeft: [row, col - 1],
      ArrowRight: [row, col + 1],
      Home: [0, col],
      End: [rowCount - 1, col],
    }
    const next = moves[event.key]
    if (!next) return
    event.preventDefault()
    moveTo(next[0], next[1])
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table
          ref={gridRef}
          role="grid"
          aria-label={label}
          className="w-full min-w-[34rem] border-collapse"
        >
          <caption className="sr-only">
            Créneaux de la semaine. Cliquez l’heure de début puis l’heure de fin.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="w-14 border-b border-border p-2">
                <span className="sr-only">Heure</span>
              </th>
              {days.map((day) => (
                <th
                  key={day.isoDate}
                  scope="col"
                  className={`border-b border-l border-border p-2 text-center text-sm font-medium ${
                    day.isoDate === today ? 'bg-primary/5 text-primary' : 'text-primary'
                  }`}
                >
                  <span className="block">{weekdayLabels[day.weekday].slice(0, 3)}</span>
                  <span className="block text-xs font-normal text-muted-foreground tabular">
                    {day.isoDate.slice(8, 10)}/{day.isoDate.slice(5, 7)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => {
              const reference = row.find(Boolean)
              // Une étiquette à l'heure pleine seulement : une par demi-heure
              // serait illisible et n'apprendrait rien.
              const onTheHour = rowIndex % (60 / SLOT_MINUTES) === 0
              return (
                <tr key={rowIndex}>
                  <th
                    scope="row"
                    className="h-11 w-14 border-b border-border px-2 text-right align-top text-xs font-normal text-muted-foreground tabular sm:h-9"
                  >
                    {onTheHour && reference ? formatTime(reference.startsAt, timeZone) : ''}
                  </th>
                  {row.map((cell, colIndex) => {
                    if (!cell) {
                      return (
                        <td
                          key={colIndex}
                          className="border-b border-l border-border bg-muted"
                          aria-hidden="true"
                        />
                      )
                    }
                    const isSelected = selected[colIndex].has(rowIndex)
                    const isAnchor = anchor === cell
                    const heure = `${formatTime(cell.startsAt, timeZone)} à ${formatTime(cell.endsAt, timeZone)}`
                    return (
                      <td key={colIndex} className="border-b border-l border-border p-0">
                        <button
                          type="button"
                          data-cell={`${rowIndex}-${colIndex}`}
                          tabIndex={active.row === rowIndex && active.col === colIndex ? 0 : -1}
                          aria-disabled={cell.state !== 'free'}
                          aria-pressed={isSelected}
                          aria-label={`${weekdayLabels[days[colIndex].weekday]} ${heure}, ${
                            cellDescriptions[cell.state]
                          }`}
                          onFocus={() => setActive({ row: rowIndex, col: colIndex })}
                          onKeyDown={(event) => onKeyDown(event, rowIndex, colIndex)}
                          onClick={() => choose(colIndex, cell)}
                          className={`block h-11 w-full border border-transparent transition-colors duration-150 ease-out focus-visible:relative focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary sm:h-9 ${
                            isSelected
                              ? 'bg-primary text-primary-foreground'
                              : cellStyles[cell.state]
                          } ${cell.state === 'free' ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                        >
                          {isAnchor && (
                            <span className="sr-only">
                              Début choisi, cliquez l’heure de fin
                            </span>
                          )}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <Legend />
    </div>
  )
}

/**
 * Légende des trames.
 *
 * Elle n'est pas décorative : c'est elle qui rend la grille lisible sans
 * dépendre de la couleur, avec le hachuré et les `aria-label`.
 */
function Legend() {
  const entries: Array<{ state: CellState | 'selected'; label: string }> = [
    { state: 'free', label: 'Libre' },
    { state: 'busy', label: 'Déjà réservé' },
    { state: 'closed', label: 'Fermé' },
    { state: 'selected', label: 'Votre choix' },
  ]

  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
      {entries.map(({ state, label }) => (
        <li key={state} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`size-4 shrink-0 rounded-[4px] border border-border ${
              state === 'selected' ? 'bg-primary' : cellStyles[state]
            }`}
          />
          {label}
        </li>
      ))}
    </ul>
  )
}
