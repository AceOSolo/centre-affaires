import Link from 'next/link'

import { resourceTypeLabels, weekdayLabels } from '../ressources/labels.ts'
import { isoWeekday } from '../ressources/ouverture.ts'
import type { Resource } from '../ressources/schema.ts'
import {
  bookingBlockClass,
  bookingFocus,
  bookingHref,
  contractReference,
  occupationPeriodLabel,
} from './affichage.ts'
import { groupByType, planningHref, type PlanningFilters } from './filtres.ts'
import {
  occupancyCellDescription,
  occupancyCellText,
  occupancyLevelStyles,
  type MonthCell,
  type MonthRow,
} from './mois.ts'
import { contractRuns, type CellRun, type GridBooking } from './semaine-ressources.ts'

const focusRing =
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent'

/** Initiale du jour, sur deux lettres pour distinguer mardi et mercredi. */
const dayInitials: Record<number, string> = { 1: 'lu', 2: 'ma', 3: 'me', 4: 'je', 5: 've', 6: 'sa', 7: 'di' }

/**
 * Mois du planning : un taux d'occupation par ressource et par jour (R03,
 * décision D2 de l'ADR 016, ADR 017).
 *
 * Le taux est écrit dans chaque case, la teinte ne fait que le redoubler.
 * Cliquer une case ouvre la vue jour ; au clavier, ce sont les en-têtes de
 * colonne qui y mènent — une case par jour et par ressource ferait des
 * centaines d'arrêts de tabulation pour la même destination.
 *
 * Les jours consécutifs d'un même contrat ne font qu'une case : la ligne d'une
 * boîte aux lettres domiciliée se lit « contrat CT-2026-0003, sans terme » au
 * lieu de trente et une fois « C ».
 */
export function MonthPlanning({
  rows,
  days,
  today,
  timeZone,
  filters,
  clientNames,
  canManageResources,
}: {
  rows: MonthRow<Resource>[]
  days: string[]
  today: string
  timeZone: string
  filters: PlanningFilters
  clientNames: Record<string, string>
  /**
   * Droit `ressources.gerer` : la fiche ressource lui est réservée. Sans lui,
   * le nom n'est pas un lien, qui mènerait à « Accès réservé ».
   */
  canManageResources: boolean
}) {
  const groups = groupByType(rows.map((row) => row.resource))
  const rowById = new Map(rows.map((row) => [row.resource.id, row]))
  const clientName = filters.client ? clientNames[filters.client] : undefined

  return (
    <div className="flex flex-col gap-2">
      <Legend clientName={clientName} />
      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table className="w-full border-collapse text-xs tabular">
          <caption className="sr-only">
            Taux d’occupation par ressource et par jour, en pour cent des heures d’ouverture. Les
            en-têtes de colonne mènent à la vue jour.
          </caption>
          <thead>
            <tr className="border-b border-border">
              <th
                scope="col"
                className="sticky left-0 z-20 min-w-40 bg-white px-3 py-2 text-left font-medium text-muted-foreground"
              >
                Ressource
              </th>
              {days.map((day) => {
                const weekday = isoWeekday(day)
                const isToday = day === today
                return (
                  <th
                    key={day}
                    scope="col"
                    className={`w-8 min-w-8 border-l border-border p-0 font-medium ${
                      isToday ? 'bg-accent/15' : weekday > 5 ? 'bg-muted' : ''
                    }`}
                  >
                    <Link
                      href={planningHref('jour', { ...filters, date: day })}
                      className={`flex flex-col items-center px-0.5 py-1.5 leading-tight hover:underline ${focusRing}`}
                    >
                      <span aria-hidden className="text-muted-foreground">
                        {dayInitials[weekday]}
                      </span>
                      <span className="sr-only">{weekdayLabels[weekday]} </span>
                      <span>{Number(day.slice(8))}</span>
                      {isToday && <span className="sr-only">, aujourd’hui</span>}
                    </Link>
                  </th>
                )
              })}
              <th
                scope="col"
                className="min-w-14 border-l border-border px-2 py-2 text-right font-medium text-muted-foreground"
              >
                Mois
              </th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.type} className="border-b border-border last:border-b-0">
              {!filters.type && (
                <tr className="bg-muted">
                  <th
                    scope="rowgroup"
                    colSpan={days.length + 2}
                    className="px-3 py-1.5 text-left text-xs font-semibold tracking-tight text-foreground"
                  >
                    {resourceTypeLabels[group.type]}{' '}
                    <span className="font-normal text-muted-foreground">
                      ({group.resources.length})
                    </span>
                  </th>
                </tr>
              )}
              {group.resources.map((resource) => {
                const row = rowById.get(resource.id)!
                return (
                  <tr key={resource.id} className="border-t border-border first:border-t-0">
                    <th
                      scope="row"
                      className="sticky left-0 z-10 max-w-48 bg-white px-3 py-1.5 text-left font-normal"
                    >
                      {canManageResources ? (
                        <Link
                          href={`/ressources/${resource.id}`}
                          className={`block truncate rounded-sm py-0.5 text-sm font-medium underline-offset-2 hover:underline ${focusRing}`}
                        >
                          {resource.name}
                        </Link>
                      ) : (
                        <span className="block truncate py-0.5 text-sm font-medium">
                          {resource.name}
                        </span>
                      )}
                      <span className="block truncate text-muted-foreground">{resource.code}</span>
                    </th>
                    {contractRuns(row.cells).map((run) =>
                      run.contract ? (
                        <ContractRunCell
                          key={run.start}
                          run={run}
                          booking={run.contract}
                          timeZone={timeZone}
                          clientId={filters.client}
                          clientNames={clientNames}
                        />
                      ) : (
                        <DayCell
                          key={run.start}
                          cell={run.cells[0]}
                          filters={filters}
                          clientName={clientName}
                        />
                      ),
                    )}
                    <td className="border-l border-border px-2 py-1.5 text-right font-medium">
                      {row.total.percent === null ? (
                        <>
                          <span aria-hidden>–</span>
                          <span className="sr-only">aucune heure d’ouverture</span>
                        </>
                      ) : (
                        `${row.total.percent} %`
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  )
}

function DayCell({
  cell,
  filters,
  clientName,
}: {
  cell: MonthCell
  filters: PlanningFilters
  clientName?: string
}) {
  return (
    <td
      className={`relative h-10 border-l border-border p-0 text-center ${occupancyLevelStyles[cell.level]}`}
    >
      <span aria-hidden>{occupancyCellText(cell)}</span>
      <span className="sr-only">
        {occupancyCellDescription(cell)}
        {cell.clientPresent && clientName ? `, dont ${clientName}` : ''}
      </span>
      {cell.clientPresent && (
        // Une marque, et non une teinte : le client se repère sans la couleur.
        <span
          aria-hidden
          className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-statut-confirme ring-1 ring-white"
        />
      )}
      {/* Le clic mène à la vue jour. Hors tabulation : l'en-tête de la colonne
          y mène déjà, au clavier comme au lecteur d'écran. */}
      <Link
        href={planningHref('jour', { ...filters, date: cell.isoDate })}
        tabIndex={-1}
        aria-hidden
        className="absolute inset-0 transition-colors duration-150 ease-out hover:bg-foreground/5"
      />
    </td>
  )
}

/** Jours consécutifs d'une même occupation de contrat, en une case. */
function ContractRunCell({
  run,
  booking,
  timeZone,
  clientId,
  clientNames,
}: {
  run: CellRun<MonthCell>
  booking: GridBooking
  timeZone: string
  clientId?: string
  clientNames: Record<string, string>
}) {
  const focus = bookingFocus(booking, clientId)
  const tenant = booking.clientId ? clientNames[booking.clientId] : undefined
  const description = `Occupé — contrat ${contractReference(booking)}${tenant ? `, ${tenant}` : ''}, ${occupationPeriodLabel(booking, timeZone)}`
  // Assez de place pour écrire la référence à partir de trois jours.
  const text =
    focus === 'autre' ? 'Occupé' : run.span >= 3 ? `Contrat ${contractReference(booking)}` : 'C'
  return (
    <td colSpan={run.span} className="border-l border-border p-0.5">
      <Link
        href={bookingHref(booking)}
        title={description}
        className={`flex h-9 items-center justify-center overflow-hidden rounded-sm border-l-2 px-1 hover:brightness-95 ${focusRing} ${bookingBlockClass(booking, focus)}`}
      >
        <span aria-hidden className="truncate font-medium">
          {text}
        </span>
        <span className="sr-only">
          {focus === 'autre' ? 'Occupé par un autre client' : description}
        </span>
      </Link>
    </td>
  )
}

function Legend({ clientName }: { clientName?: string }) {
  const swatch = 'inline-block h-3 w-4 rounded-sm ring-1 ring-border'
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span>En % des heures d’ouverture :</span>
      <span className="flex items-center gap-1">
        <span aria-hidden className={`${swatch} bg-statut-disponible`} /> 0 libre
      </span>
      <span className="flex items-center gap-1">
        <span aria-hidden className={`${swatch} bg-statut-reserve/15`} /> moins de 50
      </span>
      <span className="flex items-center gap-1">
        <span aria-hidden className={`${swatch} bg-statut-reserve/40`} /> 50 à 99
      </span>
      <span className="flex items-center gap-1">
        <span aria-hidden className={`${swatch} bg-statut-confirme`} /> 100 complet
      </span>
      <span className="flex items-center gap-1">
        <span aria-hidden className={`${swatch} bg-statut-confirme/15`} /> C sous contrat
      </span>
      <span>– fermé · hors : réservé un jour de fermeture</span>
      {clientName && (
        <span className="flex items-center gap-1">
          <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-statut-confirme" />{' '}
          {clientName} occupe la ressource ce jour-là
        </span>
      )}
    </p>
  )
}
