import type { ClientBookingMode } from '../ressources/schema.ts'
import type { TimeRange } from './availability.ts'
import { fitsFreeRange } from './public-selection.ts'
import { requestTimingRejection, type RequestPolicy } from './request-policy.ts'
import { MIN_REQUEST_MINUTES } from './requests.ts'

/**
 * Règles de la réservation depuis l'espace client (R23, ADR 016 décision D4,
 * ADR 036). Sans base ni framework, pour être éprouvées seules
 * (`portail-regles.test.ts`).
 *
 * La base a le dernier mot : elle pose le statut d'une réservation du portail
 * selon le réglage de sa ressource (`bookings_apply_client_booking_mode`),
 * refuse une ressource fermée (CA009) et un créneau pris (23P01). Ce module
 * annonce au client ce qui va se passer, et refuse avant l'écriture ce qu'il
 * peut corriger lui-même.
 */

/** Ressource proposée dans l'espace client : tout sauf `closed`. */
export type PortalBookingMode = Exclude<ClientBookingMode, 'closed'>

export function isPortalBookable(mode: ClientBookingMode): mode is PortalBookingMode {
  return mode !== 'closed'
}

/** Ce qu'une réservation du portail devient à l'écriture. */
export type PortalBookingOutcome = 'confirmed' | 'pending'

/**
 * Le statut que la base posera, annoncé avant l'envoi : confirmée d'emblée
 * pour une ressource à confirmation immédiate **dont le tarif est calculé**
 * (le devis est figé à l'écriture) ; en attente de l'accueil sinon. Jumeau du
 * trigger `bookings_apply_client_booking_mode` (migration 0041) ; après
 * l'écriture, l'écran lit le statut rendu par la base, pas celui-ci.
 */
export function expectedPortalOutcome(mode: PortalBookingMode, priced: boolean): PortalBookingOutcome {
  return mode === 'instant' && priced ? 'confirmed' : 'pending'
}

/** Comment la ressource se réserve, dit au client sur sa carte. */
export const portalModeLabels: Record<PortalBookingMode, string> = {
  instant: 'Confirmation immédiate',
  approval: 'Sur validation de l’accueil',
}

/** Ce qui se passera à l'envoi, dit avant que le client ne valide. */
export function portalOutcomeNotice(mode: PortalBookingMode, priced: boolean): string {
  if (expectedPortalOutcome(mode, priced) === 'confirmed') {
    return 'Confirmation immédiate : la réservation est ferme dès l’envoi, au montant affiché.'
  }
  if (mode === 'instant') {
    return 'Le tarif de ce créneau n’est pas calculé : votre demande sera confirmée par l’accueil, qui vous précisera le montant.'
  }
  return 'Sur validation : votre demande est transmise à l’accueil, qui la confirme. Le créneau vous est bloqué en attendant.'
}

/** Titre et texte du message rendu après l'écriture, selon le statut posé par la base. */
export function portalOutcomeMessage(
  outcome: PortalBookingOutcome,
  facts: { resourceName: string; when: string },
): { title: string; body: string } {
  if (outcome === 'confirmed') {
    return {
      title: 'Réservation confirmée',
      body: `« ${facts.resourceName} » vous est réservée ${facts.when}. Elle figure dans vos réservations à venir ; pour l’annuler, contactez le centre.`,
    }
  }
  return {
    title: 'Demande envoyée à l’accueil',
    body: `Votre demande pour « ${facts.resourceName} » ${facts.when} attend la validation de l’accueil. Le créneau vous est bloqué en attendant, et vous pouvez annuler la demande tant qu’elle n’est pas validée.`,
  }
}

/** Raisons de refuser une réservation du portail avant de l'écrire. */
export type PortalBookingRejection =
  | 'creneau-illisible'
  | 'duree-trop-courte'
  | 'creneau-passe'
  | 'preavis-insuffisant'
  | 'creneau-trop-lointain'
  | 'creneau-indisponible'

export const portalRejectionMessages: Record<PortalBookingRejection, string> = {
  'creneau-illisible': 'Choisissez une date, puis une heure de début et une heure de fin.',
  'duree-trop-courte': `La durée minimale est de ${MIN_REQUEST_MINUTES} minutes.`,
  'creneau-passe': 'Ce créneau est déjà passé.',
  'preavis-insuffisant': 'Ce créneau ne respecte pas le préavis minimum de réservation du centre.',
  'creneau-trop-lointain': 'Ce créneau est au-delà de l’horizon de réservation du centre.',
  'creneau-indisponible': 'Ce créneau n’est plus disponible. Choisissez de nouveaux horaires.',
}

/**
 * Première raison de refuser le créneau, ou `undefined`. Mêmes règles que la
 * page publique (durée minimale, préavis et horizon du centre), sans la durée
 * maximale de huit heures : un client réserve jusqu'à la fin d'une plage
 * d'ouverture. Le créneau doit tenir dans une plage libre (`free`, déjà
 * coupée par le préavis) : il n'enjambe ni une fermeture ni une réservation.
 */
export function portalBookingRejection(
  range: TimeRange | undefined,
  free: readonly TimeRange[],
  policy: RequestPolicy,
  now: Date,
): PortalBookingRejection | undefined {
  if (!range || Number.isNaN(range.startsAt.getTime()) || Number.isNaN(range.endsAt.getTime())) {
    return 'creneau-illisible'
  }
  if (range.endsAt.getTime() - range.startsAt.getTime() < MIN_REQUEST_MINUTES * 60_000) {
    return 'duree-trop-courte'
  }
  const timing = requestTimingRejection(range.startsAt, policy, now)
  if (timing) return timing
  if (!fitsFreeRange(range, free)) return 'creneau-indisponible'
  return undefined
}

/** Objet affiché au planning de l'équipe : celui saisi, ou le nom de l'entreprise. */
export const MAX_PORTAL_TITLE_LENGTH = 200
export const MAX_PORTAL_NOTES_LENGTH = 2000

export function portalBookingTitle(title: string, clientName: string): string {
  const trimmed = title.trim().replace(/\s+/g, ' ')
  return (trimmed || `Réservation ${clientName}`).slice(0, MAX_PORTAL_TITLE_LENGTH)
}
