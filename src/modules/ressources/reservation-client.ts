import { clientBookingModes, type ClientBookingMode, type ResourceType } from './schema.ts'

/**
 * Réglage « réservation depuis l'espace client » d'une ressource (R23,
 * ADR 016 décision D4, ADR 036), tel que le back-office le montre et le
 * saisit. Module pur : la fiche ressource, le formulaire de création et les
 * tests passent par les mêmes règles. La base applique le réglage
 * (`bookings_apply_client_booking_mode`) ; ce module ne fait que le dire.
 */

/** Libellé court, sur la fiche et dans le formulaire. */
export const clientBookingModeLabels: Record<ClientBookingMode, string> = {
  instant: 'Confirmation immédiate',
  approval: 'Accord de l’accueil',
  closed: 'Fermée à l’espace client',
}

/** Ce que le réglage fait, en toutes lettres, pour l'équipe. */
export const clientBookingModeDescriptions: Record<ClientBookingMode, string> = {
  instant:
    'Le client réserve depuis son espace et sa réservation est confirmée aussitôt, au tarif calculé et figé. Sans tarif applicable ce jour-là, elle attend l’accueil.',
  approval:
    'Le client dépose une demande depuis son espace. Elle bloque le créneau jusqu’à ce que l’accueil la valide ou la refuse, dans « Demandes ».',
  closed:
    'La ressource n’est pas proposée dans l’espace client : elle se loue par contrat ou se réserve auprès de l’accueil.',
}

/**
 * Valeur proposée à la création. La base donne `approval` à toute ressource
 * nouvelle ; l'écran propose de fermer au portail les casiers et les boîtes
 * aux lettres, qui se louent par contrat (ADR 018, ADR 036, *à valider*).
 */
export function defaultClientBookingMode(resourceType: ResourceType): ClientBookingMode {
  return resourceType === 'casier' || resourceType === 'boite_aux_lettres' ? 'closed' : 'approval'
}

/** Valeur saisie, ou `undefined` si elle n'est pas l'un des trois réglages. */
export function parseClientBookingMode(raw: string | null | undefined): ClientBookingMode | undefined {
  const value = (raw ?? '').trim()
  return clientBookingModes.find((mode) => mode === value)
}
