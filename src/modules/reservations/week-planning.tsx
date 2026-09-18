import Link from 'next/link'

import { formatTime, toWallClock } from '../../lib/dates.ts'
import { weekdayLabels } from '../ressources/labels.ts'
import type { TimeRange } from '../ressources/ouverture.ts'
import type { Resource } from '../ressources/schema.ts'
import { bookingBlockStyles, bookingStatusLabels } from './labels.ts'
import { blockGeometry, hourTicks, planningHeightPx } from './planning.ts'
import type { BookingWithResource } from './queries.ts'
import type { WeekColumn } from './semaine.ts'

/**
 * Semaine d'une ressource : sept colonnes, une graduation commune.
 *
 * Répond à la question que la vue jour ne sait pas traiter — « quand cette
 * salle est-elle libre cette semaine ». Les colonnes partagent la même
 * amplitude murale pour être comparables d'un coup d'œil, mais chacune garde
 * sa fenêtre en instants, ce qui reste juste au changement d'heure.
 */
export function WeekPlanning({
  resource,
  timeZone,
  columns,
  bookings,
  opening,
  today,
}: {
  resource: Resource
  timeZone: string
  columns: WeekColumn[]
  bookings: BookingWithResource[]
  /** Plages d'ouverture, par jour ISO. */
  opening: Record<string, TimeRange[]>
  today: string
}) {
  const occupying = bookings.filter((booking) => booking.status !== 'cancelled')
  // La graduation vient de la première colonne : toutes ont la même amplitude
  // murale, donc le même nombre d'heures.
  const ticks = hourTicks(columns[0].window)
  const height = planningHeightPx(columns[0].window, 44)

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-white">
      <div className="flex min-w-max">
        <div className="sticky left-0 z-20 w-16 shrink-0 border-r border-border bg-white">
          <div className="h-14 border-b border-border" />
          <div className="relative" style={{ height }}>
            {ticks.slice(0, -1).map((tick) => (
              <div
                key={tick.instant.toISOString()}
                className="absolute right-2 -translate-y-1/2 text-xs tabular-nums text-muted-foreground"
                style={{ top: `${tick.offsetPercent}%` }}
              >
                {formatTime(tick.instant, timeZone)}
              </div>
            ))}
          </div>
        </div>

        {columns.map((column) => {
          const duJour = occupying.filter(
            (booking) =>
              booking.resourceId === resource.id &&
              blockGeometry(booking, column.window) !== undefined,
          )
          return (
            <div
              key={column.isoDate}
              className="w-44 shrink-0 border-r border-border last:border-r-0"
            >
              <div
                className={`h-14 border-b border-border px-3 py-2 ${
                  column.isoDate === today ? 'bg-accent/10' : ''
                }`}
              >
                <div className="truncate text-sm font-medium">
                  {weekdayLabels[column.weekday]}
                  {column.isoDate === today && (
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      aujourd’hui
                    </span>
                  )}
                </div>
                <Link
                  href={`/reservations?date=${column.isoDate}`}
                  className="truncate text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  {column.isoDate.slice(8)}/{column.isoDate.slice(5, 7)}
                  {column.closed && <span className="ml-1 font-medium">· fermé</span>}
                </Link>
              </div>

              <div className="relative" style={{ height }}>
                <div aria-hidden className="absolute inset-0 bg-muted/40" />
                {(opening[column.isoDate] ?? []).map((plage) => {
                  const geometry = blockGeometry(plage, column.window)
                  if (!geometry) return null
                  return (
                    <div
                      key={plage.startsAt.toISOString()}
                      aria-hidden
                      className="absolute inset-x-0 bg-white"
                      style={{
                        top: `${geometry.topPercent}%`,
                        height: `${geometry.heightPercent}%`,
                      }}
                    />
                  )
                })}

                {ticks.map((tick) => (
                  <div
                    key={tick.instant.toISOString()}
                    aria-hidden
                    className="absolute inset-x-0 border-t border-border/40"
                    style={{ top: `${tick.offsetPercent}%` }}
                  />
                ))}

                {/* Une bande cliquable par heure, comme en vue jour. */}
                {ticks.slice(0, -1).map((tick, index) => {
                  const instant = new Date(
                    column.window.startsAt.getTime() +
                      (tick.instant.getTime() - ticks[0].instant.getTime()),
                  )
                  const startTime = toWallClock(instant, timeZone).slice(11, 16)
                  return (
                    <Link
                      key={tick.instant.toISOString()}
                      href={`/reservations/nouvelle?date=${column.isoDate}&resourceId=${resource.id}&start=${startTime}`}
                      aria-label={`Réserver ${resource.name} le ${column.isoDate} à ${startTime}`}
                      className="absolute inset-x-0 hover:bg-muted/60"
                      style={{
                        top: `${tick.offsetPercent}%`,
                        height: `${ticks[index + 1].offsetPercent - tick.offsetPercent}%`,
                      }}
                    />
                  )
                })}

                {duJour.map((booking) => {
                  const geometry = blockGeometry(booking, column.window)
                  if (!geometry) return null
                  const status = booking.status as Exclude<typeof booking.status, 'cancelled'>
                  return (
                    <Link
                      key={booking.id}
                      href={`/reservations/${booking.id}`}
                      className={`absolute inset-x-1 z-10 block overflow-hidden rounded border-l-4 px-2 py-1 text-xs hover:brightness-95 ${bookingBlockStyles[status]}`}
                      style={{
                        top: `${geometry.topPercent}%`,
                        height: `${geometry.heightPercent}%`,
                      }}
                    >
                      <div className="truncate font-medium">{booking.title}</div>
                      <div className="truncate tabular-nums opacity-80">
                        {formatTime(booking.startsAt, timeZone)}
                      </div>
                      {status === 'pending' && (
                        <div className="truncate opacity-80">{bookingStatusLabels.pending}</div>
                      )}
                    </Link>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
