import { isCalendarDate } from '../../lib/dates.ts'

/**
 * Dernier contact de l'équipe avec une entreprise (R29, ADR 040) : un appel,
 * un rendez-vous, une visite. C'est l'une des dates dont part la durée de
 * conservation : un prospect qu'on rappelle ne s'anonymise pas.
 *
 * Un jour du calendrier du centre, jamais dans le futur : une date à venir
 * repousserait l'anonymisation d'autant, sans contact réel.
 */
export type LastContactResult = { ok: true; date: string } | { ok: false; error: string }

export function parseLastContact(value: string | null | undefined, today: string): LastContactResult {
  const date = (value ?? '').trim()
  if (!date) return { ok: false, error: 'Indiquez la date du contact.' }
  if (!isCalendarDate(date)) return { ok: false, error: 'Date illisible. Exemple : 02/10/2026.' }
  if (date > today) {
    return { ok: false, error: 'Le contact a déjà eu lieu : la date ne peut pas être à venir.' }
  }
  return { ok: true, date }
}
