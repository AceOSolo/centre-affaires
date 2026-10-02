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
