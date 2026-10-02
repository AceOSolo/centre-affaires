import Link from 'next/link'

import { CalendarIcon, CheckIcon, ClockIcon } from '../../../../components/ui/icons.tsx'
import { formatLongDate, formatTime, toIsoDate } from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { requireClientAccount } from '../../../../modules/clients/session.ts'
import { frozenQuoteDisplay } from '../../../../modules/facturation/devis.ts'
import { formatCents } from '../../../../modules/facturation/tarifs.ts'
import { ClientCancel } from '../../../../modules/reservations/client-cancel.tsx'
import {
  canClientCancel,
  clientBookingTrace,
  isClientBookingInProgress,
  splitClientBookings,
} from '../../../../modules/reservations/compte-regles.ts'
import { listBookingsForAccounts } from '../../../../modules/reservations/compte-queries.ts'
import { bookingStatusLabels } from '../../../../modules/reservations/labels.ts'
import type { BookingStatus } from '../../../../modules/reservations/schema.ts'
import { resourceTypeLabels } from '../../../../modules/ressources/labels.ts'

export const metadata = { title: 'Mes réservations' }

/** Vu du client : « à valider » par le centre, pas par lui. */
const clientStatusLabels: Record<BookingStatus, string> = {
  pending: 'En attente de validation',
  confirmed: bookingStatusLabels.confirmed,
  cancelled: bookingStatusLabels.cancelled,
}

const statusIcons: Record<BookingStatus, typeof CheckIcon> = {
  pending: ClockIcon,
  confirmed: CheckIcon,
  cancelled: CalendarIcon,
}

/** Mêmes bleus que le planning (ADR 004) ; l'icône et le libellé portent le sens. */
const statusStyles: Record<BookingStatus, string> = {
  pending: 'bg-accent/15 text-primary',
  confirmed: 'bg-primary text-primary-foreground',
  cancelled: 'bg-muted text-muted-foreground',
}

/**
 * Réservations des entreprises du compte (R23, R24) : à venir — en cours
 * comprises — puis l'historique, chacune avec son statut en toutes lettres,
 * son montant figé, qui l'a faite et qui l'a annulée (ADR 036). Une demande
 * en attente s'annule ici ; une réservation confirmée se modifie auprès du
 * centre, dont les conditions d'annulation relèvent du contrat (ADR 015).
 */
export default async function MesReservationsPage() {
  const { accounts } = await requireClientAccount()
  const [tenant, rows] = await Promise.all([currentTenant(), listBookingsForAccounts(accounts)])
  const timeZone = tenant.timezone
  const now = new Date()
  const { upcoming, history } = splitClientBookings(rows, now)
  const several = accounts.length > 1

  const card = (booking: (typeof rows)[number]) => {
    const Icon = statusIcons[booking.status]
    const trace = clientBookingTrace(booking)
    const quote = frozenQuoteDisplay(booking)
    const inProgress = isClientBookingInProgress(booking, now)
    return (
      <li key={booking.id} className="rounded-lg border border-border bg-white p-4 sm:p-5">
        <article aria-labelledby={`resa-${booking.id}`} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${statusStyles[booking.status]}`}
            >
              <Icon size={16} />
              {clientStatusLabels[booking.status]}
            </span>
            {inProgress && <span className="font-medium text-primary">En cours</span>}
            <span className="text-muted-foreground">{resourceTypeLabels[booking.resourceType]}</span>
            {several && <span className="text-muted-foreground">· {booking.clientName}</span>}
          </div>
          <div>
            <h3 id={`resa-${booking.id}`} className="text-base font-semibold">
              {booking.resourceName}
            </h3>
            <p className="text-sm capitalize text-muted-foreground">
              {formatLongDate(toIsoDate(booking.startsAt, timeZone), timeZone)}
            </p>
            <p className="text-sm text-muted-foreground tabular">
              {formatTime(booking.startsAt, timeZone)} – {formatTime(booking.endsAt, timeZone)} ·{' '}
              {booking.title}
            </p>
            {quote && (
              <p className="text-sm tabular">
                Montant : {formatCents(quote.totalCents, quote.currency)} TTC
              </p>
            )}
            <p className="text-sm text-muted-foreground">{trace.origin}</p>
            {trace.cancellation && (
              <p className="text-sm text-muted-foreground">{trace.cancellation}</p>
            )}
            {booking.status === 'cancelled' && booking.cancellationReason && (
              <p className="text-sm text-muted-foreground">Motif : {booking.cancellationReason}</p>
            )}
          </div>
          {canClientCancel(booking, now) && <ClientCancel bookingId={booking.id} />}
        </article>
      </li>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">
            Mes réservations
          </h1>
          {/* Annoncé quand le nombre change, après une annulation. */}
          <p aria-live="polite" className="mt-2 text-muted-foreground">
            {upcoming.length === 0
              ? 'Aucune réservation à venir.'
              : `${upcoming.length} réservation${upcoming.length > 1 ? 's' : ''} à venir.`}
          </p>
        </div>
        <Link
          href="/compte/reservations/nouvelle"
          className="press inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          Réserver un espace
        </Link>
      </div>

      <section aria-labelledby="a-venir" className="flex flex-col gap-4">
        <h2 id="a-venir" className="text-lg font-semibold">
          À venir
        </h2>
        {upcoming.length === 0 ? (
          <p className="max-w-prose rounded-lg border border-dashed border-border px-6 py-8 text-center text-muted-foreground">
            Choisissez un espace et un créneau libre depuis{' '}
            <Link
              href="/compte/reservations/nouvelle"
              className="font-medium text-primary underline underline-offset-2"
            >
              Réserver un espace
            </Link>
            : le tarif de votre contrat s’affiche avant de valider.
          </p>
        ) : (
          <ul className="flex max-w-3xl flex-col gap-4">{upcoming.map(card)}</ul>
        )}
        <p className="max-w-prose text-sm text-muted-foreground">
          Une demande en attente de validation s’annule ici, avant son début. Pour modifier ou
          annuler une réservation confirmée, contactez le centre
          {tenant.phone && (
            <>
              {' '}
              au{' '}
              <a
                href={`tel:${tenant.phone.replace(/\s/g, '')}`}
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                {tenant.phone}
              </a>
            </>
          )}
          {tenant.email && (
            <>
              {tenant.phone ? ' ou ' : ' '}à{' '}
              <a
                href={`mailto:${tenant.email}`}
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                {tenant.email}
              </a>
            </>
          )}
          .
        </p>
      </section>

      {history.length > 0 && (
        <section aria-labelledby="historique" className="flex flex-col gap-4">
          <h2 id="historique" className="text-lg font-semibold">
            Passées et annulées
          </h2>
          <ul className="flex max-w-3xl flex-col gap-4">{history.map(card)}</ul>
        </section>
      )}
    </div>
  )
}
