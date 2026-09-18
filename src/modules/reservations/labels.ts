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

/**
 * Progression du provisoire vers l'acquis, portée par les deux bleus de marque
 * (ADR 004) : aplat clair tant que la réservation n'engage pas, bleu foncé
 * plein une fois confirmée, gris quand elle ne compte plus. Pas de vert ni de
 * rouge — une réservation n'est ni un succès ni une erreur.
 */
export const bookingStatusBadgeStyles: Record<BookingStatus, string> = {
  pending: 'bg-accent/15 text-primary',
  confirmed: 'bg-primary text-primary-foreground',
  cancelled: 'bg-muted text-muted-foreground',
}

/** Bloc posé sur le planning. Seules les réservations qui occupent y figurent. */
export const bookingBlockStyles: Record<Exclude<BookingStatus, 'cancelled'>, string> = {
  pending: 'border-accent bg-accent/10 text-foreground',
  confirmed: 'border-primary bg-primary/10 text-foreground',
}
