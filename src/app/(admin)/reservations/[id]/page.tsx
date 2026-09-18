import Link from 'next/link'
import { notFound } from 'next/navigation'

import { formatDuration, formatLongDate, formatTime, toIsoDate } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { cancelBookingAction } from '../../../../modules/reservations/actions.ts'
import { findBooking } from '../../../../modules/reservations/queries.ts'
import { resourceTypeLabels } from '../../../../modules/ressources/labels.ts'

export const metadata = { title: 'Réservation' }

export default async function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const timeZone = await currentTimeZone()
  const booking = await findBooking(id)
  if (!booking) notFound()

  const isoDate = toIsoDate(booking.startsAt, timeZone)
  const cancelled = booking.status === 'cancelled'

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <Link
          href={`/reservations?date=${isoDate}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Planning
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{booking.title}</h1>
        {cancelled && (
          <p className="mt-2 inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
            Annulée — le créneau est libre
          </p>
        )}
      </div>

      <dl className="grid grid-cols-[8rem_1fr] gap-y-3 rounded-lg border border-border bg-white px-5 py-4 text-sm">
        <dt className="text-muted-foreground">Ressource</dt>
        <dd>
          {booking.resource.name}{' '}
          <span className="text-muted-foreground">
            ({booking.resource.code} · {resourceTypeLabels[booking.resource.resourceType]})
          </span>
        </dd>

        <dt className="text-muted-foreground">Date</dt>
        <dd className="capitalize">{formatLongDate(isoDate, timeZone)}</dd>

        <dt className="text-muted-foreground">Créneau</dt>
        <dd>
          {formatTime(booking.startsAt, timeZone)} – {formatTime(booking.endsAt, timeZone)}{' '}
          <span className="text-muted-foreground">
            ({formatDuration(booking.startsAt, booking.endsAt)})
          </span>
        </dd>

        {booking.notes && (
          <>
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="whitespace-pre-line">{booking.notes}</dd>
          </>
        )}

        {cancelled && (
          <>
            <dt className="text-muted-foreground">Annulée le</dt>
            <dd>
              {booking.cancelledAt
                ? `${formatLongDate(toIsoDate(booking.cancelledAt, timeZone), timeZone)} à ${formatTime(booking.cancelledAt, timeZone)}`
                : '—'}
            </dd>
            <dt className="text-muted-foreground">Motif</dt>
            <dd>{booking.cancellationReason ?? '—'}</dd>
          </>
        )}
      </dl>

      {!cancelled && (
        <div>
          <Link
            href={`/reservations/${booking.id}/modifier`}
            className="inline-block rounded-md border border-primary px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-muted"
          >
            Déplacer la réservation
          </Link>
        </div>
      )}

      {/* Pas de suppression : la réservation reste consultable, l'annulation est
          sa suppression logique (décision 6). */}
      {!cancelled && (
        <form
          action={cancelBookingAction}
          className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4"
        >
          <input type="hidden" name="id" value={booking.id} />
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="reason"
          >
            Annuler cette réservation
          </label>
          <input
            id="reason"
            name="reason"
            placeholder="Motif (facultatif)"
            className="w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40"
          />
          <button
            type="submit"
            className="self-start rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/5"
          >
            Annuler la réservation
          </button>
        </form>
      )}
    </div>
  )
}
