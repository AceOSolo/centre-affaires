import type { ResourceType } from '../ressources/schema.ts'
import type { RateUnit } from './schema.ts'

/**
 * Résolution du tarif applicable et quantité due.
 *
 * Tous les montants sont des entiers de centimes (décision 5). Aucune division
 * ne subsiste dans un résultat : la quantité est entière, le prix unitaire aussi.
 * Le montant d'un devis est calculé par `devis.ts`, par la règle d'arrondi
 * unique de l'ADR 023.
 */

/** Ce qu'il faut d'une ligne de grille pour décider. */
export type RateCandidate = {
  resourceType: ResourceType
  resourceId: string | null
  unit: RateUnit
  amountCents: number
}

/** Ce qu'il faut d'une grille pour savoir si elle s'applique un jour donné. */
export type RatePlanValidity = {
  /** Dates de calendrier, bornes comprises. Nulles : sans borne. */
  validFrom: string | null
  validTo: string | null
  /** Une grille archivée ne s'applique plus, à aucune date. */
  deletedAt?: Date | null
}

/**
 * La grille s'applique-t-elle ce jour-là (R08, ADR 023) ?
 *
 * `isoDate` est un jour du centre : celui de la prestation (le début de la
 * réservation), pas celui de la saisie. Une grille « valable du 1er janvier »
 * chiffre les réservations à partir du 1er janvier, même saisies en décembre.
 */
export function isRatePlanValidOn(plan: RatePlanValidity, isoDate: string): boolean {
  if (plan.deletedAt) return false
  if (plan.validFrom && isoDate < plan.validFrom) return false
  if (plan.validTo && isoDate > plan.validTo) return false
  return true
}

/** Où en est une grille par rapport à un jour : pour l'afficher, jamais pour décider seul. */
export type RatePlanValidityState = 'archived' | 'upcoming' | 'current' | 'expired'

export function ratePlanValidityState(
  plan: RatePlanValidity,
  isoDate: string,
): RatePlanValidityState {
  if (plan.deletedAt) return 'archived'
  if (plan.validFrom && isoDate < plan.validFrom) return 'upcoming'
  if (plan.validTo && isoDate > plan.validTo) return 'expired'
  return 'current'
}

export type RateLookup = {
  resourceId: string
  resourceType: ResourceType
  unit: RateUnit
  /** Jour du centre auquel le prix s'applique : une grille hors validité ne répond pas. */
  on: string
}

/**
 * Tarif applicable, le plus précis d'abord.
 *
 * Une ligne nominative — « la salle Europe à 40 € de l'heure » — l'emporte sur
 * la ligne de type — « les salles à 25 € de l'heure ». C'est ce qui permet de
 * faire payer plus cher la grande salle sans dupliquer toute la grille.
 *
 * L'unicité des lignes est tenue par deux index partiels (migration 0005) : à
 * précision égale il ne peut pas y avoir deux candidats.
 *
 * Une grille absente, archivée ou hors de ses dates de validité le jour
 * demandé ne tarife rien (R08) : le lecteur n'a pas à le vérifier lui-même.
 */
export function resolveRate<T extends RateCandidate>(
  plan: (RatePlanValidity & { items: readonly T[] }) | null | undefined,
  lookup: RateLookup,
): T | undefined {
  if (!plan || !isRatePlanValidOn(plan, lookup.on)) return undefined
  return pickRateItem(plan.items, lookup)
}

/**
 * La ligne nominative avant la ligne de type, parmi les lignes d'une grille
 * **déjà reconnue en vigueur** (`resolveRate` le vérifie ; un chargeur comme
 * `findDefaultRatePlan(on)` aussi). `resourceId` nul : seule la ligne de type
 * répond — une ligne d'offre ou de contrat qui vise un type de ressource.
 */
export function pickRateItem<T extends RateCandidate>(
  items: readonly T[],
  lookup: { resourceId: string | null; resourceType: ResourceType; unit: RateUnit },
): T | undefined {
  const applicable = items.filter(
    (item) => item.unit === lookup.unit && item.resourceType === lookup.resourceType,
  )
  return (
    (lookup.resourceId === null
      ? undefined
      : applicable.find((item) => item.resourceId === lookup.resourceId)) ??
    applicable.find((item) => item.resourceId === null)
  )
}

/**
 * Règles du centre qui fixent la quantité due (ADR 023) : colonnes
 * `half_day_minutes` et `started_unit_tolerance_minutes` de `tenants`.
 */
export type QuantityRules = {
  /** Durée d'une demi-journée vendue, en minutes (240 par défaut, ADR 009). */
  halfDayMinutes: number
  /** Minutes tolérées avant qu'une unité entamée soit due (0 par défaut, ADR 006). */
  startedUnitToleranceMinutes: number
}

/**
 * Valeurs par défaut des colonnes du centre, qui reprennent les conventions
 * des ADR 006 et 009. Pour les tests et les exemples : le code de production
 * lit toujours les règles du centre en base.
 */
export const DEFAULT_QUANTITY_RULES: QuantityRules = {
  halfDayMinutes: 240,
  startedUnitToleranceMinutes: 0,
}

const MINUTES_PER_HOUR = 60
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR

/**
 * Durée d'une unité, en minutes. `month` et `unit` sont des forfaits : ils
 * n'ont pas de durée et ne se comptent pas ainsi.
 */
export function unitMinutes(unit: RateUnit, rules: QuantityRules): number | undefined {
  if (unit === 'hour') return MINUTES_PER_HOUR
  if (unit === 'half_day') return rules.halfDayMinutes
  if (unit === 'day') return MINUTES_PER_DAY
  if (unit === 'week') return 7 * MINUTES_PER_DAY
  return undefined
}

/**
 * Quantité facturée pour une durée (ADR 023) :
 *
 *   quantité = max(1, ⌈(durée − tolérance) / durée de l'unité⌉)
 *
 * Toute unité entamée au-delà de la tolérance est due : avec la tolérance par
 * défaut de 0, une réunion d'une heure dix coûte deux heures (ADR 006) ; avec
 * une tolérance de 10 minutes, une heure. L'unité vaut 60 minutes (heure),
 * `half_day_minutes` (demi-journée), 24 heures (journée), 7 × 24 heures
 * (semaine). Une semaine entamée est due (R08).
 *
 * La durée est celle de l'heure murale du centre (`devis.ts`) : une
 * réservation de trois jours qui traverse le changement d'heure reste de trois
 * jours.
 *
 * `month` et `unit` sont des forfaits : la prestation est due une fois, quelle
 * que soit sa durée. Le devis d'une réservation ne les retient pas (un tarif au
 * mois se pose sur un contrat, pas sur une réservation).
 */
export function billableQuantity(
  unit: RateUnit,
  durationMinutes: number,
  rules: QuantityRules,
): number {
  if (!(durationMinutes > 0)) return 0
  const size = unitMinutes(unit, rules)
  if (size === undefined) return 1
  return Math.max(1, Math.ceil((durationMinutes - rules.startedUnitToleranceMinutes) / size))
}

/** « 1 250,00 € » — affichage, jamais un calcul. */
export function formatCents(amountCents: number, currency = 'EUR', locale = 'fr-FR'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amountCents / 100)
}

/** « 20 % », « 5,5 % » — un taux en points de base, pour l'affichage. */
export function formatBasisPoints(basisPoints: number, locale = 'fr-FR'): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(basisPoints / 100)} %`
}

/**
 * Lit un montant saisi en euros et le rend en centimes.
 *
 * Accepte « 1 250,50 », « 1250.50 », « 1250 ». Renvoie `undefined` sur une
 * saisie illisible plutôt qu'un `NaN` qui finirait en base.
 */
export function parseAmountToCents(input: string): number | undefined {
  const cleaned = input.replace(/\s| /g, '').replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined
  // Passer par la chaîne évite l'arrondi binaire de 19.99 * 100.
  const [whole, fraction = ''] = cleaned.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

/**
 * Lit un pourcentage saisi — « 20 », « 5,5 », « 2.1 » — et le rend en points
 * de base (2000, 550, 210). Même principe que `parseAmountToCents` : la
 * chaîne est lue chiffre à chiffre, sans multiplication flottante. Deux
 * décimales au plus, 100 % au plus. `undefined` sur une saisie illisible.
 */
export function parsePercentToBasisPoints(input: string): number | undefined {
  const cleaned = input.replace(/\s| |%/g, '').replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined
  const [whole, fraction = ''] = cleaned.split('.')
  const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return basisPoints <= 10_000 ? basisPoints : undefined
}
