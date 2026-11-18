import { addDaysToIsoDate, formatLongDate, formatTime, toIsoDate, toWallClock, wallClockToUtc } from '../../lib/dates.ts'
import type { BookingChannel, BookingStatus } from './schema.ts'

/**
 * Règles des réservations vues depuis l'espace client (ADR 015). Sans base ni
 * framework, pour être éprouvées seules.
 */

type ClientBooking = {
  status: BookingStatus
  startsAt: Date
  endsAt: Date
  /** Réservation principale du matériel en option (ADR 062) ; absente ou nulle sinon. */
  parentBookingId?: string | null
}

/**
 * Modification et annulation par le client (ADR 076, recette du 17/11/2026) :
 * une demande ou une réservation, en attente ou confirmée, se modifie ou
 * s'annule depuis l'espace client **jusqu'à N jours avant son début**, N
 * réglé par le centre (`tenants.booking_change_days`, 7 par défaut). Au-delà,
 * le client voit pourquoi et comment joindre l'accueil.
 *
 * Le délai se compte en heure murale du centre : une réservation du lundi
 * 9 h, à sept jours, se modifie jusqu'au lundi précédent 9 h, changement
 * d'heure compris. La base vérifie la même règle
 * (`booking_client_change_deadline`, `24-formules-et-modifications.sql`).
 */
export type ClientChangePolicy = { days: number; timeZone: string }

export const DEFAULT_CLIENT_CHANGE_DAYS = 7
export const MAX_CLIENT_CHANGE_DAYS = 90

export function isValidClientChangeDays(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_CLIENT_CHANGE_DAYS
}

/** Dernier instant, exclu, où le client modifie ou annule : le début, N jours plus tôt, même heure murale. */
export function clientChangeDeadline(startsAt: Date, days: number, timeZone: string): Date {
  const wall = toWallClock(startsAt, timeZone)
  const shifted = `${addDaysToIsoDate(wall.slice(0, 10), -days)}T${wall.slice(11, 16)}`
  // Les secondes du début comptent : la base compare à la milliseconde.
  return new Date(wallClockToUtc(shifted, timeZone).getTime() + (startsAt.getTime() % 60_000))
}

/** Pourquoi le client ne peut plus modifier ni annuler lui-même. */
export type ClientChangeBlocker = 'annulee' | 'option' | 'commencee' | 'delai'

export function clientChangeBlocker(
  booking: ClientBooking,
  now: Date,
  policy: ClientChangePolicy,
): ClientChangeBlocker | undefined {
  if (booking.status === 'cancelled') return 'annulee'
  // Le matériel en option suit sa salle (ADR 062) : il s'annule avec elle, ou
  // auprès du centre, jamais seul depuis l'espace.
  if (booking.parentBookingId) return 'option'
  if (booking.startsAt <= now) return 'commencee'
  if (now >= clientChangeDeadline(booking.startsAt, policy.days, policy.timeZone)) return 'delai'
  return undefined
}

/** Le client annule lui-même, dans le délai du centre. */
export function canClientCancel(booking: ClientBooking, now: Date, policy: ClientChangePolicy): boolean {
  return clientChangeBlocker(booking, now, policy) === undefined
}

/**
 * Le client modifie lui-même dates, heures ou formule, dans le délai du
 * centre — sauf une réservation qui emporte du matériel en option : il
 * faudrait le déplacer avec elle, l'accueil s'en charge (ADR 076).
 */
export function canClientModify(
  booking: ClientBooking & { optionCount: number },
  now: Date,
  policy: ClientChangePolicy,
): boolean {
  return booking.optionCount === 0 && clientChangeBlocker(booking, now, policy) === undefined
}

/** « le lundi 9 novembre 2026 à 09:00 » */
export function formatDeadline(deadline: Date, timeZone: string): string {
  return `le ${formatLongDate(toIsoDate(deadline, timeZone), timeZone)} à ${formatTime(deadline, timeZone)}`
}

/** Pourquoi le client ne peut plus modifier ni annuler, dit en toutes lettres. */
export function clientChangeBlockerMessage(blocker: ClientChangeBlocker, policy: ClientChangePolicy): string {
  switch (blocker) {
    case 'annulee':
      return 'Cette réservation est annulée : elle ne se modifie plus.'
    case 'option':
      return 'Le matériel en option suit sa réservation : il se modifie et s’annule avec elle.'
    case 'commencee':
      return 'Elle a commencé : pour la modifier ou l’annuler, contactez l’accueil.'
    case 'delai':
      return `Le délai pour la modifier ou l’annuler ici est passé (${policy.days} jour${policy.days > 1 ? 's' : ''} avant le début) : contactez l’accueil.`
  }
}

/** Ce que la carte d'une réservation dit du délai : jusqu'à quand, ou pourquoi plus. */
export function clientChangeNotice(booking: ClientBooking, now: Date, policy: ClientChangePolicy): string | null {
  const blocker = clientChangeBlocker(booking, now, policy)
  if (!blocker) {
    const deadline = clientChangeDeadline(booking.startsAt, policy.days, policy.timeZone)
    return `Modifiable ou annulable ici jusqu’${formatDeadline(deadline, policy.timeZone).replace(/^le /, 'au ')}.`
  }
  return blocker === 'delai' || blocker === 'commencee' ? clientChangeBlockerMessage(blocker, policy) : null
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
