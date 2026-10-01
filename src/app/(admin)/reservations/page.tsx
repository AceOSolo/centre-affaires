import Link from 'next/link'

import {
  addDaysToIsoDate,
  formatDuration,
  formatLongDate,
  formatTime,
  todayIsoDate,
} from '../../../lib/dates.ts'
import { currentTimeZone } from '../../../lib/tenant.ts'
import { listClients } from '../../../modules/clients/queries.ts'
import {
  bookingHref,
  bookingLabel,
  bookingStateLabel,
  isContractOccupation,
  occupationPeriodLabel,
} from '../../../modules/reservations/affichage.ts'
import { DayPlanning } from '../../../modules/reservations/day-planning.tsx'
import {
  filterBookings,
  newBookingHref,
  parsePlanningFilters,
  planningDate,
  planningResources,
  type SearchParam,
} from '../../../modules/reservations/filtres.ts'
import { bookingStatusBadgeStyles } from '../../../modules/reservations/labels.ts'
import { PlanningToolbar } from '../../../modules/reservations/planning-toolbar.tsx'
import { listBookingsForDay } from '../../../modules/reservations/queries.ts'
import { loadOpeningContext } from '../../../modules/ressources/ouverture-queries.ts'
import { openingWindows, type TimeRange } from '../../../modules/ressources/ouverture.ts'
import { listBookableResources } from '../../../modules/ressources/queries.ts'

export const metadata = { title: 'Planning' }

export default async function PlanningPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: SearchParam; type?: SearchParam; client?: SearchParam }>
}) {
  const params = await searchParams
  const timeZone = await currentTimeZone()
  // Le jour du centre, pas celui du serveur : Vercel tourne en UTC (décision 4).
  const today = todayIsoDate(timeZone)
  const isoDate = planningDate(params.date, today)

  const [allBookings, bookable, contexte, clients] = await Promise.all([
    listBookingsForDay(isoDate, timeZone),
    listBookableResources(),
    loadOpeningContext(isoDate, isoDate),
    listClients(),
  ])
  const filters = parsePlanningFilters(
    params,
    clients.map((client) => client.id),
  )
  const clientName = clients.find((client) => client.id === filters.client)?.name

  // Une salle mise en maintenance après coup garde ses réservations : sa colonne
  // reste affichée tant qu'elle a quelque chose ce jour-là.
  const columns = planningResources(
    bookable,
    allBookings.map((booking) => booking.resource),
    filters,
  )
  const bookings = filterBookings(allBookings, new Set(columns.map((resource) => resource.id)))
  // La liste se restreint au client filtré ; le planning, lui, garde les
  // créneaux des autres, réduits à « Occupé ».
  const listed = filters.client
    ? bookings.filter((booking) => booking.clientId === filters.client)
    : bookings
  const occupying = listed.filter((booking) => booking.status !== 'cancelled')
  const cancelled = listed.filter((booking) => booking.status === 'cancelled')

  // Les heures d'ouverture sont résolues par ressource : une salle peut avoir
  // les siennes, et une fermeture exceptionnelle peut ne viser qu'elle.
  const opening: Record<string, TimeRange[]> = Object.fromEntries(
    columns.map((resource) => [
      resource.id,
      openingWindows(isoDate, timeZone, {
        rules: contexte.rules,
        closures: contexte.closures,
        resourceId: resource.id,
      }),
    ]),
  )
  const fermePartout = columns.length > 0 && columns.every((r) => opening[r.id].length === 0)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Planning</h1>
          <p className="mt-1 text-sm capitalize text-muted-foreground">
            {formatLongDate(isoDate, timeZone)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/reservations/en-masse" className="rounded-md border border-primary px-4 py-2 text-sm font-medium text-primary hover:bg-white">
            Ajouter en masse
          </Link>
          <Link
            href={
              filters.client
                ? `/reservations/nouvelle?date=${isoDate}&clientId=${filters.client}`
                : `/reservations/nouvelle?date=${isoDate}`
            }
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Nouvelle réservation
          </Link>
        </div>
      </div>

      <PlanningToolbar
        view="jour"
        date={isoDate}
        filters={filters}
        clients={clients.map((client) => ({ id: client.id, name: client.name }))}
        previous={{ date: addDaysToIsoDate(isoDate, -1), label: 'Veille' }}
        current={{ date: today, label: 'Aujourd’hui', active: isoDate === today }}
        next={{ date: addDaysToIsoDate(isoDate, 1), label: 'Lendemain' }}
      />

      {columns.length === 0 ? (
        <EmptyState filtered={Boolean(filters.type)} />
      ) : (
        <>
          {fermePartout && (
            <p className="rounded-md border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
              Centre fermé ce jour-là. Une réservation reste possible, elle sera
              simplement hors des heures d’ouverture.{' '}
              <Link href="/disponibilites" className="underline underline-offset-2">
                Modifier les horaires
              </Link>
            </p>
          )}
          <DayPlanning
            isoDate={isoDate}
            timeZone={timeZone}
            resources={columns}
            bookings={bookings}
            opening={opening}
            clientId={filters.client}
          />
        </>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight">
          {clientName ? `Réservations du jour — ${clientName}` : 'Réservations du jour'}{' '}
          <span className="font-normal text-muted-foreground">
            ({occupying.length})
          </span>
        </h2>

        {listed.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {clientName ? `Rien de réservé pour ${clientName} ce jour-là. ` : 'Rien de réservé ce jour-là. '}
            {columns[0] && (
              <Link
                href={newBookingHref({
                  date: isoDate,
                  resourceId: columns[0].id,
                  client: filters.client,
                })}
                className="underline underline-offset-2"
              >
                Poser une réservation
              </Link>
            )}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Horaire</th>
                  <th className="px-4 py-3 font-medium">Ressource</th>
                  <th className="px-4 py-3 font-medium">Objet</th>
                  <th className="px-4 py-3 font-medium">État</th>
                  <th className="px-4 py-3 font-medium sr-only">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {[...occupying, ...cancelled].map((booking) => {
                  // Une occupation de contrat couvre des journées entières,
                  // parfois sans terme : on dit sa période, pas « 00:00 – 00:00 »,
                  // et elle se gère depuis son contrat (ADR 018).
                  const contrat = isContractOccupation(booking)
                  return (
                    <tr key={booking.id} className={booking.status === 'cancelled' ? 'opacity-60' : ''}>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                        {contrat ? (
                          <>
                            Toute la journée
                            <span className="block text-xs text-muted-foreground">
                              {occupationPeriodLabel(booking, timeZone)}
                            </span>
                          </>
                        ) : (
                          <>
                            {formatTime(booking.startsAt, timeZone)} –{' '}
                            {formatTime(booking.endsAt, timeZone)}
                            <span className="ml-2 text-xs text-muted-foreground">
                              {formatDuration(booking.startsAt, booking.endsAt)}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        <span className="text-xs">{booking.resource.code}</span>{' '}
                        {booking.resource.name}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={bookingHref(booking)}
                          className={`underline-offset-2 hover:underline ${booking.status === 'cancelled' ? 'line-through' : 'font-medium'}`}
                        >
                          {bookingLabel(booking)}
                        </Link>
                        {booking.notes && (
                          <div className="text-xs text-muted-foreground">
                            {booking.notes}
                          </div>
                        )}
                        {booking.cancellationReason && (
                          <div className="text-xs text-muted-foreground">
                            Motif : {booking.cancellationReason}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${bookingStatusBadgeStyles[booking.status]}`}
                        >
                          {bookingStateLabel(booking)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {/* L'annulation vit sur la page de détail, avec son motif :
                            un seul endroit pour libérer un créneau. Celle d'une
                            occupation passe par son contrat. */}
                        <Link
                          href={bookingHref(booking)}
                          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                        >
                          {contrat ? 'Contrat' : 'Détail'}
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
      <p className="text-sm text-muted-foreground">
        {filtered
          ? 'Aucune ressource de ce type en service : choisissez un autre type, ou déclarez-en une.'
          : 'Aucune ressource en service : le planning n’a rien à afficher.'}
      </p>
      <Link
        href="/ressources/nouvelle"
        className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
      >
        Déclarer une ressource
      </Link>
    </div>
  )
}
