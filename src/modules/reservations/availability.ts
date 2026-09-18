import type { BookingStatus } from './schema'

/**
 * Règles de disponibilité côté code.
 *
 * L'autorité reste la contrainte d'exclusion `bookings_no_overlap` (décision 3) :
 * ces fonctions servent à répondre à l'utilisateur avant l'écriture et à
 * afficher les créneaux libres. Elles doivent donner exactement le même verdict
 * que la base, d'où les bornes semi-ouvertes `[)` reproduites ici.
 */
export type TimeRange = {
  startsAt: Date
  endsAt: Date
}

/** Une réservation annulée libère le créneau ; c'est le prédicat de la contrainte. */
export function occupiesResource(status: BookingStatus): boolean {
  return status !== 'cancelled'
}

/** Une réservation de durée nulle ou négative n'a pas de sens. */
export function isValidRange({ startsAt, endsAt }: TimeRange): boolean {
  return endsAt.getTime() > startsAt.getTime()
}

/**
 * Bornes `[)` : la fin est exclue. Une réservation qui finit à 10h00 et une qui
 * commence à 10h00 ne se chevauchent pas.
 */
export function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.startsAt.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < a.endsAt.getTime()
}

export type ExistingBooking = TimeRange & {
  id: string
  resourceId: string
  status: BookingStatus
}

/**
 * Réservations existantes qui empêchent la pose de `candidate` sur la ressource.
 * `excludeBookingId` sert au déplacement d'une réservation, qui ne doit pas
 * entrer en conflit avec elle-même.
 */
export function findConflicts(
  candidate: TimeRange & { resourceId: string },
  existing: readonly ExistingBooking[],
  options: { excludeBookingId?: string } = {},
): ExistingBooking[] {
  return existing.filter(
    (booking) =>
      booking.resourceId === candidate.resourceId &&
      booking.id !== options.excludeBookingId &&
      occupiesResource(booking.status) &&
      overlaps(candidate, booking),
  )
}
