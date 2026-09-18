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

export const contractStatusStyles: Record<ContractStatus, string> = {
  draft: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  terminated: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400',
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
