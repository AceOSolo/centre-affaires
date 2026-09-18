import type { RateUnit } from './schema.ts'

export const rateUnitLabels: Record<RateUnit, string> = {
  hour: "À l'heure",
  day: 'À la journée',
  month: 'Au mois',
  unit: 'Au forfait',
}

/** Suffixe accolé à un prix : « 25,00 € / h ». */
export const rateUnitSuffixes: Record<RateUnit, string> = {
  hour: '/ h',
  day: '/ jour',
  month: '/ mois',
  unit: '/ prestation',
}
