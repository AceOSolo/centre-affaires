import { resourceTypes, type ResourceType } from '../ressources/schema.ts'
import { expectedServices } from './services-attendus.ts'
import { SERVICE_CODE } from './services-regles.ts'
import type { RateUnit, ServiceNature } from './schema.ts'
import { parsePercentToBasisPoints } from './tarifs.ts'

/**
 * Produits reçus de Dolibarr (ADR 046, ADR 049, `docs/integrations/dolibarr.md`).
 *
 * Le module Webhook de Dolibarr poste, à chaque création, modification ou
 * suppression d'un produit, `{ "triggercode": "PRODUCT_MODIFY", "object": {…} }`
 * où `object` est le produit tel que Dolibarr le tient. Ce module lit cet envoi
 * et dit ce qu'il devient sur le site, sans base ni Next : la route et les
 * tests passent par les mêmes règles.
 *
 * La référence du produit (`ref`) décide de sa place, en minuscules :
 *
 * - `tarif.<type>.<unité>` : un prix de la grille par défaut pour tout un type
 *   de ressource — `tarif.salle.demi-journee` ;
 * - `tarif.<type>.<code ressource>.<unité>` : un prix pour une ressource
 *   précise, qui l'emporte sur celui du type — `tarif.salle.sal-mb.heure` ;
 * - tout autre **service** (`type` = 1) : un service du catalogue, dont le
 *   code est la référence — `courrier.ouverture`, `domiciliation-premium`.
 *
 * Un produit physique (`type` = 0) n'a pas de place sur le site : ignoré.
 */

/** Déclencheurs de Dolibarr que le site reçoit. Les autres sont ignorés. */
export const productTriggers = [
  'PRODUCT_CREATE',
  'PRODUCT_MODIFY',
  'PRODUCT_PRICE_MODIFY',
  'PRODUCT_DELETE',
] as const

/** Unités d'une référence de tarif, en français comme on les lit. */
export const tariffUnitWords: Record<string, RateUnit> = {
  heure: 'hour',
  'demi-journee': 'half_day',
  journee: 'day',
  semaine: 'week',
  mois: 'month',
  unite: 'unit',
}

export type ServiceFromDolibarr = {
  kind: 'service'
  code: string
  /** Code avant un renommage de la référence dans Dolibarr, s'il a changé. */
  previousCode: string | null
  removed: boolean
  name: string
  description: string | null
  nature: ServiceNature
  unit: RateUnit
  unitPriceCents: number
  vatRateBp: number
  isActive: boolean
}

export type TariffFromDolibarr = {
  kind: 'tarif'
  ref: string
  resourceType: ResourceType
  /** Code de la ressource visée, nul pour un prix valant pour tout le type. */
  resourceCode: string | null
  unit: RateUnit
  /** Retiré de la grille : produit supprimé ou plus en vente dans Dolibarr. */
  removed: boolean
  amountCents: number
}

export type ProductDecision =
  | ServiceFromDolibarr
  | TariffFromDolibarr
  | { kind: 'ignore'; reason: string }
  | { kind: 'invalid'; message: string }

type DolibarrProduct = {
  ref?: unknown
  label?: unknown
  description?: unknown
  type?: unknown
  price?: unknown
  tva_tx?: unknown
  status?: unknown
  duration_unit?: unknown
  oldcopy?: { ref?: unknown } | null
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''

/**
 * Prix de Dolibarr — « 3.50000000 », « 90 », 12.5 — en centimes, sans calcul
 * flottant. Au-delà du centime, arrondi au plus proche, la moitié vers le haut.
 * `undefined` sur un prix illisible ou négatif.
 */
export function dolibarrPriceToCents(value: unknown): number | undefined {
  const raw = text(value).replace(',', '.')
  const match = /^(\d+)(?:\.(\d*))?$/.exec(raw)
  if (!match) return undefined
  const [, whole, fraction = ''] = match
  const cents = Number(whole) * 100 + Number(fraction.slice(0, 2).padEnd(2, '0'))
  const roundUp = Number(fraction[2] ?? '0') >= 5 ? 1 : 0
  const total = cents + roundUp
  return Number.isSafeInteger(total) ? total : undefined
}

/** Taux de TVA de Dolibarr — « 20.000 », « 5.5 » — en points de base. */
export function dolibarrVatToBasisPoints(value: unknown): number | undefined {
  const raw = text(value).replace(',', '.')
  if (!/^\d+(\.\d*)?$/.test(raw)) return undefined
  const [whole, fraction = ''] = raw.split('.')
  // Les zéros de queue que Dolibarr ajoute (« 20.000 ») ne sont pas des décimales.
  const significant = fraction.replace(/0+$/, '')
  if (significant.length > 2) return undefined
  return parsePercentToBasisPoints(significant ? `${whole}.${significant}` : whole)
}

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '\'',
  nbsp: ' ',
}

/**
 * Description de Dolibarr en texte simple : son éditeur la tient souvent en
 * HTML, et le site affiche du texte. Les balises de fin de ligne deviennent des
 * retours à la ligne, les autres disparaissent.
 */
export function dolibarrTextToPlain(value: unknown): string {
  return text(value)
    .replace(/<br\s*\/?>|<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)))
      return entities[name.toLowerCase()] ?? entity
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Référence en minuscules : `TARIF.SALLE.HEURE` vaut `tarif.salle.heure`. */
const normalizeRef = (value: unknown) => text(value).toLowerCase()

function readTariff(ref: string, product: DolibarrProduct, removed: boolean): ProductDecision {
  const parts = ref.split('.')
  const [, type, ...rest] = parts
  const unitWord = rest.at(-1) ?? ''
  const resourceCode = rest.length === 2 ? rest[0]! : null
  const help =
    'attendu « tarif.<type>.<unité> » ou « tarif.<type>.<code de la ressource>.<unité> », ' +
    `type parmi ${resourceTypes.join(', ')}, unité parmi ${Object.keys(tariffUnitWords).join(', ')}`
  if (rest.length < 1 || rest.length > 2 || resourceCode === '') {
    return { kind: 'invalid', message: `Référence « ${ref} » illisible : ${help}.` }
  }
  if (!resourceTypes.includes(type as ResourceType)) {
    return { kind: 'invalid', message: `Type de ressource « ${type} » inconnu dans « ${ref} » : ${help}.` }
  }
  const unit = tariffUnitWords[unitWord]
  if (!unit) {
    return { kind: 'invalid', message: `Unité « ${unitWord} » inconnue dans « ${ref} » : ${help}.` }
  }
  const amountCents = dolibarrPriceToCents(product.price)
  if (amountCents === undefined && !removed) {
    return { kind: 'invalid', message: `Prix HT illisible pour « ${ref} » : ${text(product.price) || 'absent'}.` }
  }
  return {
    kind: 'tarif',
    ref,
    resourceType: type as ResourceType,
    resourceCode,
    unit,
    removed,
    amountCents: amountCents ?? 0,
  }
}

function readService(ref: string, product: DolibarrProduct, removed: boolean): ProductDecision {
  if (!SERVICE_CODE.test(ref)) {
    return {
      kind: 'invalid',
      message:
        `Référence « ${ref} » inutilisable comme code de service : lettres sans accent, chiffres, ` +
        'et « . », « - » ou « _ » entre eux, sans espace.',
    }
  }
  const previous = normalizeRef(product.oldcopy?.ref)
  const previousCode = previous && previous !== ref && SERVICE_CODE.test(previous) ? previous : null

  // Un service que le code attend garde sa nature et son unité (ADR 024) :
  // l'ouverture d'un pli se compte à l'unité, quoi que dise la fiche.
  const expected = expectedServices.find((service) => service.code === ref)
  const nature: ServiceNature = expected?.nature ?? (text(product.duration_unit) === 'm' ? 'package' : 'act')
  const unit: RateUnit = expected?.unit ?? (nature === 'package' ? 'month' : 'unit')

  const name = text(product.label) || expected?.name || ''
  if (!name && !removed) return { kind: 'invalid', message: `Libellé absent pour « ${ref} ».` }
  const unitPriceCents = dolibarrPriceToCents(product.price)
  if (unitPriceCents === undefined && !removed) {
    return { kind: 'invalid', message: `Prix HT illisible pour « ${ref} » : ${text(product.price) || 'absent'}.` }
  }
  const vatRateBp = dolibarrVatToBasisPoints(product.tva_tx)
  if (vatRateBp === undefined && !removed) {
    return { kind: 'invalid', message: `Taux de TVA illisible pour « ${ref} » : ${text(product.tva_tx) || 'absent'}.` }
  }
  const description = dolibarrTextToPlain(product.description)
  return {
    kind: 'service',
    code: ref,
    previousCode,
    removed,
    name: name || ref,
    description: description || expected?.description || null,
    nature,
    unit,
    unitPriceCents: unitPriceCents ?? 0,
    vatRateBp: vatRateBp ?? 0,
    // `status` est « en vente » dans Dolibarr : un produit retiré de la vente
    // n'est plus proposé, sans disparaître de ce qui l'emploie.
    isActive: text(product.status) !== '0',
  }
}

/** Ce que devient sur le site un envoi du module Webhook de Dolibarr. */
export function readDolibarrProductEvent(body: unknown): ProductDecision {
  const envelope = (body ?? {}) as { triggercode?: unknown; object?: unknown }
  const trigger = text(envelope.triggercode)
  if (!trigger || typeof envelope.object !== 'object' || envelope.object === null) {
    return {
      kind: 'invalid',
      message: 'Envoi illisible : attendu { "triggercode": "PRODUCT_…", "object": { …le produit… } }.',
    }
  }
  if (!(productTriggers as readonly string[]).includes(trigger)) {
    return { kind: 'ignore', reason: `Déclencheur ${trigger} : rien à faire pour le site.` }
  }
  const product = envelope.object as DolibarrProduct
  const ref = normalizeRef(product.ref)
  if (!ref) return { kind: 'invalid', message: 'Produit sans référence (`ref`).' }

  const deleted = trigger === 'PRODUCT_DELETE'
  if (ref.startsWith('tarif.')) {
    // Un tarif hors vente sort de la grille : le site n'affiche plus ce prix.
    return readTariff(ref, product, deleted || text(product.status) === '0')
  }
  if (text(product.type) !== '1') {
    return { kind: 'ignore', reason: `« ${ref} » est un produit physique : le site ne tient que les services.` }
  }
  return readService(ref, product, deleted)
}
