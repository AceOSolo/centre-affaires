import type { TimeRange } from './availability.ts'
import { DEFAULT_REQUEST_POLICY, requestTimingRejection, type RequestPolicy } from './request-policy.ts'

/**
 * Règles de recevabilité d'une demande déposée depuis la page publique
 * (ADR 005).
 *
 * C'est le premier point d'écriture non authentifié du produit : ce qui arrive
 * ici n'a été filtré par personne. Les règles sont pures et testées, l'action
 * serveur ne fait que les appliquer.
 */

/** Durées acceptées pour une demande publique. */
export const MIN_REQUEST_MINUTES = 30
export const MAX_REQUEST_MINUTES = 8 * 60

/** Horizon par défaut ; le réglage du centre est appliqué aux demandes réelles. */
export const MAX_DAYS_AHEAD = 90

/** Nombre de demandes acceptées depuis la même adresse sur une fenêtre glissante. */
export const MAX_REQUESTS_PER_EMAIL = 5
export const RATE_WINDOW_HOURS = 24

export type RequestRejection =
  | 'nom-manquant'
  | 'email-invalide'
  | 'telephone-manquant'
  | 'objet-manquant'
  | 'creneau-illisible'
  | 'creneau-passe'
  | 'preavis-insuffisant'
  | 'creneau-trop-lointain'
  | 'duree-trop-courte'
  | 'duree-trop-longue'
  | 'ressource-indisponible'
  | 'trop-de-demandes'

export const rejectionMessages: Record<RequestRejection, string> = {
  'nom-manquant': 'Indiquez votre nom.',
  'email-invalide': 'Indiquez une adresse électronique valide.',
  'telephone-manquant': 'Indiquez un numéro de téléphone.',
  'objet-manquant': "Indiquez l'objet de la réunion.",
  'creneau-illisible': 'Date ou horaires illisibles.',
  'creneau-passe': 'Ce créneau est déjà passé.',
  'preavis-insuffisant': 'Ce créneau ne respecte pas le préavis minimum de réservation.',
  'creneau-trop-lointain': `Les demandes sont ouvertes jusqu'à ${MAX_DAYS_AHEAD} jours à l'avance. Au-delà, contactez-nous directement.`,
  'duree-trop-courte': `La durée minimale est de ${MIN_REQUEST_MINUTES} minutes.`,
  'duree-trop-longue': `Au-delà de ${MAX_REQUEST_MINUTES / 60} heures, contactez-nous pour une location à la journée.`,
  'ressource-indisponible': "Cet espace n'est pas réservable en ligne.",
  'trop-de-demandes': `Vous avez déposé ${MAX_REQUESTS_PER_EMAIL} demandes en ${RATE_WINDOW_HOURS} heures. Contactez-nous directement pour la suite.`,
}

/**
 * Adresse plausible, pas adresse vérifiée. Une validation stricte de la RFC
 * rejette des adresses valides ; seule la réponse au message prouve qu'elle
 * existe.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export type RequestInput = {
  name: string
  email: string
  phone: string
  title: string
  range: TimeRange
  resourceIsBookable: boolean
  recentRequestCount: number
}

/**
 * Première raison de refuser, ou `undefined` si la demande est recevable.
 *
 * L'ordre compte : on signale d'abord ce que le demandeur peut corriger dans le
 * formulaire, ensuite ce qui tient au créneau.
 */
export function rejectRequest(
  input: RequestInput,
  now: Date = new Date(),
  policy: RequestPolicy = DEFAULT_REQUEST_POLICY,
): RequestRejection | undefined {
  if (!input.name.trim()) return 'nom-manquant'
  if (!EMAIL.test(input.email.trim())) return 'email-invalide'
  if (!input.phone.trim()) return 'telephone-manquant'
  if (!input.title.trim()) return 'objet-manquant'

  const { startsAt, endsAt } = input.range
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    return 'creneau-illisible'
  }

  const minutes = (endsAt.getTime() - startsAt.getTime()) / 60_000
  if (minutes < MIN_REQUEST_MINUTES) return 'duree-trop-courte'
  if (minutes > MAX_REQUEST_MINUTES) return 'duree-trop-longue'

  // Le créneau doit commencer dans le futur. La contrainte d'exclusion, elle,
  // laisserait très bien réserver l'année dernière.
  const timingRejection = requestTimingRejection(startsAt, policy, now)
  if (timingRejection) return timingRejection

  if (!input.resourceIsBookable) return 'ressource-indisponible'
  if (input.recentRequestCount >= MAX_REQUESTS_PER_EMAIL) return 'trop-de-demandes'

  return undefined
}
