import type { RatePlanValidity, RatePlanValidityState } from './tarifs.ts'

/** « 01/03/2026 » : une date de calendrier, identique dans tous les fuseaux. */
function formatDay(isoDate: string): string {
  return `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}/${isoDate.slice(0, 4)}`
}

/** « du 01/01/2026 au 31/12/2026 », « à partir du 01/01/2026 », « sans limite ». */
export function formatRatePlanValidity(plan: Pick<RatePlanValidity, 'validFrom' | 'validTo'>): string {
  if (plan.validFrom && plan.validTo) return `du ${formatDay(plan.validFrom)} au ${formatDay(plan.validTo)}`
  if (plan.validFrom) return `à partir du ${formatDay(plan.validFrom)}`
  if (plan.validTo) return `jusqu’au ${formatDay(plan.validTo)}`
  return 'sans limite de dates'
}

/** L'état d'une grille se dit en toutes lettres ; la couleur ne fait que le redoubler. */
export const ratePlanValidityLabels: Record<RatePlanValidityState, string> = {
  current: 'En vigueur',
  upcoming: 'Pas encore en vigueur',
  expired: 'Expirée',
  archived: 'Archivée',
}

/** Pastilles d'état, dans les bleus de la charte : un état n'est pas une erreur. */
export const ratePlanValidityStyles: Record<RatePlanValidityState, string> = {
  current: 'bg-primary/10 text-primary',
  upcoming: 'bg-accent/15 text-primary',
  expired: 'bg-muted text-muted-foreground',
  archived: 'bg-muted text-foreground',
}
