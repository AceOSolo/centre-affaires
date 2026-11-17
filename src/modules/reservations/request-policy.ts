import type { TimeRange } from './availability.ts'

export type RequestPolicy = { bookingLeadHours: number; bookingHorizonDays: number }
export const DEFAULT_REQUEST_POLICY: RequestPolicy = { bookingLeadHours: 0, bookingHorizonDays: 90 }

export function validRequestPolicy(policy: RequestPolicy): boolean {
  return Number.isInteger(policy.bookingLeadHours) && Number.isInteger(policy.bookingHorizonDays) &&
    policy.bookingLeadHours >= 0 && policy.bookingHorizonDays >= 1 && policy.bookingHorizonDays <= 365 &&
    policy.bookingLeadHours < policy.bookingHorizonDays * 24
}

export function requestBounds(policy: RequestPolicy, now: Date) {
  return {
    earliest: new Date(now.getTime() + policy.bookingLeadHours * 3_600_000),
    latest: new Date(now.getTime() + policy.bookingHorizonDays * 86_400_000),
  }
}

/** Les bornes limitent les départs ; la durée reste contrôlée séparément. */
export function requestTimingRejection(startsAt: Date, policy: RequestPolicy, now: Date) {
  const { earliest, latest } = requestBounds(policy, now)
  if (startsAt <= now) return 'creneau-passe' as const
  if (startsAt < earliest) return 'preavis-insuffisant' as const
  if (startsAt > latest) return 'creneau-trop-lointain' as const
}

export function requestPolicyMessage(policy: RequestPolicy): string {
  return `Demandes jusqu’à ${policy.bookingHorizonDays} jours à l’avance${policy.bookingLeadHours ? `, avec un préavis minimum de ${policy.bookingLeadHours} h` : ', sans préavis minimum'}.`
}

/** Coupe le début des plages libres ; garde la fin pour les durées autorisées. */
export function requestableRanges(free: readonly TimeRange[], policy: RequestPolicy, now: Date): TimeRange[] {
  const { earliest, latest } = requestBounds(policy, now)
  return free.flatMap((range) => {
    const first = Math.max(range.startsAt.getTime(), earliest.getTime(), now.getTime() + 1)
    const startsAt = new Date(Math.ceil(first / 900_000) * 900_000)
    return startsAt < range.endsAt && startsAt <= latest ? [{ startsAt, endsAt: range.endsAt }] : []
  })
}

/**
 * Plafonds des formules de location des bureaux et délai de modification par
 * le client (ADR 076), tels que « Disponibilités » les saisit : un entier
 * dans les bornes de la base (`tenants_booking_formulas_valid`), champ par
 * champ.
 */
export type ClientRulesInput = { bookingMaxWeeks: number; bookingMaxMonths: number; bookingChangeDays: number }

export const clientRulesBounds: Record<keyof ClientRulesInput, { min: number; max: number }> = {
  bookingMaxWeeks: { min: 1, max: 52 },
  bookingMaxMonths: { min: 1, max: 24 },
  bookingChangeDays: { min: 0, max: 90 },
}

export function parseClientRules(
  source: { get(name: string): unknown },
): { ok: true; rules: ClientRulesInput } | { ok: false; errors: Partial<Record<keyof ClientRulesInput, string>> } {
  const errors: Partial<Record<keyof ClientRulesInput, string>> = {}
  const rules = {} as ClientRulesInput
  for (const [name, { min, max }] of Object.entries(clientRulesBounds) as [keyof ClientRulesInput, { min: number; max: number }][]) {
    const raw = String(source.get(name) ?? '').trim()
    const value = Number(raw)
    if (!raw || !Number.isInteger(value) || value < min || value > max) {
      errors[name] = `Un nombre entier, de ${min} à ${max}.`
    } else {
      rules[name] = value
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, rules }
}
