import { describeBusyBooking, type BusyBooking } from '../reservations/occupation.ts'

/**
 * Message rendu à l'équipe quand la base refuse l'occupation d'un contrat
 * (`23P01`, ADR 018) : quelle ressource, occupée par quoi, et que faire.
 *
 * Jamais l'erreur SQL brute. Pure, pour être éprouvée sans base.
 */
export function occupationConflictMessage(
  resource: { name: string; code: string } | undefined,
  conflicts: readonly BusyBooking[],
  timeZone: string,
): string {
  const name = resource ? `La ressource ${resource.name} (${resource.code})` : 'La ressource'
  const busy = conflicts.map((conflict) => describeBusyBooking(conflict, timeZone)).join(' ; ')
  return busy
    ? `${name} est déjà occupée sur la période du contrat : ${busy}. Choisissez une autre ressource, ou libérez celle-ci avant de recommencer.`
    : `${name} est déjà occupée sur la période du contrat. Choisissez une autre ressource, ou libérez celle-ci avant de recommencer.`
}
