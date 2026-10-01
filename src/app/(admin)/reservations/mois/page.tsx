import Link from 'next/link'

import { requirePermission } from '../../../../lib/auth/staff.ts'
import { addMonthsToIsoMonth, formatIsoMonth, todayIsoDate } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { listClients } from '../../../../modules/clients/queries.ts'
import {
  filterBookings,
  parsePlanningFilters,
  planningDate,
  planningResources,
  type SearchParam,
} from '../../../../modules/reservations/filtres.ts'
import { monthDays, monthOfDate, monthResourceRows } from '../../../../modules/reservations/mois.ts'
import { MonthPlanning } from '../../../../modules/reservations/month-planning.tsx'
import { PlanningToolbar } from '../../../../modules/reservations/planning-toolbar.tsx'
import { listBookingsBetween } from '../../../../modules/reservations/queries.ts'
import { loadOpeningContext } from '../../../../modules/ressources/ouverture-queries.ts'
import { openingWindows, type TimeRange } from '../../../../modules/ressources/ouverture.ts'
import { listBookableResources } from '../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Mois' }

/**
 * Vue mois (R03, décision D2 de l'ADR 016, ADR 017) : le taux d'occupation de
 * chaque ressource, jour par jour, rapporté à ses heures d'ouverture.
 */
export default async function MonthPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: SearchParam; type?: SearchParam; client?: SearchParam }>
}) {
  await requirePermission('reservations.gerer')
  const params = await searchParams
  const timeZone = await currentTimeZone()
  const today = todayIsoDate(timeZone)
  const anchor = planningDate(params.date, today)
  const month = monthOfDate(anchor)
  const days = monthDays(month)
  const first = days[0]
  const last = days[days.length - 1]

  const [allBookings, bookable, contexte, clients] = await Promise.all([
    listBookingsBetween(first, last, timeZone),
    listBookableResources(),
    loadOpeningContext(first, last),
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
  const bookings = filterBookings(allBookings, new Set(resources.map((resource) => resource.id)))

  const openingByResource: Record<string, Record<string, TimeRange[]>> = Object.fromEntries(
    resources.map((resource) => [
      resource.id,
      Object.fromEntries(
        days.map((day) => [
          day,
          openingWindows(day, timeZone, {
            rules: contexte.rules,
            closures: contexte.closures,
            resourceId: resource.id,
          }),
        ]),
      ),
    ]),
  )
  const rows = monthResourceRows({
    resources,
    days,
    bookings,
    openingByResource,
    timeZone,
    clientId: filters.client,
  })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Mois</h1>
          <p className="mt-1 text-sm capitalize text-muted-foreground">{formatIsoMonth(month)}</p>
        </div>
      </div>

      <PlanningToolbar
        view="mois"
        date={anchor}
        filters={filters}
        clients={clients.map((client) => ({ id: client.id, name: client.name }))}
        previous={{ date: `${addMonthsToIsoMonth(month, -1)}-01`, label: 'Mois précédent' }}
        current={{ date: today, label: 'Ce mois-ci', active: monthOfDate(today) === month }}
        next={{ date: `${addMonthsToIsoMonth(month, 1)}-01`, label: 'Mois suivant' }}
      />

      {resources.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {filters.type
              ? 'Aucune ressource de ce type en service : choisissez un autre type, ou déclarez-en une.'
              : 'Aucune ressource en service : il n’y a pas de mois à afficher.'}
          </p>
          <Link
            href="/ressources/nouvelle"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Déclarer une ressource
          </Link>
        </div>
      ) : (
        <MonthPlanning
          rows={rows}
          days={days}
          today={today}
          timeZone={timeZone}
          filters={filters}
          clientNames={Object.fromEntries(clients.map((client) => [client.id, client.name]))}
        />
      )}
    </div>
  )
}
