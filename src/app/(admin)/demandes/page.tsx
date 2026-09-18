import Link from 'next/link'

import { formatDuration, formatLongDate, formatTime, toIsoDate } from '../../../lib/dates.ts'
import { currentTimeZone } from '../../../lib/tenant.ts'
import {
  confirmBookingAction,
  refuseBookingAction,
} from '../../../modules/reservations/actions.ts'
import { listPendingBookings } from '../../../modules/reservations/queries.ts'
import { resourceTypeLabels } from '../../../modules/ressources/labels.ts'

export const metadata = { title: 'Demandes' }

/**
 * File des demandes déposées depuis le site public (ADR 005).
 *
 * Chaque ligne bloque déjà son créneau : traiter la file vite n'est pas une
 * question de confort, c'est ce qui libère les salles que personne ne prendra.
 */
export default async function DemandesPage() {
  const timeZone = await currentTimeZone()
  const pending = await listPendingBookings()

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Demandes à valider</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Déposées depuis le site public. Chaque demande occupe déjà son créneau : la refuser le
          libère.
        </p>
      </div>

      {pending.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">Aucune demande en attente.</p>
          <Link
            href="/reservations"
            className="mt-4 inline-block text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            Revenir au planning
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {pending.map((booking) => {
            const isoDate = toIsoDate(booking.startsAt, timeZone)
            return (
              <li
                key={booking.id}
                className="flex flex-col gap-4 rounded-lg border border-border bg-white p-5 lg:flex-row lg:items-start lg:justify-between"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-primary">
                      À valider
                    </span>
                    <h2 className="font-medium">{booking.title}</h2>
                  </div>

                  <p className="mt-2 text-sm capitalize text-muted-foreground">
                    {formatLongDate(isoDate, timeZone)}
                  </p>
                  <p className="text-sm text-muted-foreground tabular">
                    {formatTime(booking.startsAt, timeZone)} –{' '}
                    {formatTime(booking.endsAt, timeZone)} ({' '}
                    {formatDuration(booking.startsAt, booking.endsAt)} ) ·{' '}
                    {booking.resource.name} ({resourceTypeLabels[booking.resource.resourceType]})
                  </p>

                  <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                    <dt className="text-muted-foreground">Demandeur</dt>
                    <dd>{booking.requesterName ?? '—'}</dd>
                    <dt className="text-muted-foreground">Courriel</dt>
                    <dd>
                      {booking.requesterEmail ? (
                        <a
                          href={`mailto:${booking.requesterEmail}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {booking.requesterEmail}
                        </a>
                      ) : (
                        '—'
                      )}
                    </dd>
                    <dt className="text-muted-foreground">Téléphone</dt>
                    <dd>
                      {booking.requesterPhone ? (
                        <a
                          href={`tel:${booking.requesterPhone.replace(/\s/g, '')}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {booking.requesterPhone}
                        </a>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </dl>

                  {booking.notes && (
                    <p className="mt-3 whitespace-pre-line rounded-md bg-muted p-3 text-sm text-muted-foreground">
                      {booking.notes}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 flex-col gap-3 lg:w-64">
                  <form action={confirmBookingAction}>
                    <input type="hidden" name="id" value={booking.id} />
                    <button
                      type="submit"
                      className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
                    >
                      Valider la demande
                    </button>
                  </form>

                  <form action={refuseBookingAction} className="flex flex-col gap-2">
                    <input type="hidden" name="id" value={booking.id} />
                    <input
                      name="reason"
                      placeholder="Motif du refus (facultatif)"
                      className="w-full rounded-sm border border-border px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40"
                    />
                    <button
                      type="submit"
                      className="w-full rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/5"
                    >
                      Refuser
                    </button>
                  </form>

                  <Link
                    href={`/reservations?date=${isoDate}`}
                    className="text-center text-sm text-muted-foreground underline-offset-2 hover:underline"
                  >
                    Voir le planning du jour
                  </Link>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
