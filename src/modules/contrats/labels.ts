import type { BillingPeriod, ContractStatus, ContractType } from './schema.ts'

export const contractTypeLabels: Record<ContractType, string> = {
  domiciliation: 'Domiciliation',
  bureau: 'Bureau privatif',
  coworking: 'Coworking',
  autre: 'Autre prestation',
}

export const contractStatusLabels: Record<ContractStatus, string> = {
  draft: 'Brouillon',
  active: 'En cours',
  terminated: 'Résilié',
}

/** Même progression que les réservations : provisoire, en vigueur, éteint. */
export const contractStatusStyles: Record<ContractStatus, string> = {
  draft: 'bg-accent/15 text-primary',
  active: 'bg-primary text-primary-foreground',
  terminated: 'bg-muted text-muted-foreground',
}

export const billingPeriodLabels: Record<BillingPeriod, string> = {
  monthly: 'Mensuelle',
  quarterly: 'Trimestrielle',
  yearly: 'Annuelle',
}

/** « par mois » — suffixe d'un montant récurrent. */
export const billingPeriodSuffixes: Record<BillingPeriod, string> = {
  monthly: 'par mois',
  quarterly: 'par trimestre',
  yearly: 'par an',
}
