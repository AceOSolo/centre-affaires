import { dayRangeUtc, isCalendarDate } from '../../lib/dates.ts'
import { isUuid } from '../../lib/uuid.ts'
import { parseProduct, typesOf, type Product } from '../ressources/produits.ts'
import type { ResourceType } from '../ressources/schema.ts'
import type { InspectionKind } from './schema.ts'

/**
 * Filtres de l'historique des états des lieux (`/etats-des-lieux`, ADR 063),
 * lus dans l'adresse : client, ressource, période, étape (entrée ou sortie),
 * état et produit, plus la page. Fonctions pures, éprouvées par `node --test`.
 *
 * Une valeur inconnue ou mal formée est ignorée — un lien ancien ou bricolé
 * montre la liste plutôt qu'une erreur —, sauf une période à l'envers, dite
 * à côté des dates.
 */

/** État tel que l'écran le filtre : `closed` réunit « à valider » et « validé ». */
export type HistoryState = 'draft' | 'closed' | 'to_sign' | 'signed'

export const historyStates: { value: HistoryState; label: string }[] = [
  { value: 'draft', label: 'En saisie (brouillon)' },
  { value: 'closed', label: 'Clos (à valider ou validés)' },
  { value: 'to_sign', label: 'Clos, à valider par le client' },
  { value: 'signed', label: 'Validés (signés) par le client' },
]

/** Étape d'un état des lieux, dans l'adresse : `entree` ou `sortie`. */
export const historyKinds: { value: 'entree' | 'sortie'; kind: InspectionKind; label: string }[] = [
  { value: 'entree', kind: 'entry', label: 'Entrées' },
  { value: 'sortie', kind: 'exit', label: 'Sorties' },
]

/** Lignes par page. */
export const HISTORY_PAGE_SIZE = 50

export type HistoryParams = {
  client?: string | string[]
  ressource?: string | string[]
  du?: string | string[]
  au?: string | string[]
  nature?: string | string[]
  /** L'état : `etape` reste le nom d'origine, repris par les tuiles d'« Aujourd'hui ». */
  etape?: string | string[]
  produit?: string | string[]
  page?: string | string[]
}

/** Ce que la requête reçoit : mêmes noms que `InspectionFilter` (queries.ts). */
export type HistoryQuery = {
  clientId?: string
  resourceId?: string
  kind?: InspectionKind
  stage?: HistoryState
  resourceTypes?: ResourceType[]
  /** `performed_at` dans `[from, until)`, bornes des journées du centre. */
  from?: Date
  until?: Date
}

export type HistoryFilters = {
  query: HistoryQuery
  /** Valeurs retenues, pour remplir le formulaire et refaire les liens. */
  values: {
    client?: string
    ressource?: string
    du?: string
    au?: string
    nature?: 'entree' | 'sortie'
    etape?: HistoryState
    produit?: Product['key']
  }
  product: Product | undefined
  page: number
  /** Période à l'envers : dite près des dates, la période n'est pas appliquée. */
  periodError?: string
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim()

export function parseHistoryFilters(params: HistoryParams, timeZone: string): HistoryFilters {
  const query: HistoryQuery = {}
  const values: HistoryFilters['values'] = {}

  const client = first(params.client)
  if (client && isUuid(client)) query.clientId = values.client = client
  const ressource = first(params.ressource)
  if (ressource && isUuid(ressource)) query.resourceId = values.ressource = ressource

  const nature = historyKinds.find((option) => option.value === first(params.nature))
  if (nature) {
    query.kind = nature.kind
    values.nature = nature.value
  }
  const state = historyStates.find((option) => option.value === first(params.etape))
  if (state) query.stage = values.etape = state.value

  const product = parseProduct(params.produit)
  if (product) {
    query.resourceTypes = typesOf(product)
    values.produit = product.key
  }

  let periodError: string | undefined
  const du = first(params.du)
  const au = first(params.au)
  const from = isCalendarDate(du) ? du : undefined
  const until = isCalendarDate(au) ? au : undefined
  if (from) values.du = from
  if (until) values.au = until
  if (from && until && from > until) {
    periodError = 'La date de fin précède la date de début : la période n’est pas appliquée.'
  } else {
    if (from) query.from = dayRangeUtc(from, timeZone).startsAt
    // Le dernier jour est compris : la borne est le début du lendemain.
    if (until) query.until = dayRangeUtc(until, timeZone).endsAt
  }

  const rawPage = Number(first(params.page))
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1

  return { query, values, product, page, ...(periodError && { periodError }) }
}

/** Vrai dès qu'un filtre restreint la liste : l'état vide le dit alors autrement. */
export function isFiltered(filters: HistoryFilters): boolean {
  return Object.keys(filters.values).length > 0
}

/** Adresse de l'historique avec ces valeurs ; la page 1 ne s'écrit pas. */
export function historyHref(values: HistoryFilters['values'], page = 1): string {
  const query = new URLSearchParams()
  const order: (keyof HistoryFilters['values'])[] = ['client', 'ressource', 'du', 'au', 'nature', 'etape', 'produit']
  for (const key of order) {
    const value = values[key]
    if (value) query.set(key, value)
  }
  if (page > 1) query.set('page', String(page))
  const search = query.toString()
  return search ? `/etats-des-lieux?${search}` : '/etats-des-lieux'
}

/** Nombre de pages pour `total` lignes ; une page au moins. */
export function pageCount(total: number, pageSize = HISTORY_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize))
}
