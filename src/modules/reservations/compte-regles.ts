import type { BookingChannel, BookingStatus } from './schema.ts'

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

/** Ce que l'espace client sait de l'origine et de l'annulation d'une réservation (ADR 036). */
type TracedBooking = {
  status: BookingStatus
  channel: BookingChannel
  /** Personne de l'entreprise qui a réservé depuis l'espace : nom ou adresse. */
  bookedBy: string | null
  /** Personne de l'entreprise qui a annulé depuis l'espace. */
  cancelledByMember: string | null
  /** Annulée ou refusée par l'équipe du centre. */
  cancelledByCentre: boolean
}

/**
 * Traçabilité côté client (R24) : qui a réservé, et qui a annulé. Une
 * entreprise a plusieurs accès : le nom de la personne dit lequel. L'équipe
 * reste « le centre » — le client n'a pas à connaître ses membres.
 *
 * Une annulation antérieure à la vague 3 n'a pas d'auteur : rien n'est
 * inventé, la ligne ne dit que « annulée » (le statut).
 */
export function clientBookingTrace(booking: TracedBooking): {
  origin: string
  cancellation: string | null
} {
  const origin = booking.bookedBy
    ? `Réservée par ${booking.bookedBy} depuis l’espace client`
    : booking.channel === 'staff'
      ? 'Réservée par l’accueil du centre'
      : 'Demandée depuis le site du centre'
  if (booking.status !== 'cancelled') return { origin, cancellation: null }
  return {
    origin,
    cancellation: booking.cancelledByMember
      ? `Annulée par ${booking.cancelledByMember}`
      : booking.cancelledByCentre
        ? 'Annulée par le centre'
        : null,
  }
}

/** Réservation en cours à cet instant : commencée, pas finie, pas annulée. */
export function isClientBookingInProgress(booking: ClientBooking, now: Date): boolean {
  return booking.status !== 'cancelled' && booking.startsAt <= now && booking.endsAt > now
}
