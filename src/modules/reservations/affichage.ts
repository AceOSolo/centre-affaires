import { addDaysToIsoDate, dayRangeUtc, formatTime, toIsoDate } from '../../lib/dates.ts'
import type { BookingKind, BookingStatus } from './schema.ts'
import { isOpenEndedBooking } from './schema.ts'

/**
 * Ce que le planning affiche d'une réservation, selon sa nature (ADR 018).
 *
 * Une occupation de contrat n'est pas une réservation comme les autres : elle
 * couvre des journées entières, parfois sans terme, et elle se gère depuis le
 * contrat. L'afficher « Contrat CT-2026-0001, 00:00 – 00:00 » ou « jusqu'au
 * 31/12/9999 » serait exact pour la base et faux pour l'équipe.
 *
 * Fonctions pures, sans base ni React, pour être éprouvées par `node --test`.
 */

/** Le minimum qu'il faut d'une réservation pour l'afficher. */
export type DisplayableBooking = {
  id: string
  kind: BookingKind
  status: BookingStatus
  title: string
  startsAt: Date
  endsAt: Date
  clientId: string | null
  contractId: string | null
}

/** Vrai pour l'occupation d'une ressource par un contrat (ADR 018). */
export function isContractOccupation(booking: Pick<DisplayableBooking, 'kind'>): boolean {
  return booking.kind === 'contract'
}

/**
 * Référence du contrat d'une occupation. Le trigger titre l'occupation
 * « Contrat <référence> » : on la relit plutôt que de joindre `contracts` dans
 * chaque requête du planning.
 */
export function contractReference(booking: Pick<DisplayableBooking, 'title'>): string {
  return booking.title.replace(/^Contrat\s+/, '').trim() || booking.title
}

/**
 * Libellé principal d'un bloc du planning.
 *
 * - occupation : « Occupé — contrat CT-2026-0001 » ;
 * - blocage posé par l'équipe : « Indisponible — Entretien » ;
 * - réservation : son objet.
 */
export function bookingLabel(booking: Pick<DisplayableBooking, 'kind' | 'title'>): string {
  if (booking.kind === 'contract') return `Occupé — contrat ${contractReference(booking)}`
  if (booking.kind === 'unavailability') return `Indisponible — ${booking.title}`
  return booking.title
}

/**
 * Où mène un clic sur le bloc. Une occupation se gère depuis son contrat :
 * l'annuler ou la déplacer depuis la réservation est refusé par la base
 * (`CA001`), la fiche de réservation n'aurait rien à proposer.
 */
export function bookingHref(booking: Pick<DisplayableBooking, 'id' | 'kind' | 'contractId'>): string {
  if (booking.kind === 'contract' && booking.contractId) return `/contrats/${booking.contractId}`
  return `/reservations/${booking.id}`
}

/** Jour de fin, inclus, d'une occupation qui finit à minuit le lendemain. */
function lastDay(endsAt: Date, timeZone: string): string {
  return addDaysToIsoDate(toIsoDate(endsAt, timeZone), -1)
}

const longDate = (isoDate: string) =>
  new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T12:00:00Z`))

/**
 * Période d'une occupation de contrat, en jours du centre :
 * « du 1 mars 2026 au 30 juin 2026 », ou « depuis le 1 mars 2026, sans
 * terme » pour un contrat à durée indéterminée.
 */
export function occupationPeriodLabel(
  booking: Pick<DisplayableBooking, 'startsAt' | 'endsAt'>,
  timeZone: string,
): string {
  const premier = longDate(toIsoDate(booking.startsAt, timeZone))
  if (isOpenEndedBooking(booking)) return `depuis le ${premier}, sans terme`
  const dernier = lastDay(booking.endsAt, timeZone)
  if (dernier === toIsoDate(booking.startsAt, timeZone)) return `le ${premier}`
  return `du ${premier} au ${longDate(dernier)}`
}

/**
 * Horaire d'une réservation vu depuis une journée du centre.
 *
 * - journée entièrement couverte : « Toute la journée » ;
 * - commencée la veille : « jusqu'à 10:00 » ;
 * - finie le lendemain : « dès 18:00 » ;
 * - sinon : « 09:00 – 10:00 ».
 *
 * Jamais d'heure de fin pour une occupation sans terme.
 */
export function bookingTimeLabel(
  booking: Pick<DisplayableBooking, 'startsAt' | 'endsAt'>,
  isoDate: string,
  timeZone: string,
): string {
  const day = dayRangeUtc(isoDate, timeZone)
  const startsBefore = booking.startsAt.getTime() <= day.startsAt.getTime()
  const endsAfter = booking.endsAt.getTime() >= day.endsAt.getTime()
  if (startsBefore && endsAfter) return 'Toute la journée'
  if (startsBefore) return `jusqu’à ${formatTime(booking.endsAt, timeZone)}`
  if (endsAfter) return `dès ${formatTime(booking.startsAt, timeZone)}`
  return `${formatTime(booking.startsAt, timeZone)} – ${formatTime(booking.endsAt, timeZone)}`
}

/** Vrai quand la réservation couvre toute la journée du centre. */
export function coversDay(
  booking: Pick<DisplayableBooking, 'startsAt' | 'endsAt'>,
  isoDate: string,
  timeZone: string,
): boolean {
  const day = dayRangeUtc(isoDate, timeZone)
  return (
    booking.startsAt.getTime() <= day.startsAt.getTime() &&
    booking.endsAt.getTime() >= day.endsAt.getTime()
  )
}

/**
 * Place d'une réservation quand le planning est filtré sur un client.
 *
 * - `client` : la sienne, mise en avant ;
 * - `autre` : celle d'un autre ou sans client, réduite à « Occupé » — le
 *   créneau reste pris, il doit rester visible ;
 * - `tous` : pas de filtre, chaque réservation est affichée pour elle-même.
 */
export type BookingFocus = 'tous' | 'client' | 'autre'

export function bookingFocus(
  booking: Pick<DisplayableBooking, 'clientId'>,
  clientId: string | undefined,
): BookingFocus {
  if (!clientId) return 'tous'
  return booking.clientId === clientId ? 'client' : 'autre'
}

/**
 * Libellé d'état d'un bloc, écrit à côté de la couleur (CLAUDE.md : jamais
 * l'information par la couleur seule).
 */
export function bookingStateLabel(
  booking: Pick<DisplayableBooking, 'kind' | 'status'>,
): string {
  if (booking.status === 'cancelled') return 'Annulée'
  if (booking.kind === 'contract') return 'Sous contrat'
  if (booking.kind === 'unavailability') return 'Indisponible'
  return booking.status === 'pending' ? 'À valider' : 'Confirmée'
}

/**
 * Classes d'un bloc du planning, sur les jetons `--statut-*` de la charte :
 * le provisoire en bleu clair, l'acquis en bleu foncé, le reste en gris. Une
 * réservation n'est ni un succès ni une erreur, d'où l'absence de vert et de
 * rouge.
 */
export function bookingBlockClass(
  booking: Pick<DisplayableBooking, 'kind' | 'status'>,
  focus: BookingFocus = 'tous',
): string {
  if (focus === 'autre') return 'border-border bg-statut-annule text-muted-foreground'
  if (booking.kind === 'contract') return 'border-statut-confirme bg-statut-confirme/15 text-foreground'
  if (booking.kind === 'unavailability') return 'border-muted-foreground bg-statut-annule text-foreground'
  if (booking.status === 'pending') return 'border-statut-reserve bg-statut-reserve/15 text-foreground'
  return 'border-statut-confirme bg-statut-confirme/10 text-foreground'
}

/** Couleur pleine d'un segment de la barre d'occupation, mêmes jetons. */
export function bookingSegmentClass(
  booking: Pick<DisplayableBooking, 'kind' | 'status'>,
  focus: BookingFocus = 'tous',
): string {
  if (focus === 'autre') return 'bg-muted-foreground/40'
  if (booking.kind === 'unavailability') return 'bg-muted-foreground/60'
  if (booking.status === 'pending') return 'bg-statut-reserve'
  return 'bg-statut-confirme'
}
