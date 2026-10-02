import { formatTime, toIsoDate } from '../../lib/dates.ts'
import { formatCalendarDate, formatContractDays, occupationDays } from '../contrats/occupation.ts'
import { bookingLabel } from './affichage.ts'
import type { TimeRange } from './availability.ts'
import type { BookingKind } from './schema.ts'

/**
 * Ce qui occupe un créneau, dit dans un message de conflit — réservation,
 * indisponibilité ou occupation d'une ressource sous contrat (ADR 018).
 *
 * Une occupation couvre des jours entiers, souvent des mois, parfois sans
 * terme : l'afficher « de 00:00 à 00:00 » ou « jusqu'au 31/12/9999 » serait
 * faux. Fonction pure, partagée par les messages de conflit des réservations et
 * des contrats. Les libellés eux-mêmes (« Occupé — contrat X ») viennent
 * d'`affichage.ts`, seule source pour le planning, la fiche et ces messages.
 */

/** Ce qu'il faut d'une ligne pour la décrire dans un message de conflit. */
export type BusyBooking = TimeRange & { kind: BookingKind; title: string }

/**
 * Ce qui occupe un créneau, en une phrase, pour un message de conflit :
 * « « Réunion » le 12/03/2026 de 09:00 à 10:00 », ou
 * « Occupé — contrat CT-2026-0001 (du 01/03/2026 au 30/06/2026) ».
 */
export function describeBusyBooking(booking: BusyBooking, timeZone: string): string {
  if (booking.kind === 'contract') {
    return `${bookingLabel(booking)} (${formatContractDays(occupationDays(booking, timeZone))})`
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
