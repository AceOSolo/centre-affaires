import type { QuotableUnit } from '../facturation/devis.ts'
import type { ResourceType } from './schema.ts'

/**
 * Formules de location d'un bureau (ADR 076) : à l'heure, à la demi-journée,
 * à la journée (coworking), à la semaine ou au mois (longue durée). L'équipe
 * coche, sur la fiche de chaque bureau, celles qu'elle propose ; le
 * formulaire de demande (page publique et espace client) n'offre que
 * celles-là, et le prix suit l'unité de la formule choisie.
 *
 * Le réglage vit dans `resources.attributes.formules` (décision 2 : ce qui est
 * propre à un type de ressource va dans son JSON), sous la forme d'une liste
 * de clés. Un bureau sans formule réglée garde le formulaire libre d'avant :
 * début, fin, et le tarif le moins cher (ADR 023, ADR 061).
 *
 * Module pur : la fiche, les formulaires, les actions et les tests passent par
 * les mêmes règles.
 */

export const rentalFormulas = ['heure', 'demi_journee', 'journee', 'semaine', 'mois'] as const
export type RentalFormula = (typeof rentalFormulas)[number]

/** Nom de la formule, à l'écran. */
export const rentalFormulaLabels: Record<RentalFormula, string> = {
  heure: 'À l’heure',
  demi_journee: 'À la demi-journée',
  journee: 'À la journée',
  semaine: 'À la semaine',
  mois: 'Au mois',
}

/** Ce que la formule veut dire, pour l'équipe qui la coche et le client qui la choisit. */
export const rentalFormulaDescriptions: Record<RentalFormula, string> = {
  heure: 'Quelques heures dans la journée, choisies librement.',
  demi_journee: 'Une demi-journée, à partir de l’heure d’arrivée.',
  journee: 'Une ou plusieurs journées, de l’ouverture à la fermeture du centre (coworking).',
  semaine: 'Une semaine au moins, par semaines entières.',
  mois: 'Un mois au moins, par mois entiers (longue durée).',
}

/**
 * Unité de prix de chaque formule : celle de la grille, que Dolibarr remplit
 * par les références `tarif.bureau.<unité>` (ADR 049) — `heure`,
 * `demi-journee`, `journee`, `semaine`, `mois`.
 */
export const rentalFormulaUnits: Record<RentalFormula, QuotableUnit> = {
  heure: 'hour',
  demi_journee: 'half_day',
  journee: 'day',
  semaine: 'week',
  mois: 'month',
}

/**
 * Types de ressource qui se règlent par formules. Les bureaux seulement, comme
 * la recette le demande (17/11/2026) ; le moteur, lui, ne dépend pas du type.
 */
export function acceptsRentalFormulas(type: ResourceType): boolean {
  return type === 'bureau'
}

export function isRentalFormula(value: unknown): value is RentalFormula {
  return typeof value === 'string' && (rentalFormulas as readonly string[]).includes(value)
}

/**
 * Formules réglées sur une ressource, dans l'ordre de `rentalFormulas`. Vide
 * pour un type qui n'en a pas, ou un bureau jamais réglé : le formulaire libre.
 * Une valeur inconnue en base (reprise, version future) est ignorée.
 */
export function formulasOf(
  resource: { resourceType: ResourceType; attributes?: unknown },
): RentalFormula[] {
  if (!acceptsRentalFormulas(resource.resourceType)) return []
  const raw = (resource.attributes as { formules?: unknown } | null | undefined)?.formules
  if (!Array.isArray(raw)) return []
  return rentalFormulas.filter((formula) => raw.includes(formula))
}

/** Nom du champ d'une case de formule dans le formulaire de la fiche. */
export function formulaFieldName(formula: RentalFormula): string {
  return `formule.${formula}`
}

/** Formules cochées dans le formulaire de la fiche, dans l'ordre de référence. */
export function parseFormulas(source: { get(name: string): unknown }): RentalFormula[] {
  return rentalFormulas.filter((formula) => {
    const value = source.get(formulaFieldName(formula))
    return value !== null && value !== undefined && String(value) !== ''
  })
}

/** « à la journée, au mois » : la liste lisible, en minuscules, pour une fiche ou une carte. */
export function describeFormulas(formulas: readonly RentalFormula[]): string {
  return formulas.map((formula) => rentalFormulaLabels[formula].replace(/^À/, 'à').replace(/^Au/, 'au')).join(', ')
}

/**
 * Formule d'une réservation déjà chiffrée, retrouvée par l'unité de son devis
 * figé : ce que l'écran de modification propose d'abord (ADR 076).
 */
export function formulaOfUnit(unit: string | null | undefined, offered: readonly RentalFormula[]): RentalFormula | undefined {
  return offered.find((formula) => rentalFormulaUnits[formula] === unit)
}
