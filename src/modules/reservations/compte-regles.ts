import type { BookingStatus } from './schema.ts'

/**
 * Règles des réservations vues depuis l'espace client (ADR 015). Sans base ni
 * framework, pour être éprouvées seules.
 */

type ClientBooking = { status: BookingStatus; startsAt: Date; endsAt: Date }

/**
 * Le client annule lui-même une demande que le centre n'a pas encore validée,
 * tant qu'elle n'a pas commencé : rien n'est encore engagé.
 *
 * Une réservation confirmée, elle, s'annule auprès du centre. Les conditions
 * d'annulation — délai, frais — relèvent du contrat et ne sont pas écrites
 * ici ; les inventer dans le code serait facturer à la place du centre.
 */
export function canClientCancel(booking: ClientBooking, now: Date): boolean {
  return booking.status === 'pending' && booking.startsAt > now
}

/**
 * À venir d'abord, dans l'ordre où elles arrivent — y compris celle en cours ;
 * l'historique ensuite, de la plus récente à la plus ancienne. Une réservation
 * annulée n'est jamais « à venir » : son créneau n'existe plus.
 */
export function splitClientBookings<T extends ClientBooking>(
  bookings: T[],
  now: Date,
): { upcoming: T[]; history: T[] } {
  const upcoming = bookings
    .filter((booking) => booking.status !== 'cancelled' && booking.endsAt > now)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  const history = bookings
    .filter((booking) => booking.status === 'cancelled' || booking.endsAt <= now)
    .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
  return { upcoming, history }
}
