import Link from 'next/link'

import { formatTime, toWallClock } from '../../lib/dates.ts'
import { resourceTypeLabels } from '../ressources/labels.ts'
import type { Resource } from '../ressources/schema.ts'
import { bookingBlockStyles, bookingStatusLabels } from './labels.ts'
import { blockGeometry, hourTicks, planningHeightPx, planningWindow } from './planning.ts'
import type { BookingWithResource } from './queries.ts'

const COLUMN_WIDTH = 'w-56'

/**
 * Planning d'une journée : une colonne par ressource, une graduation par heure.
 *
 * Seules les réservations qui occupent la ressource sont posées sur la grille.
 * Les annulées ne sont pas dessinées — elles ne bloquent plus le créneau, et les
 * superposer masquerait la réservation qui a pris leur place. Le tableau sous le
 * planning en garde la trace.
 *
 * Les positions viennent de `planning.ts`, calculées sur des instants : le jour
 * d'un changement d'heure, la journée ne fait pas 24 heures (décision 4).
 */
export function DayPlanning({
  isoDate,
  timeZone,
  resources,
  bookings,
}: {
  isoDate: string
  timeZone: string
  resources: Resource[]
  bookings: BookingWithResource[]
}) {
  const occupying = bookings.filter((booking) => booking.status !== 'cancelled')
  const window = planningWindow(isoDate, timeZone, occupying)
  const ticks = hourTicks(window)
  const height = planningHeightPx(window)

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex min-w-max">
        <div className="sticky left-0 z-20 w-16 shrink-0 border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="h-12 border-b border-zinc-200 dark:border-zinc-800" />
          <div className="relative" style={{ height }}>
            {ticks.slice(0, -1).map((tick) => (
              <div
                key={tick.instant.toISOString()}
                className="absolute right-2 -translate-y-1/2 text-xs tabular-nums text-zinc-400 dark:text-zinc-500"
                style={{ top: `${tick.offsetPercent}%` }}
              >
                {formatTime(tick.instant, timeZone)}
              </div>
            ))}
          </div>
        </div>

        {resources.map((resource) => (
          <div
            key={resource.id}
            className={`${COLUMN_WIDTH} shrink-0 border-r border-zinc-200 last:border-r-0 dark:border-zinc-800`}
          >
            <div className="h-12 truncate border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
              <div className="truncate text-sm font-medium">{resource.name}</div>
              <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                {resource.code} · {resourceTypeLabels[resource.resourceType]}
              </div>
            </div>

            <div className="relative" style={{ height }}>
              {ticks.map((tick, index) => (
                <div
                  key={tick.instant.toISOString()}
                  aria-hidden
                  className="absolute inset-x-0 border-t border-zinc-100 dark:border-zinc-800/70"
                  style={{ top: `${tick.offsetPercent}%` }}
                  data-last={index === ticks.length - 1 || undefined}
                />
              ))}

              {/* Une bande cliquable par heure : le créneau de départ est
                  pré-rempli, le staff n'a plus qu'à ajuster la fin. */}
              {ticks.slice(0, -1).map((tick, index) => {
                const startTime = toWallClock(tick.instant, timeZone).slice(11, 16)
                return (
                  <Link
                    key={tick.instant.toISOString()}
                    href={`/reservations/nouvelle?date=${isoDate}&resourceId=${resource.id}&start=${startTime}`}
                    aria-label={`Réserver ${resource.name} à ${formatTime(tick.instant, timeZone)}`}
                    className="absolute inset-x-0 hover:bg-zinc-100/70 dark:hover:bg-zinc-800/50"
                    style={{
                      top: `${tick.offsetPercent}%`,
                      height: `${ticks[index + 1].offsetPercent - tick.offsetPercent}%`,
                    }}
                  />
                )
              })}

              {occupying
                .filter((booking) => booking.resourceId === resource.id)
                .map((booking) => {
                  const geometry = blockGeometry(booking, window)
                  if (!geometry) return null
                  const status = booking.status as Exclude<typeof booking.status, 'cancelled'>
                  return (
                    <Link
                      key={booking.id}
                      href={`/reservations/${booking.id}`}
                      className={`absolute inset-x-1 z-10 block overflow-hidden rounded border-l-4 px-2 py-1 text-xs shadow-sm hover:brightness-95 ${bookingBlockStyles[status]}`}
                      style={{
                        top: `${geometry.topPercent}%`,
                        height: `${geometry.heightPercent}%`,
                      }}
                    >
                      <div className="truncate font-medium">{booking.title}</div>
                      <div className="truncate tabular-nums opacity-80">
                        {formatTime(booking.startsAt, timeZone)} –{' '}
                        {formatTime(booking.endsAt, timeZone)}
                      </div>
                      {/* Le statut est écrit, pas seulement coloré (ADR 004). */}
                      {status === 'pending' && (
                        <div className="truncate opacity-80">{bookingStatusLabels.pending}</div>
                      )}
                    </Link>
                  )
                })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
