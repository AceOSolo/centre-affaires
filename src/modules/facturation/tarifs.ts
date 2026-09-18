import type { ResourceType } from '../ressources/schema.ts'
import type { RateUnit } from './schema.ts'

/**
 * Résolution du tarif applicable et calcul du montant.
 *
 * Tous les montants sont des entiers de centimes (décision 5). Aucune division
 * ne subsiste dans un résultat : la quantité est entière, le prix unitaire aussi.
 */

/** Ce qu'il faut d'une ligne de grille pour décider. */
export type RateCandidate = {
  resourceType: ResourceType
  resourceId: string | null
  unit: RateUnit
  amountCents: number
}

export type RateLookup = {
  resourceId: string
  resourceType: ResourceType
  unit: RateUnit
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
 */
export function resolveRate<T extends RateCandidate>(
  items: readonly T[],
  lookup: RateLookup,
): T | undefined {
  const applicable = items.filter(
    (item) => item.unit === lookup.unit && item.resourceType === lookup.resourceType,
  )
  return (
    applicable.find((item) => item.resourceId === lookup.resourceId) ??
    applicable.find((item) => item.resourceId === null)
  )
}

const MS_PER_MINUTE = 60_000

/**
 * Quantité facturée pour une durée.
 *
 * Toute unité entamée est due : une réunion d'une heure et dix minutes coûte
 * deux heures. C'est l'usage des centres d'affaires, et c'est une convention de
 * gestion — pas une évidence (ADR 006).
 *
 * `month` et `unit` sont des forfaits : la prestation est due une fois, quelle
 * que soit sa durée. Un tarif au mois se pose sur un contrat, pas sur une
 * réservation.
 */
export function billableQuantity(unit: RateUnit, startsAt: Date, endsAt: Date): number {
  const minutes = (endsAt.getTime() - startsAt.getTime()) / MS_PER_MINUTE
  if (minutes <= 0) return 0
  if (unit === 'hour') return Math.ceil(minutes / 60)
  if (unit === 'day') return Math.ceil(minutes / (60 * 24))
  return 1
}

/** Montant dû pour une réservation, en centimes. */
export function priceCents(
  rate: Pick<RateCandidate, 'unit' | 'amountCents'>,
  startsAt: Date,
  endsAt: Date,
): number {
  return rate.amountCents * billableQuantity(rate.unit, startsAt, endsAt)
}

/** « 1 250,00 € » — affichage, jamais un calcul. */
export function formatCents(amountCents: number, currency = 'EUR', locale = 'fr-FR'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amountCents / 100)
}

/**
 * Lit un montant saisi en euros et le rend en centimes.
 *
 * Accepte « 1 250,50 », « 1250.50 », « 1250 ». Renvoie `undefined` sur une
 * saisie illisible plutôt qu'un `NaN` qui finirait en base.
 */
export function parseAmountToCents(input: string): number | undefined {
  const cleaned = input.replace(/\s| /g, '').replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined
  // Passer par la chaîne évite l'arrondi binaire de 19.99 * 100.
  const [whole, fraction = ''] = cleaned.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}
