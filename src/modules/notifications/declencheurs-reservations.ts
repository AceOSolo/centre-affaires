import { and, eq, isNull } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { appUrl } from '../../lib/courriel.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { frozenQuoteDisplay } from '../facturation/devis.ts'
import { formatCents } from '../facturation/tarifs.ts'
import { bookings } from '../reservations/schema.ts'
import { resources } from '../ressources/schema.ts'
import { centreTimeZone, formatSlot, personName } from './faits.ts'
import { notify, type NotificationOutcome, type NotificationRequest, type NotifyOptions } from './moteur.ts'
import type { NotificationEvent } from './schema.ts'

/**
 * Déclencheurs des réservations (ADR 005, ADR 036, ADR 038). Chacun relit la
 * réservation et ne prévient que si elle est dans l'état que l'événement
 * annonce : un double clic, une action rejouée ou un état changé entre-temps
 * ne font pas partir un message faux. Ne lèvent jamais.
 *
 * Une demande anonyme de la page publique, sans entreprise, ne donne pas de
 * message au client : le journal exige l'entreprise d'un message au client,
 * et l'équipe répond elle-même au demandeur (ADR 005).
 */

async function guarded(
  label: string,
  run: () => Promise<NotificationOutcome | null>,
): Promise<NotificationOutcome | null> {
  try {
    return await run()
  } catch (error) {
    console.error(`Notification impossible : ${label}`, error)
    return null
  }
}

async function loadBooking(bookingId: string, options: NotifyOptions) {
  const tenantId = options.tenantId ?? currentTenantId()
  return withTenant(
    tenantId,
    async (tx) => {
      const [row] = await tx
        .select({
          booking: bookings,
          resourceName: resources.name,
          clientName: clients.name,
        })
        .from(bookings)
        .innerJoin(resources, eq(resources.id, bookings.resourceId))
        .leftJoin(clients, eq(clients.id, bookings.clientId))
        .where(eq(bookings.id, bookingId))
      if (!row) return undefined

      // Qui prévenir : la personne qui a réservé depuis son espace ; sinon le
      // demandeur de la page publique — avec ses préférences s'il a un accès
      // de l'entreprise ; sinon toutes les personnes de l'entreprise.
      const { booking } = row
      let recipients: NotificationRequest['recipients']
      let bookedBy: { fullName: string | null; email: string } | undefined
      if (booking.clientId && booking.bookedByMemberId) {
        const [member] = await tx
          .select({ fullName: clientMembers.fullName, email: clientMembers.email, deletedAt: clientMembers.deletedAt })
          .from(clientMembers)
          .where(eq(clientMembers.id, booking.bookedByMemberId))
        bookedBy = member
        // Un accès retiré depuis : l'entreprise reste prévenue.
        if (member && !member.deletedAt) recipients = { memberIds: [booking.bookedByMemberId] }
      } else if (booking.clientId && booking.requesterEmail) {
        const email = booking.requesterEmail.trim().toLowerCase()
        const [member] = await tx
          .select({ id: clientMembers.id })
          .from(clientMembers)
          .where(
            and(
              eq(clientMembers.clientId, booking.clientId),
              eq(clientMembers.email, email),
              isNull(clientMembers.deletedAt),
            ),
          )
        recipients = { addresses: [{ email, memberId: member?.id ?? null }] }
      }
      return { ...row, recipients, bookedBy, timeZone: await centreTimeZone(tx, tenantId) }
    },
    options.database,
  )
}

type LoadedBooking = NonNullable<Awaited<ReturnType<typeof loadBooking>>>

function amount(booking: LoadedBooking['booking']): string | null {
  const quote = frozenQuoteDisplay(booking)
  return quote ? `${formatCents(quote.totalCents, quote.currency)} TTC` : null
}

function bookingValues(loaded: LoadedBooking) {
  const { booking } = loaded
  return {
    client: loaded.clientName,
    ressource: loaded.resourceName,
    creneau: formatSlot(booking.startsAt, booking.endsAt, loaded.timeZone),
    montant: amount(booking),
    motif: booking.cancellationReason,
    lien: appUrl('/compte/reservations'),
  }
}

/** Message au client sur une réservation de son entreprise, dans l'état attendu. */
function notifyClient(
  event: NotificationEvent,
  expected: 'confirmed' | 'cancelled',
  bookingId: string,
  options: NotifyOptions,
) {
  return guarded(event, async () => {
    const loaded = await loadBooking(bookingId, options)
    if (!loaded || loaded.booking.kind !== 'booking' || !loaded.booking.clientId) return null
    if (loaded.booking.status !== expected) return null
    return notify(
      {
        event,
        clientId: loaded.booking.clientId,
        related: { type: 'booking', id: loaded.booking.id },
        recipients: loaded.recipients,
        values: bookingValues(loaded),
      },
      options,
    )
  })
}

/**
 * Demande de réservation déposée — page publique, ou espace client sur une
 * ressource « accord de l'accueil » (ADR 036) : à l'adresse du centre.
 */
export function notifyBookingRequestSubmitted(bookingId: string, options: NotifyOptions = {}) {
  return guarded('demande de réservation déposée', async () => {
    const loaded = await loadBooking(bookingId, options)
    if (!loaded || loaded.booking.kind !== 'booking' || loaded.booking.status !== 'pending') return null
    const { booking } = loaded
    return notify(
      {
        event: 'booking_request_submitted',
        clientId: booking.clientId,
        related: { type: 'booking', id: booking.id },
        values: {
          ...bookingValues(loaded),
          demandeur:
            personName(loaded.bookedBy?.fullName, loaded.bookedBy?.email) ??
            personName(booking.requesterName, booking.requesterEmail) ??
            loaded.clientName ??
            'Un visiteur',
          motif: null,
          lien: appUrl('/demandes'),
        },
      },
      options,
    )
  })
}

/** Demande validée par l'équipe (`/demandes`). */
export function notifyBookingRequestAccepted(bookingId: string, options: NotifyOptions = {}) {
  return notifyClient('booking_request_accepted', 'confirmed', bookingId, options)
}

/** Demande refusée par l'équipe : le motif saisi accompagne le message. */
export function notifyBookingRequestRefused(bookingId: string, options: NotifyOptions = {}) {
  return notifyClient('booking_request_refused', 'cancelled', bookingId, options)
}

/**
 * Réservation enregistrée confirmée pour une entreprise : par l'équipe, ou
 * depuis l'espace client sur une ressource « confirmation immédiate ».
 */
export function notifyBookingConfirmed(bookingId: string, options: NotifyOptions = {}) {
  return notifyClient('booking_confirmed', 'confirmed', bookingId, options)
}

/** Réservation d'une entreprise annulée par l'équipe. */
export function notifyBookingCancelled(bookingId: string, options: NotifyOptions = {}) {
  return notifyClient('booking_cancelled', 'cancelled', bookingId, options)
}
