import Link from 'next/link'

import { resourceTypeLabels, weekdayLabels } from '../ressources/labels.ts'
import { isoWeekday } from '../ressources/ouverture.ts'
import type { Resource } from '../ressources/schema.ts'
import {
  bookingBlockClass,
  bookingFocus,
  bookingHref,
  bookingLabel,
  bookingSegmentClass,
  bookingTimeLabel,
  occupationPeriodLabel,
} from './affichage.ts'
import { groupByType, newBookingHref, planningHref, type PlanningFilters } from './filtres.ts'
import type { CellRun, GridBooking, WeekCell, WeekGridColumn, WeekRow } from './semaine-ressources.ts'
import { contractRuns } from './semaine-ressources.ts'

/** Réservations listées en toutes lettres dans une case, au-delà un renvoi au jour. */
const MAX_LISTED = 3

const focusRing =
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent'

const shortDate = (isoDate: string) => `${isoDate.slice(8)}/${isoDate.slice(5, 7)}`

/**
 * Semaine de toutes les ressources affichées (R03, ADR 017) : une ligne par
 * ressource, une colonne par jour, dans un vrai tableau.
 *
 * Chaque case montre d'un coup d'œil ce qui est pris — une barre sur
 * l'amplitude commune de la semaine — et le dit en toutes lettres : heures,
 * objet, état. Cliquer dans la case ouvre le formulaire de réservation
 * pré-rempli avec la ressource, le jour, le premier quart d'heure libre et le
 * client filtré. Au clavier, ce lien est le premier arrêt de la case.
 *
 * Les jours consécutifs couverts par un même contrat sont fusionnés en une
 * seule case : un bureau loué trois ans se lit en une ligne, pas en sept
 * répétitions de « Occupé ».
 */
export function WeekResources({
  rows,
  columns,
  today,
  timeZone,
  filters,
  extent,
  clientNames,
}: {
  rows: WeekRow<Resource>[]
  columns: WeekGridColumn[]
  today: string
  timeZone: string
  filters: PlanningFilters
  extent: { openHour: number; closeHour: number }
  /** Noms des clients, pour nommer le locataire d'une occupation. */
  clientNames: Record<string, string>
}) {
  const groups = groupByType(rows.map((row) => row.resource))
  const rowById = new Map(rows.map((row) => [row.resource.id, row]))

  return (
    <div className="flex flex-col gap-2">
      <Legend extent={extent} clientFiltered={Boolean(filters.client)} />
      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table className="w-full min-w-[60rem] table-fixed border-collapse text-left text-xs">
          <caption className="sr-only">
            Semaine du {shortDate(columns[0].isoDate)} au {shortDate(columns[6].isoDate)} : une
            ligne par ressource, une colonne par jour. Chaque case liste les réservations et
            propose d’en créer une.
          </caption>
          <colgroup>
            <col className="w-44" />
            {columns.map((column) => (
              <col key={column.isoDate} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-border">
              <th
                scope="col"
                className="sticky left-0 z-20 bg-white px-3 py-2 text-xs font-medium text-muted-foreground"
              >
                Ressource
              </th>
              {columns.map((column) => {
                const isToday = column.isoDate === today
                return (
                  <th
                    key={column.isoDate}
                    scope="col"
                    className={`border-l border-border px-2 py-2 font-medium ${isToday ? 'bg-accent/10' : ''}`}
                  >
                    <Link
                      href={planningHref('jour', { ...filters, date: column.isoDate })}
                      className={`inline-block rounded-sm py-0.5 text-sm underline-offset-2 hover:underline ${focusRing}`}
                    >
                      {weekdayLabels[column.weekday]}{' '}
                      <span className="tabular">{shortDate(column.isoDate)}</span>
                    </Link>
                    {isToday && (
                      <span className="block text-xs font-normal text-muted-foreground">
                        aujourd’hui
                      </span>
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.type} className="border-b border-border last:border-b-0">
              {!filters.type && (
                <tr className="bg-muted">
                  <th
                    scope="rowgroup"
                    colSpan={columns.length + 1}
                    className="px-3 py-1.5 text-xs font-semibold tracking-tight text-foreground"
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
                      className="sticky left-0 z-10 bg-white px-3 py-2 align-top font-normal"
                    >
                      <Link
                        href={planningHref('semaine', {
                          ...filters,
                          date: columns[0].isoDate,
                          ressource: resource.id,
                        })}
                        className={`block truncate rounded-sm py-0.5 text-sm font-medium underline-offset-2 hover:underline ${focusRing}`}
                      >
                        {resource.name}
                        <span className="sr-only"> — semaine détaillée</span>
                      </Link>
                      <span className="block truncate text-muted-foreground">
                        {resource.code}
                        {resource.capacity ? ` · ${resource.capacity} pers.` : ''}
                        {resource.status !== 'active' && ' · hors service'}
                      </span>
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
                          resource={resource}
                          isToday={run.cells[0].isoDate === today}
                          timeZone={timeZone}
                          filters={filters}
                        />
                      ),
                    )}
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

/** Barre d'occupation d'une case : ouverture en blanc, fermeture en gris. */
function OccupancyBar({ cell, clientId }: { cell: WeekCell; clientId?: string }) {
  return (
    <div aria-hidden className="relative h-2 overflow-hidden rounded-full bg-statut-annule ring-1 ring-border">
      {cell.opening.map((segment) => (
        <div
          key={segment.leftPercent}
          className="absolute inset-y-0 bg-statut-disponible"
          style={{ left: `${segment.leftPercent}%`, width: `${segment.widthPercent}%` }}
        />
      ))}
      {cell.segments.map((segment) => (
        <div
          key={segment.booking.id}
          className={`absolute inset-y-0 ${bookingSegmentClass(segment.booking, bookingFocus(segment.booking, clientId))}`}
          style={{ left: `${segment.leftPercent}%`, width: `${segment.widthPercent}%` }}
        />
      ))}
    </div>
  )
}

function DayCell({
  cell,
  resource,
  isToday,
  timeZone,
  filters,
}: {
  cell: WeekCell
  resource: Resource
  isToday: boolean
  timeZone: string
  filters: PlanningFilters
}) {
  const listed = cell.bookings.slice(0, MAX_LISTED)
  const more = cell.bookings.length - listed.length
  const jour = `${weekdayLabels[isoWeekday(cell.isoDate)].toLocaleLowerCase('fr-FR')} ${shortDate(cell.isoDate)}`

  return (
    <td
      className={`relative border-l border-border p-0 align-top ${isToday ? 'bg-accent/5' : ''}`}
    >
      {/* La case entière est le lien de réservation ; les réservations
          listées sont des liens à part, posés au-dessus. */}
      {!cell.full && (
        <Link
          href={newBookingHref({
            date: cell.isoDate,
            resourceId: resource.id,
            start: cell.firstFree,
            client: filters.client,
          })}
          aria-label={`Réserver ${resource.name} le ${jour}${cell.firstFree ? ` à ${cell.firstFree}` : ''}${cell.closed ? ' (jour fermé)' : ''}`}
          className={`absolute inset-0 transition-colors duration-150 ease-out hover:bg-muted ${focusRing}`}
        />
      )}
      <div className="pointer-events-none relative flex min-h-16 flex-col gap-1 p-1.5">
        <OccupancyBar cell={cell} clientId={filters.client} />
        {listed.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {listed.map((booking) => (
              <li key={booking.id}>
                <BookingChip
                  booking={booking}
                  isoDate={cell.isoDate}
                  timeZone={timeZone}
                  clientId={filters.client}
                />
              </li>
            ))}
            {more > 0 && (
              <li>
                <Link
                  href={planningHref('jour', { ...filters, date: cell.isoDate })}
                  className={`pointer-events-auto inline-block rounded-sm py-1 text-muted-foreground underline underline-offset-2 ${focusRing}`}
                >
                  et {more} autre{more > 1 ? 's' : ''}
                </Link>
              </li>
            )}
          </ul>
        )}
        {cell.bookings.length === 0 && (
          <span className="text-muted-foreground">{cell.closed ? 'Fermé' : 'Libre'}</span>
        )}
        {cell.full && <span className="font-medium text-foreground">Complet</span>}
      </div>
    </td>
  )
}

/** Une réservation dans une case : heure, objet, état écrit. */
function BookingChip({
  booking,
  isoDate,
  timeZone,
  clientId,
}: {
  booking: GridBooking
  isoDate: string
  timeZone: string
  clientId?: string
}) {
  const focus = bookingFocus(booking, clientId)
  const label = focus === 'autre' ? 'Occupé' : bookingLabel(booking)
  return (
    <Link
      href={bookingHref(booking)}
      title={`${bookingTimeLabel(booking, isoDate, timeZone)} · ${label}`}
      className={`pointer-events-auto block truncate rounded-sm border-l-2 px-1 py-1 hover:brightness-95 ${focusRing} ${bookingBlockClass(booking, focus)}`}
    >
      <span className="tabular">{bookingTimeLabel(booking, isoDate, timeZone)}</span> {label}
      {booking.status === 'pending' && focus !== 'autre' && (
        <span className="font-medium"> · à valider</span>
      )}
    </Link>
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
  run: CellRun<WeekCell>
  booking: GridBooking
  timeZone: string
  clientId?: string
  clientNames: Record<string, string>
}) {
  const focus = bookingFocus(booking, clientId)
  const tenant = booking.clientId ? clientNames[booking.clientId] : undefined
  return (
    <td colSpan={run.span} className="border-l border-border p-1.5 align-top">
      <Link
        href={bookingHref(booking)}
        className={`flex min-h-14 flex-col justify-center gap-0.5 rounded-sm border-l-4 px-2 py-1 hover:brightness-95 ${focusRing} ${bookingBlockClass(booking, focus)}`}
      >
        <span className="truncate font-medium">
          {focus === 'autre' ? 'Occupé' : bookingLabel(booking)}
          {focus !== 'autre' && tenant && <span className="font-normal"> · {tenant}</span>}
        </span>
        <span className="truncate text-muted-foreground">
          {occupationPeriodLabel(booking, timeZone)}
        </span>
      </Link>
    </td>
  )
}

/** Clé de lecture : chaque teinte a son mot. */
function Legend({
  extent,
  clientFiltered,
}: {
  extent: { openHour: number; closeHour: number }
  clientFiltered: boolean
}) {
  const swatch = 'inline-block h-2 w-4 rounded-full ring-1 ring-border'
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span>
        Barres de {extent.openHour} h à {extent.closeHour} h :
      </span>
      <span className="flex items-center gap-1">
        <span aria-hidden className={`${swatch} bg-statut-confirme`} /> confirmée ou sous contrat
      </span>
      <span className="flex items-center gap-1">
        <span aria-hidden className={`${swatch} bg-statut-reserve`} /> à valider
      </span>
      <span className="flex items-center gap-1">
        <span aria-hidden className={`${swatch} bg-muted-foreground/60`} /> indisponible
      </span>
      {clientFiltered && (
        <span className="flex items-center gap-1">
          <span aria-hidden className={`${swatch} bg-muted-foreground/40`} /> autre client
        </span>
      )}
      <span className="flex items-center gap-1">
        <span aria-hidden className={`${swatch} bg-statut-annule`} /> fermé
      </span>
    </p>
  )
}
