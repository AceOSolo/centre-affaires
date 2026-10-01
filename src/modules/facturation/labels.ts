import type { RateUnit } from './schema.ts'

export const rateUnitLabels: Record<RateUnit, string> = {
  hour: "À l'heure",
  half_day: 'À la demi-journée',
  day: 'À la journée',
  week: 'À la semaine',
  month: 'Au mois',
  unit: 'Au forfait',
}

/** Suffixe accolé à un prix : « 25,00 € / h ». */
export const rateUnitSuffixes: Record<RateUnit, string> = {
  hour: '/ h',
  half_day: '/ demi-journée',
  day: '/ jour',
  week: '/ semaine',
  month: '/ mois',
  unit: '/ prestation',
}
