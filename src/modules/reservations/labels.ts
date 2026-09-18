import type { BookingStatus } from './schema.ts'

/**
 * Libellés et couleurs des états d'une réservation.
 *
 * La couleur ne porte jamais l'information seule (ADR 004) : chaque bloc du
 * planning et chaque ligne du tableau affichent aussi le libellé.
 */
export const bookingStatusLabels: Record<BookingStatus, string> = {
  pending: 'À valider',
  confirmed: 'Confirmée',
  cancelled: 'Annulée',
}

export const bookingStatusBadgeStyles: Record<BookingStatus, string> = {
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  confirmed: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  cancelled: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
}

/** Bloc posé sur le planning. Seules les réservations qui occupent y figurent. */
export const bookingBlockStyles: Record<Exclude<BookingStatus, 'cancelled'>, string> = {
  pending: 'border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200',
  confirmed: 'border-sky-500 bg-sky-50 text-sky-900 dark:bg-sky-950/60 dark:text-sky-200',
}
