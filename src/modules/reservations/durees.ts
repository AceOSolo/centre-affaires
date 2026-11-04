import { productOf, products, type Product, type ProductKey } from '../ressources/produits.ts'
import type { ResourceType } from '../ressources/schema.ts'

/**
 * Durée maximale d'une demande en ligne, par produit (ADR 061).
 *
 * Elle remplace la limite de huit heures de la page publique, qui était une
 * défense : une demande en attente bloque le créneau (ADR 005), et personne ne
 * doit pouvoir bloquer le camion un mois depuis un formulaire anonyme. Elle
 * vaut pour la page publique et pour l'espace client ; l'équipe, au
 * back-office, n'en a pas.
 *
 * Elle se compte en **jours du centre touchés** par la période, fin exclue
 * (`periodDayCount`) : 1 = le jour même seulement, comme avant ; 3 = du lundi
 * au mercredi. Réglable par centre (`tenants.booking_max_days`, une valeur
 * par clé de produit), avec les valeurs ci-dessous par défaut.
 *
 * Module pur : il s'éprouve seul (`durees.test.ts`).
 */

/** Plus long réglage permis : trois mois, l'horizon de réservation par défaut. */
export const MAX_REQUEST_DAYS_LIMIT = 90

/**
 * Valeurs par défaut, **à valider par l'exploitation** : une semaine ouvrée
 * pour une salle ou un bureau, une semaine pour le camion. `null` : le produit
 * ne se réserve pas sur une période (la domiciliation se souscrit).
 *
 * `Record` exhaustif : un produit ajouté à `produits.ts` (le matériel, lot 6)
 * doit dire ici s'il se réserve sur plusieurs jours, et jusqu'où.
 */
export const defaultMaxRequestDays: Record<ProductKey, number | null> = {
  salles: 5,
  bureaux: 5,
  domiciliation: null,
  vehicules: 7,
}

/** Ce que le centre a réglé (`tenants.booking_max_days`) : clé de produit → jours. */
export type MaxRequestDaysSettings = Partial<Record<string, number>>

export function isValidMaxRequestDays(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_REQUEST_DAYS_LIMIT
}

/** Produits qui se réservent sur une période, dans l'ordre du menu. */
export function periodProducts(): Product[] {
  return products.filter((product) => defaultMaxRequestDays[product.key] !== null)
}

/**
 * Jours d'affilée qu'une demande en ligne peut couvrir pour ce produit : le
 * réglage du centre s'il est lisible, sinon la valeur par défaut. Un produit
 * qui ne se réserve pas sur une période répond 1 : le jour même.
 */
export function maxRequestDays(settings: MaxRequestDaysSettings | null | undefined, product: ProductKey): number {
  const fallback = defaultMaxRequestDays[product]
  if (fallback === null) return 1
  const set = settings?.[product]
  return isValidMaxRequestDays(set) ? set : fallback
}

/** Même règle, à partir du type de la ressource demandée. */
export function maxRequestDaysFor(settings: MaxRequestDaysSettings | null | undefined, type: ResourceType): number {
  return maxRequestDays(settings, productOf(type).key)
}

/** « 1 jour », « 5 jours ». */
export function formatDays(days: number): string {
  return `${days} jour${days > 1 ? 's' : ''}`
}

/** Nom du champ de formulaire d'un produit : `maxDays.salles`. */
export function maxDaysFieldName(product: ProductKey): string {
  return `maxDays.${product}`
}

export type ParsedMaxRequestDays =
  | { ok: true; settings: Record<string, number> }
  | { ok: false; errors: Partial<Record<ProductKey, string>> }

/**
 * Lit le réglage saisi, produit par produit. Un champ vide reprend la valeur
 * par défaut (il n'est pas enregistré) ; une valeur hors de 1 à 90 est
 * refusée, champ par champ.
 */
export function parseMaxRequestDays(source: { get(name: string): unknown }): ParsedMaxRequestDays {
  const settings: Record<string, number> = {}
  const errors: Partial<Record<ProductKey, string>> = {}
  for (const product of periodProducts()) {
    const raw = String(source.get(maxDaysFieldName(product.key)) ?? '').trim()
    if (!raw) continue
    const value = Number(raw)
    if (!isValidMaxRequestDays(value)) {
      errors[product.key] = `Un nombre entier de jours, de 1 à ${MAX_REQUEST_DAYS_LIMIT}.`
    } else {
      settings[product.key] = value
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, settings }
}
