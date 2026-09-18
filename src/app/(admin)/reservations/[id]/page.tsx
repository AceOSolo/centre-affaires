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
          className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
        >
          ← Planning
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{booking.title}</h1>
        {cancelled && (
          <p className="mt-2 inline-block rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            Annulée — le créneau est libre
          </p>
        )}
      </div>

      <dl className="grid grid-cols-[8rem_1fr] gap-y-3 rounded-lg border border-zinc-200 bg-white px-5 py-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
        <dt className="text-zinc-500 dark:text-zinc-400">Ressource</dt>
        <dd>
          {booking.resource.name}{' '}
          <span className="text-zinc-500 dark:text-zinc-400">
            ({booking.resource.code} · {resourceTypeLabels[booking.resource.resourceType]})
          </span>
        </dd>

        <dt className="text-zinc-500 dark:text-zinc-400">Date</dt>
        <dd className="capitalize">{formatLongDate(isoDate, timeZone)}</dd>

        <dt className="text-zinc-500 dark:text-zinc-400">Créneau</dt>
        <dd>
          {formatTime(booking.startsAt, timeZone)} – {formatTime(booking.endsAt, timeZone)}{' '}
          <span className="text-zinc-500 dark:text-zinc-400">
            ({formatDuration(booking.startsAt, booking.endsAt)})
          </span>
        </dd>

        {booking.notes && (
          <>
            <dt className="text-zinc-500 dark:text-zinc-400">Notes</dt>
            <dd className="whitespace-pre-line">{booking.notes}</dd>
          </>
        )}

        {cancelled && (
          <>
            <dt className="text-zinc-500 dark:text-zinc-400">Annulée le</dt>
            <dd>
              {booking.cancelledAt
                ? `${formatLongDate(toIsoDate(booking.cancelledAt, timeZone), timeZone)} à ${formatTime(booking.cancelledAt, timeZone)}`
                : '—'}
            </dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Motif</dt>
            <dd>{booking.cancellationReason ?? '—'}</dd>
          </>
        )}
      </dl>

      {/* Pas de suppression : la réservation reste consultable, l'annulation est
          sa suppression logique (décision 6). */}
      {!cancelled && (
        <form
          action={cancelBookingAction}
          className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <input type="hidden" name="id" value={booking.id} />
          <label
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
            htmlFor="reason"
          >
            Annuler cette réservation
          </label>
          <input
            id="reason"
            name="reason"
            placeholder="Motif (facultatif)"
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-zinc-100"
          />
          <button
            type="submit"
            className="self-start rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
          >
            Annuler la réservation
          </button>
        </form>
      )}
    </div>
  )
}
