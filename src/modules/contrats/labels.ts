import type { AmendmentStatus, BillingPeriod, ContractStatus, ContractType } from './schema.ts'

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

/**
 * État d'un avenant, dit en toutes lettres (jamais par la seule couleur) :
 * brouillon, signé, ou abandonné.
 */
export function amendmentStateLabel(amendment: {
  status: AmendmentStatus
  deletedAt: Date | null
}): string {
  if (amendment.deletedAt) return 'Abandonné'
  return amendment.status === 'signed' ? 'Signé' : 'Brouillon'
}

/** Mêmes bleus que les contrats : provisoire, en vigueur, éteint. */
export function amendmentStateStyle(amendment: {
  status: AmendmentStatus
  deletedAt: Date | null
}): string {
  if (amendment.deletedAt) return 'bg-muted text-muted-foreground'
  return amendment.status === 'signed' ? 'bg-primary text-primary-foreground' : 'bg-accent/15 text-primary'
}

/**
 * Ce que change un avenant, en une phrase : « Prix : 950,00 € par mois.
 * Ressource : Bureau 2 (BUR-A2). » `formatAmount` rend un montant en
 * centimes ; l'appelant y met la devise.
 */
export function amendmentChangesLabel(
  amendment: {
    amountCents: number | null
    lineCount: number
    changesResource: boolean
    resource: { code: string; name: string } | null
  },
  formatAmount: (cents: number) => string,
  period: BillingPeriod,
): string {
  const parts: string[] = []
  if (amendment.lineCount > 0 && amendment.amountCents !== null) {
    parts.push(
      `Prix : ${formatAmount(amendment.amountCents)} ${billingPeriodSuffixes[period]}, en ${amendment.lineCount} ligne${amendment.lineCount > 1 ? 's' : ''}.`,
    )
  } else if (amendment.amountCents !== null) {
    parts.push(`Prix : ${formatAmount(amendment.amountCents)} ${billingPeriodSuffixes[period]}.`)
  }
  if (amendment.changesResource) {
    parts.push(
      amendment.resource
        ? `Ressource : ${amendment.resource.name} (${amendment.resource.code}).`
        : 'Ressource retirée.',
    )
  }
  return parts.join(' ') || 'Ne change encore rien.'
}
