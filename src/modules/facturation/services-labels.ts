import type { RateUnit, ServiceNature } from './schema.ts'

/**
 * Libellés du catalogue de services, des offres et des souscriptions (R09,
 * R18). À part de `labels.ts` (grilles) pour que chaque écran n'importe que ce
 * qu'il affiche.
 */

export const serviceNatureLabels: Record<ServiceNature, string> = {
  package: 'Forfait',
  act: 'Acte',
}

/** Ce que la nature veut dire, sous le choix du formulaire. */
export const serviceNatureHints: Record<ServiceNature, string> = {
  package: 'Dû par période : standard téléphonique, assistante, réexpédition hebdomadaire.',
  act: 'Dû à chaque exécution : ouverture d’un pli, numérisation. Toujours à l’unité.',
}

/** État d'un service du catalogue : actif, inactif (plus proposé), archivé. */
export type ServiceState = 'active' | 'inactive' | 'archived'

export const serviceStateLabels: Record<ServiceState, string> = {
  active: 'Proposé',
  inactive: 'Plus proposé',
  archived: 'Archivé',
}

/** Le texte porte l'état ; la teinte ne fait que l'accompagner (ADR 004). */
export const serviceStateStyles: Record<ServiceState, string> = {
  active: 'bg-primary text-primary-foreground',
  inactive: 'bg-accent/15 text-primary',
  archived: 'bg-muted text-muted-foreground',
}

export function serviceState(service: { isActive: boolean; deletedAt: Date | null }): ServiceState {
  if (service.deletedAt) return 'archived'
  return service.isActive ? 'active' : 'inactive'
}

/** Cible d'une ligne d'offre. */
export type OfferTarget = 'resource_type' | 'resource' | 'service'

export const offerTargetLabels: Record<OfferTarget, string> = {
  resource_type: 'Un type de ressource',
  resource: 'Une ressource précise',
  service: 'Un service du catalogue',
}

/** Façon de fixer le prix d'une ligne d'offre (ADR 024) : au plus une. */
export type OfferPricing = 'catalogue' | 'price' | 'discount_bp' | 'discount_amount'

export const offerPricingLabels: Record<OfferPricing, string> = {
  catalogue: 'Prix du catalogue',
  price: 'Prix forfaitaire',
  discount_bp: 'Remise en pourcentage',
  discount_amount: 'Remise en montant',
}

/** Noms d'unité, au singulier et au pluriel : « 1 mois », « 3 demi-journées ». */
const unitNouns: Record<RateUnit, readonly [string, string]> = {
  hour: ['h', 'h'],
  half_day: ['demi-journée', 'demi-journées'],
  day: ['jour', 'jours'],
  week: ['semaine', 'semaines'],
  month: ['mois', 'mois'],
  unit: ['unité', 'unités'],
}

/** « 3 mois », « 10 unités », « 5 h » : une quantité et son unité. */
export function formatQuantity(quantity: number, unit: RateUnit): string {
  const [singular, plural] = unitNouns[unit]
  return `${quantity} ${quantity > 1 ? plural : singular}`
}
