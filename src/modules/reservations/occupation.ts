import { formatTime, toIsoDate } from '../../lib/dates.ts'
import { formatCalendarDate, formatContractDays, occupationDays } from '../contrats/occupation.ts'
import type { TimeRange } from './availability.ts'
import type { BookingKind } from './schema.ts'

/**
 * Affichage des lignes de `bookings` qui ne sont pas des réservations horaires,
 * à commencer par l'occupation d'une ressource sous contrat (ADR 018).
 *
 * Une occupation couvre des jours entiers, souvent des mois, parfois sans
 * terme : l'afficher « de 00:00 à 00:00 » ou « jusqu'au 31/12/9999 » serait
 * faux. Ces fonctions sont pures, partagées par le planning, la fiche et les
 * messages de conflit.
 */

/** Ce qu'il faut d'une ligne pour l'afficher. */
export type DisplayableBooking = TimeRange & { kind: BookingKind; title: string }

const OCCUPATION_TITLE = /^Contrat\s+/

/**
 * Référence du contrat d'une occupation, lue dans son titre. Le titre est
 * « Contrat <référence> », écrit et tenu à jour par la base
 * (`apply_contract_occupation`, migration 0026) : il suit la référence quand
 * elle change, et l'application ne peut pas l'écrire (CA001).
 */
export function occupationReference(booking: { title: string }): string {
  return booking.title.replace(OCCUPATION_TITLE, '')
}

/** « Occupé — contrat CT-2026-0001 » pour une occupation, le titre sinon. */
export function bookingDisplayTitle(booking: { kind: BookingKind; title: string }): string {
  return booking.kind === 'contract'
    ? `Occupé — contrat ${occupationReference(booking)}`
    : booking.title
}

/**
 * Ce qui occupe un créneau, en une phrase, pour un message de conflit :
 * « « Réunion » le 12/03/2026 de 09:00 à 10:00 », ou
 * « Occupé — contrat CT-2026-0001 (du 01/03/2026 au 30/06/2026) ».
 */
export function describeBusyBooking(booking: DisplayableBooking, timeZone: string): string {
  if (booking.kind === 'contract') {
    return `${bookingDisplayTitle(booking)} (${formatContractDays(occupationDays(booking, timeZone))})`
  }
  const firstDay = toIsoDate(booking.startsAt, timeZone)
  // Dernier instant compris : une réservation qui finit à minuit pile reste
  // sur sa journée.
  const lastDay = toIsoDate(new Date(booking.endsAt.getTime() - 1), timeZone)
  const start = formatTime(booking.startsAt, timeZone)
  const end = formatTime(booking.endsAt, timeZone)
  if (lastDay !== firstDay) {
    return `« ${booking.title} » du ${formatCalendarDate(firstDay)} ${start} au ${formatCalendarDate(toIsoDate(booking.endsAt, timeZone))} ${end}`
  }
  return `« ${booking.title} » le ${formatCalendarDate(firstDay)} de ${start} à ${end}`
}
