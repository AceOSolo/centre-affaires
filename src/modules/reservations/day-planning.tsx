import Link from 'next/link'

import { formatTime, toWallClock } from '../../lib/dates.ts'
import { resourceTypeLabels } from '../ressources/labels.ts'
import type { TimeRange } from '../ressources/ouverture.ts'
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
 *
 * Les heures de fermeture sont grisées colonne par colonne : une salle ouverte
 * le samedi dans un centre fermé le samedi doit se voir du premier coup d'œil,
 * et un créneau hors ouverture ne doit pas ressembler à un créneau libre.
 */
export function DayPlanning({
  isoDate,
  timeZone,
  resources,
  bookings,
  opening,
}: {
  isoDate: string
  timeZone: string
  resources: Resource[]
  bookings: BookingWithResource[]
  /** Plages d'ouverture du jour, par identifiant de ressource. */
  opening: Record<string, TimeRange[]>
}) {
  const occupying = bookings.filter((booking) => booking.status !== 'cancelled')
  // L'amplitude couvre toutes les colonnes : sans l'union, une ressource
  // ouverte plus tard que les autres sortirait de la grille.
  const toutesLesPlages = resources.flatMap((resource) => opening[resource.id] ?? [])
  // Une occupation de contrat couvre des jours entiers (ADR 018) : elle
  // étirerait la grille de minuit à minuit. Elle est rognée sur l'amplitude
  // comme le reste, sans la fixer.
  const window = planningWindow(
    isoDate,
    timeZone,
    occupying.filter((booking) => booking.kind !== 'contract'),
    toutesLesPlages,
  )
  const ticks = hourTicks(window)
  const height = planningHeightPx(window)

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-white">
      <div className="flex min-w-max">
        <div className="sticky left-0 z-20 w-16 shrink-0 border-r border-border bg-white">
          <div className="h-12 border-b border-border" />
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

        {resources.map((resource) => (
          <div
            key={resource.id}
            className={`${COLUMN_WIDTH} shrink-0 border-r border-border last:border-r-0`}
          >
            <div className="h-12 truncate border-b border-border px-3 py-2">
              <div className="truncate text-sm font-medium">{resource.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {resource.code} · {resourceTypeLabels[resource.resourceType]}
                {(opening[resource.id] ?? []).length === 0 && (
                  <span className="ml-1 font-medium">· fermé</span>
                )}
              </div>
            </div>

            <div className="relative" style={{ height }}>
              {/* Fond fermé par défaut ; les plages d'ouverture le percent. */}
              <div aria-hidden className="absolute inset-0 bg-muted/40" />
              {(opening[resource.id] ?? []).map((plage) => {
                const geometry = blockGeometry(plage, window)
                if (!geometry) return null
                return (
                  <div
                    key={plage.startsAt.toISOString()}
                    aria-hidden
                    className="absolute inset-x-0 bg-white"
                    style={{ top: `${geometry.topPercent}%`, height: `${geometry.heightPercent}%` }}
                  />
                )
              })}

              {ticks.map((tick, index) => (
                <div
                  key={tick.instant.toISOString()}
                  aria-hidden
                  className="absolute inset-x-0 border-t border-border"
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
                    className="absolute inset-x-0 hover:bg-muted/70"
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
