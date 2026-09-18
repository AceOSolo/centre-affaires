import Link from 'next/link'

import {
  addDaysToIsoDate,
  formatDuration,
  formatLongDate,
  formatTime,
  todayIsoDate,
} from '../../../lib/dates.ts'
import { currentTimeZone } from '../../../lib/tenant.ts'
import { DayPlanning } from '../../../modules/reservations/day-planning.tsx'
import {
  bookingStatusBadgeStyles,
  bookingStatusLabels,
} from '../../../modules/reservations/labels.ts'
import { listBookingsForDay } from '../../../modules/reservations/queries.ts'
import { listBookableResources } from '../../../modules/ressources/queries.ts'
import type { Resource } from '../../../modules/ressources/schema.ts'

export const metadata = { title: 'Planning' }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export default async function PlanningPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>
}) {
  const { date } = await searchParams
  const timeZone = await currentTimeZone()
  // Le jour du centre, pas celui du serveur : Vercel tourne en UTC (décision 4).
  const today = todayIsoDate(timeZone)
  const isoDate = date && ISO_DATE.test(date) ? date : today

  const [bookings, bookable] = await Promise.all([
    listBookingsForDay(isoDate, timeZone),
    listBookableResources(),
  ])

  // Une salle mise en maintenance après coup garde ses réservations : sa colonne
  // reste affichée tant qu'elle a quelque chose ce jour-là.
  const columns = mergeColumns(bookable, bookings.map((booking) => booking.resource))
  const occupying = bookings.filter((booking) => booking.status !== 'cancelled')
  const cancelled = bookings.filter((booking) => booking.status === 'cancelled')

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Planning</h1>
          <p className="mt-1 text-sm capitalize text-zinc-500 dark:text-zinc-400">
            {formatLongDate(isoDate, timeZone)}
          </p>
        </div>
        <Link
          href={`/reservations/nouvelle?date=${isoDate}`}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Nouvelle réservation
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <DayLink date={addDaysToIsoDate(isoDate, -1)} label="← Veille" />
        <DayLink date={today} label="Aujourd’hui" active={isoDate === today} />
        <DayLink date={addDaysToIsoDate(isoDate, 1)} label="Lendemain →" />
        {/* Formulaire GET : le saut à une date précise marche sans JavaScript. */}
        <form className="ml-auto flex items-center gap-2">
          <label htmlFor="date" className="text-xs text-zinc-500 dark:text-zinc-400">
            Aller au
          </label>
          <input
            id="date"
            name="date"
            type="date"
            defaultValue={isoDate}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Afficher
          </button>
        </form>
      </div>

      {columns.length === 0 ? (
        <EmptyState />
      ) : (
        <DayPlanning
          isoDate={isoDate}
          timeZone={timeZone}
          resources={columns}
          bookings={bookings}
        />
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight">
          Réservations du jour{' '}
          <span className="font-normal text-zinc-500 dark:text-zinc-400">
            ({occupying.length})
          </span>
        </h2>

        {bookings.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Rien de réservé ce jour-là.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Horaire</th>
                  <th className="px-4 py-3 font-medium">Ressource</th>
                  <th className="px-4 py-3 font-medium">Objet</th>
                  <th className="px-4 py-3 font-medium">État</th>
                  <th className="px-4 py-3 font-medium sr-only">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {[...occupying, ...cancelled].map((booking) => (
                  <tr key={booking.id} className={booking.status === 'cancelled' ? 'opacity-60' : ''}>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                      {formatTime(booking.startsAt, timeZone)} –{' '}
                      {formatTime(booking.endsAt, timeZone)}
                      <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                        {formatDuration(booking.startsAt, booking.endsAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      <span className="font-mono text-xs">{booking.resource.code}</span>{' '}
                      {booking.resource.name}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/reservations/${booking.id}`}
                        className={`underline-offset-2 hover:underline ${booking.status === 'cancelled' ? 'line-through' : 'font-medium'}`}
                      >
                        {booking.title}
                      </Link>
                      {booking.notes && (
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">
                          {booking.notes}
                        </div>
                      )}
                      {booking.cancellationReason && (
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">
                          Motif : {booking.cancellationReason}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${bookingStatusBadgeStyles[booking.status]}`}
                      >
                        {bookingStatusLabels[booking.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {/* L'annulation vit sur la page de détail, avec son motif :
                          un seul endroit pour libérer un créneau. */}
                      <Link
                        href={`/reservations/${booking.id}`}
                        className="text-xs text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400"
                      >
                        Détail
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

/** Colonnes du planning : les réservables, plus celles qui ont du monde ce jour-là. */
function mergeColumns(bookable: Resource[], booked: Resource[]): Resource[] {
  const byId = new Map(bookable.map((resource) => [resource.id, resource]))
  for (const resource of booked) {
    if (!byId.has(resource.id)) byId.set(resource.id, resource)
  }
  return [...byId.values()].sort(
    (a, b) => a.resourceType.localeCompare(b.resourceType) || a.code.localeCompare(b.code),
  )
}

function DayLink({ date, label, active }: { date: string; label: string; active?: boolean }) {
  return (
    <Link
      href={`/reservations?date=${date}`}
      aria-current={active ? 'date' : undefined}
      className={`rounded-md border px-3 py-1 text-sm ${
        active
          ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
          : 'border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800'
      }`}
    >
      {label}
    </Link>
  )
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 bg-white px-6 py-12 text-center dark:border-zinc-700 dark:bg-zinc-900">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Aucune ressource en service : le planning n’a rien à afficher.
      </p>
      <Link
        href="/ressources/nouvelle"
        className="mt-4 inline-block rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
      >
        Déclarer une ressource
      </Link>
    </div>
  )
}
