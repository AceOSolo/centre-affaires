import { dayRangeUtc, formatCalendarDate, isCalendarDate, toIsoDate, todayIsoDate } from '../../lib/dates.ts'

/**
 * Règles des comptes du site (ADR 045), sans base ni Next : elles s'éprouvent
 * seules (`regles.test.ts`).
 */

/** Ce qu'il faut d'un bannissement pour dire s'il est en vigueur. */
export type BanLike = { bannedUntil: Date | null; liftedAt: Date | null }

/**
 * En vigueur : pas levé, et sans terme ou avant son terme. Le terme est exclu,
 * comme les bornes `[)` des réservations : banni jusqu'au 12 à 0 h, le compte
 * se reconnecte le 12 à 0 h.
 */
export function isBanActive(ban: BanLike, now: Date = new Date()): boolean {
  if (ban.liftedAt) return false
  return ban.bannedUntil === null || ban.bannedUntil.getTime() > now.getTime()
}

/** État d'un compte tel que l'écran le montre : en texte, jamais à la seule couleur. */
export type AccountState =
  | { kind: 'actif' }
  | { kind: 'banni'; until: Date | null }

/** Le bannissement en vigueur le plus contraignant l'emporte : sans terme, puis le plus lointain. */
export function accountState(bans: readonly BanLike[], now: Date = new Date()): AccountState {
  const active = bans.filter((ban) => isBanActive(ban, now))
  if (active.length === 0) return { kind: 'actif' }
  if (active.some((ban) => ban.bannedUntil === null)) return { kind: 'banni', until: null }
  const until = Math.max(...active.map((ban) => ban.bannedUntil!.getTime()))
  return { kind: 'banni', until: new Date(until) }
}

export type BanDuration = 'definitif' | 'temporaire'

export type BanFormValues = { reason: string; duration: string; until: string }

export type BanInput = { reason: string; bannedUntil: Date | null }

export type BanFormErrors = { reason?: string; until?: string }

export const REASON_MAX = 500

/**
 * Lecture du formulaire de bannissement. `until` est un jour civil du centre,
 * **inclus** : banni jusqu'au 11, le compte se reconnecte le 12 à 0 h, heure
 * du centre (stockée en UTC, décision 4).
 */
export function readBanForm(
  values: BanFormValues,
  timeZone: string,
  now: Date = new Date(),
): { input: BanInput } | { errors: BanFormErrors } {
  const errors: BanFormErrors = {}
  const reason = values.reason.trim()
  if (!reason) errors.reason = 'Indiquez le motif : il reste dans l’historique du compte.'
  else if (reason.length > REASON_MAX) errors.reason = `Le motif tient en ${REASON_MAX} caractères.`

  let bannedUntil: Date | null = null
  if (values.duration === 'temporaire') {
    if (!isCalendarDate(values.until)) {
      errors.until = 'Choisissez le dernier jour du bannissement.'
    } else if (values.until < todayIsoDate(timeZone, now)) {
      errors.until = 'Ce jour est passé : choisissez aujourd’hui ou un jour à venir.'
    } else {
      bannedUntil = dayRangeUtc(values.until, timeZone).endsAt
    }
  } else if (values.duration !== 'definitif') {
    errors.until = 'Choisissez une durée.'
  }

  if (Object.keys(errors).length > 0) return { errors }
  return { input: { reason, bannedUntil } }
}

/**
 * Dernier jour d'un bannissement temporaire, jour civil du centre : le terme
 * est exclu, c'est donc la veille du jour où il tombe (banni jusqu'au 11
 * inclus, terme le 12 à 0 h).
 */
export function banLastDay(bannedUntil: Date, timeZone: string): string {
  return toIsoDate(new Date(bannedUntil.getTime() - 1), timeZone)
}

/** « Actif », « Banni », « Banni jusqu'au 11/11/2026 inclus ». */
export function accountStateLabel(state: AccountState, timeZone: string): string {
  if (state.kind === 'actif') return 'Actif'
  if (!state.until) return 'Banni'
  return `Banni jusqu’au ${formatCalendarDate(banLastDay(state.until, timeZone))} inclus`
}
