import Link from 'next/link'

import { requirePermission } from '../../../../lib/auth/staff.ts'
import { addDaysToIsoDate, formatLongDate, todayIsoDate } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { listClients } from '../../../../modules/clients/queries.ts'
import {
  filterBookings,
  firstParam,
  parsePlanningFilters,
  planningDate,
  planningHref,
  planningResources,
  type SearchParam,
} from '../../../../modules/reservations/filtres.ts'
import { PlanningToolbar } from '../../../../modules/reservations/planning-toolbar.tsx'
import { listBookingsBetween } from '../../../../modules/reservations/queries.ts'
import { weekColumns, weekDays, weekExtent, weekStart } from '../../../../modules/reservations/semaine.ts'
import {
  weekGridColumns,
  weekResourceRows,
} from '../../../../modules/reservations/semaine-ressources.ts'
import { WeekPlanning } from '../../../../modules/reservations/week-planning.tsx'
import { WeekResources } from '../../../../modules/reservations/week-resources.tsx'
import { loadOpeningContext } from '../../../../modules/ressources/ouverture-queries.ts'
import { openingWindows, type TimeRange } from '../../../../modules/ressources/ouverture.ts'
import { resourceTypeLabels } from '../../../../modules/ressources/labels.ts'
import { listBookableResources } from '../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Semaine' }

/**
 * Vue semaine (R03, ADR 017).
 *
 * Par défaut, toutes les ressources du type filtré : une ligne par ressource,
 * une case par jour. Avec `ressource`, la semaine détaillée d'une seule
 * ressource, graduée heure par heure (ADR 011) — on y arrive en cliquant le
 * nom d'une ligne.
 */
export default async function WeekPage({
  searchParams,
}: {
  searchParams: Promise<{
    date?: SearchParam
    type?: SearchParam
    client?: SearchParam
    ressource?: SearchParam
  }>
}) {
  await requirePermission('reservations.gerer')
  const params = await searchParams
  const timeZone = await currentTimeZone()
  const today = todayIsoDate(timeZone)
  const anchor = planningDate(params.date, today)
  const jours = weekDays(anchor)
  const lundi = weekStart(anchor)

  const [allBookings, bookable, contexte, clients] = await Promise.all([
    listBookingsBetween(jours[0], jours[6], timeZone),
    listBookableResources(),
    loadOpeningContext(jours[0], jours[6]),
    listClients(),
  ])
  const filters = parsePlanningFilters(
    params,
    clients.map((client) => client.id),
  )
  const resources = planningResources(
    bookable,
    allBookings.map((booking) => booking.resource),
    filters,
  )
  const resource = resources.find((candidate) => candidate.id === firstParam(params.ressource))
  const bookings = filterBookings(allBookings, new Set(resources.map((candidate) => candidate.id)))

  // Les horaires sont résolus ressource par ressource : chacune peut avoir les
  // siens, et une fermeture exceptionnelle peut ne viser qu'elle.
  const openingByResource: Record<string, Record<string, TimeRange[]>> = Object.fromEntries(
    resources.map((candidate) => [
      candidate.id,
      Object.fromEntries(
        jours.map((jour) => [
          jour,
          openingWindows(jour, timeZone, {
            rules: contexte.rules,
            closures: contexte.closures,
            resourceId: candidate.id,
          }),
        ]),
      ),
    ]),
  )

  const toolbar = (
    <PlanningToolbar
      view="semaine"
      date={anchor}
      filters={filters}
      clients={clients.map((client) => ({ id: client.id, name: client.name }))}
      ressource={resource?.id}
      previous={{ date: addDaysToIsoDate(lundi, -7), label: 'Semaine précédente' }}
      current={{ date: today, label: 'Cette semaine', active: weekStart(today) === lundi }}
      next={{ date: addDaysToIsoDate(lundi, 7), label: 'Semaine suivante' }}
    />
  )

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {resource ? `Semaine — ${resource.name}` : 'Semaine'}
        </h1>
        <p className="mt-1 text-sm capitalize text-muted-foreground">
          {formatLongDate(jours[0], timeZone)} → {formatLongDate(jours[6], timeZone)}
        </p>
        {resource && (
          <p className="mt-1 text-sm text-muted-foreground">
            {resource.code} · {resourceTypeLabels[resource.resourceType]} ·{' '}
            <Link
              href={planningHref('semaine', { ...filters, date: anchor })}
              className="underline underline-offset-2"
            >
              Toutes les ressources
            </Link>
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href="/reservations/en-masse" className="rounded-md border border-primary px-4 py-2 text-sm font-medium text-primary hover:bg-white">Ajouter en masse</Link>
      </div>
    </div>
  )

  if (resources.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        {toolbar}
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {filters.type
              ? 'Aucune ressource de ce type en service : choisissez un autre type, ou déclarez-en une.'
              : 'Aucune ressource en service : il n’y a pas de semaine à afficher.'}
          </p>
          <Link
            href="/ressources/nouvelle"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Déclarer une ressource
          </Link>
        </div>
      </div>
    )
  }

  if (resource) {
    const opening = openingByResource[resource.id]
    const extent = weekExtent(Object.values(opening).flat(), timeZone)
    return (
      <div className="flex flex-col gap-6">
        {header}
        {toolbar}
        <WeekPlanning
          resource={resource}
          timeZone={timeZone}
          columns={weekColumns(anchor, timeZone, extent, opening)}
          bookings={bookings}
          opening={opening}
          today={today}
          filters={filters}
        />
      </div>
    )
  }

  // Une amplitude pour toute la grille : les barres de deux cases désignent
  // les mêmes heures, ce qui rend la comparaison possible d'un coup d'œil.
  const extent = weekExtent(
    Object.values(openingByResource).flatMap((parJour) => Object.values(parJour).flat()),
    timeZone,
  )
  const columns = weekGridColumns(jours, timeZone, extent)
  const rows = weekResourceRows({ resources, columns, bookings, openingByResource, timeZone })

  return (
    <div className="flex flex-col gap-6">
      {header}
      {toolbar}
      <WeekResources
        rows={rows}
        columns={columns}
        today={today}
        timeZone={timeZone}
        filters={filters}
        extent={extent}
        clientNames={Object.fromEntries(clients.map((client) => [client.id, client.name]))}
      />
    </div>
  )
}
