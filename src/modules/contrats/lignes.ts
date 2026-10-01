import { lineNetAmountCents, vatAmountCents } from '../facturation/montants.ts'
import { rateUnits, type RateUnit } from '../facturation/schema.ts'
import { parseAmountToCents } from '../facturation/tarifs.ts'
import { resourceTypes, type ResourceType } from '../ressources/schema.ts'

/**
 * Lignes d'un contrat ou d'un avenant (R12, ADR 025), vues du formulaire.
 *
 * Saisie, contrôle et totaux, sans base ni Next : partagés par l'écran des
 * lignes d'un brouillon, la création depuis une offre et l'avenant, et
 * éprouvés seuls (`lignes.test.ts`). Les montants affichés sont annoncés par
 * `lineNetAmountCents`, jumelle de la règle de la base : la base les recalcule
 * (`contract_lines.net_amount_cents`) et fait autorité.
 *
 * Tout est en entiers : centimes, points de base (2000 = 20 %), quantités.
 */

/** Ce que vise une ligne : au plus une cible (`contract_lines_one_target`). */
export type LineTarget =
  | { kind: 'none' }
  | { kind: 'resource'; resourceId: string }
  | { kind: 'type'; resourceType: ResourceType }
  | { kind: 'service'; serviceId: string }
  | { kind: 'offer'; offerId: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Valeur d'une cible dans un `<select>` : `resource:<id>`, `type:bureau`… */
export function encodeTarget(target: LineTarget): string {
  switch (target.kind) {
    case 'none':
      return ''
    case 'resource':
      return `resource:${target.resourceId}`
    case 'type':
      return `type:${target.resourceType}`
    case 'service':
      return `service:${target.serviceId}`
    case 'offer':
      return `offer:${target.offerId}`
  }
}

/** Inverse de `encodeTarget` ; `undefined` pour une valeur illisible. */
export function decodeTarget(value: string): LineTarget | undefined {
  if (value === '') return { kind: 'none' }
  const [kind, id] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)]
  if (kind === 'resource' && UUID.test(id)) return { kind: 'resource', resourceId: id }
  if (kind === 'service' && UUID.test(id)) return { kind: 'service', serviceId: id }
  if (kind === 'offer' && UUID.test(id)) return { kind: 'offer', offerId: id }
  if (kind === 'type' && (resourceTypes as readonly string[]).includes(id)) {
    return { kind: 'type', resourceType: id as ResourceType }
  }
  return undefined
}

/** Cible d'une ligne en base, colonnes de `contract_lines`. */
export function targetColumns(target: LineTarget): {
  resourceId: string | null
  resourceType: ResourceType | null
  serviceId: string | null
  offerId: string | null
} {
  return {
    resourceId: target.kind === 'resource' ? target.resourceId : null,
    resourceType: target.kind === 'type' ? target.resourceType : null,
    serviceId: target.kind === 'service' ? target.serviceId : null,
    offerId: target.kind === 'offer' ? target.offerId : null,
  }
}

/** Cible d'une ligne lue en base. */
export function targetOf(line: {
  resourceId: string | null
  resourceType: ResourceType | null
  serviceId: string | null
  offerId: string | null
}): LineTarget {
  if (line.resourceId) return { kind: 'resource', resourceId: line.resourceId }
  if (line.resourceType) return { kind: 'type', resourceType: line.resourceType }
  if (line.serviceId) return { kind: 'service', serviceId: line.serviceId }
  if (line.offerId) return { kind: 'offer', offerId: line.offerId }
  return { kind: 'none' }
}

/** Une ligne prête à écrire. */
export type LineDraft = {
  /** Ligne existante du brouillon ; absente pour une ligne nouvelle. */
  id?: string
  /** Ligne d'offre dont celle-ci est tirée (traçabilité, ADR 024). */
  offerItemId: string | null
  target: LineTarget
  description: string
  quantity: number
  unit: RateUnit
  unitPriceCents: number
  discountBp: number | null
  discountAmountCents: number | null
  vatRateBp: number
  isRecurring: boolean
}

/** Champs d'une ligne au formulaire, au format de saisie. */
export const lineFields = [
  'id',
  'offerItemId',
  'target',
  'description',
  'quantity',
  'unit',
  'unitPrice',
  'discountKind',
  'discount',
  'vatRate',
  'recurring',
] as const
export type LineField = (typeof lineFields)[number]
export type LineFormValues = Record<LineField, string> & { key: string }

/** Libellés des champs, repris par le résumé d'erreurs : « Ligne 2 — Prix unitaire HT ». */
export const lineFieldLabels: Record<LineField, string> = {
  id: 'Ligne',
  offerItemId: 'Ligne d’offre',
  target: 'Objet',
  description: 'Désignation',
  quantity: 'Quantité',
  unit: 'Unité',
  unitPrice: 'Prix unitaire HT',
  discountKind: 'Remise',
  discount: 'Remise',
  vatRate: 'TVA',
  recurring: 'Récurrente',
}

/** Nom (et identifiant) d'un champ de ligne : `ligne-3-description`. */
export function lineFieldName(key: string, field: LineField): string {
  return `ligne-${key}-${field}`
}

/** Plafond d'une colonne `integer` : au-delà, la base lèverait une erreur brute. */
const MAX_INTEGER = 2_147_483_647
const MAX_QUANTITY = 100_000
const MAX_DESCRIPTION = 500

/**
 * « 20 », « 5,5 », « 2.1 » : un pourcentage saisi, en points de base (2000,
 * 550, 210). Deux décimales au plus, de 0 à 100. `undefined` sur une saisie
 * illisible, jamais un flottant.
 */
export function parsePercentToBp(input: string): number | undefined {
  const cleaned = input.replace(/\s| |%/g, '').replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined
  const [whole, fraction = ''] = cleaned.split('.')
  const bp = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return bp <= 10_000 ? bp : undefined
}

/** 2000 → « 20 », 550 → « 5,5 », 1250 → « 12,5 » : l'inverse de `parsePercentToBp`. */
export function formatBpAsPercent(bp: number): string {
  const whole = Math.trunc(bp / 100)
  const fraction = String(bp % 100).padStart(2, '0').replace(/0+$/, '')
  return fraction ? `${whole},${fraction}` : String(whole)
}

/** « 900,00 » : des centimes au format de saisie. */
export function centsToInput(cents: number): string {
  return `${Math.trunc(cents / 100)},${String(cents % 100).padStart(2, '0')}`
}

/** Une ligne en base ou proposée, au format du formulaire. */
export function lineToFormValues(key: string, line: LineDraft): LineFormValues {
  return {
    key,
    id: line.id ?? '',
    offerItemId: line.offerItemId ?? '',
    target: encodeTarget(line.target),
    description: line.description,
    quantity: String(line.quantity),
    unit: line.unit,
    unitPrice: centsToInput(line.unitPriceCents),
    discountKind:
      line.discountBp !== null ? 'percent' : line.discountAmountCents !== null ? 'amount' : '',
    discount:
      line.discountBp !== null
        ? formatBpAsPercent(line.discountBp)
        : line.discountAmountCents !== null
          ? centsToInput(line.discountAmountCents)
          : '',
    vatRate: formatBpAsPercent(line.vatRateBp),
    recurring: line.isRecurring ? 'on' : '',
  }
}

export type LinesFormResult =
  | { ok: true; lines: LineDraft[]; values: LineFormValues[] }
  | { ok: false; fieldErrors: Record<string, string>; values: LineFormValues[] }

/**
 * Lit les lignes d'un formulaire. `keys` est la liste des clés de lignes
 * soumises (champ caché `ligne`), dans l'ordre d'affichage ; `read` lit un
 * champ par son nom. Chaque erreur est rattachée au champ par son nom, qui est
 * aussi son identifiant : le résumé d'erreurs y mène.
 */
export function readLinesForm(
  keys: readonly string[],
  read: (name: string) => string,
): LinesFormResult {
  const values: LineFormValues[] = keys.map((key) => {
    const entry = { key } as LineFormValues
    for (const field of lineFields) entry[field] = read(lineFieldName(key, field)).trim()
    return entry
  })
  const errors: Record<string, string> = {}
  const lines: LineDraft[] = []

  for (const value of values) {
    const error = (field: LineField, message: string) => {
      errors[lineFieldName(value.key, field)] = message
    }

    const target = decodeTarget(value.target)
    if (!target) error('target', 'Objet inconnu.')

    if (!value.description) error('description', 'Indiquez la désignation portée sur la facture.')
    else if (value.description.length > MAX_DESCRIPTION) {
      error('description', `${MAX_DESCRIPTION} caractères au plus.`)
    }

    const quantity = Number(value.quantity)
    if (!/^\d+$/.test(value.quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      error('quantity', `Un nombre entier, de 1 à ${MAX_QUANTITY}.`)
    }

    if (!(rateUnits as readonly string[]).includes(value.unit)) error('unit', 'Choisissez une unité.')

    const unitPriceCents = parseAmountToCents(value.unitPrice)
    if (!value.unitPrice) error('unitPrice', 'Indiquez le prix unitaire HT.')
    else if (unitPriceCents === undefined) error('unitPrice', 'Montant illisible. Exemple : 900,00')
    else if (unitPriceCents > MAX_INTEGER) error('unitPrice', 'Montant trop élevé.')

    let discountBp: number | null = null
    let discountAmountCents: number | null = null
    if (value.discountKind === 'percent') {
      const bp = parsePercentToBp(value.discount)
      if (bp === undefined) error('discount', 'Un pourcentage de 0 à 100. Exemple : 10')
      else discountBp = bp
    } else if (value.discountKind === 'amount') {
      const cents = parseAmountToCents(value.discount)
      if (cents === undefined) error('discount', 'Montant illisible. Exemple : 50,00')
      else discountAmountCents = cents
    } else if (value.discountKind !== '') {
      error('discountKind', 'Choisissez une forme de remise.')
    }

    // Une remise ne rend jamais une ligne négative : ce serait un avoir
    // déguisé (`contract_lines_net_positive`, ADR 023).
    if (
      discountAmountCents !== null &&
      unitPriceCents !== undefined &&
      Number.isInteger(quantity) &&
      discountAmountCents > quantity * unitPriceCents
    ) {
      error('discount', 'La remise dépasse le montant de la ligne.')
    }

    const vatRateBp = parsePercentToBp(value.vatRate)
    if (vatRateBp === undefined) error('vatRate', 'Un taux de 0 à 100. Exemple : 20 ou 5,5')

    if (value.id && !UUID.test(value.id)) error('id', 'Ligne inconnue.')
    if (value.offerItemId && !UUID.test(value.offerItemId)) error('offerItemId', 'Ligne d’offre inconnue.')

    if (target && unitPriceCents !== undefined && vatRateBp !== undefined) {
      lines.push({
        id: value.id || undefined,
        offerItemId: value.offerItemId || null,
        target,
        description: value.description,
        quantity,
        unit: value.unit as RateUnit,
        unitPriceCents,
        discountBp,
        discountAmountCents,
        vatRateBp,
        isRecurring: value.recurring === 'on',
      })
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors, values }
  return { ok: true, lines, values }
}

/** Montant net HT d'une ligne pour une période entière, annoncé avant écriture. */
export function lineNet(line: Pick<
  LineDraft,
  'quantity' | 'unitPriceCents' | 'discountBp' | 'discountAmountCents'
>): number {
  return lineNetAmountCents(line)
}

export type VatGroup = { vatRateBp: number; baseCents: number; vatCents: number }

export type LinesTotals = {
  /** Récurrent HT d'une période entière : le montant du contrat ou de l'avenant. */
  recurringNetCents: number
  /** TVA du récurrent, par taux, calculée sur la somme des bases (comme la facture). */
  recurringVat: VatGroup[]
  recurringVatCents: number
  recurringGrossCents: number
  /** Lignes ponctuelles HT (frais de dossier), dues une fois. */
  oneOffNetCents: number
  oneOffVat: VatGroup[]
  oneOffGrossCents: number
}

function vatGroups(lines: readonly LineDraft[]): VatGroup[] {
  const bases = new Map<number, number>()
  for (const line of lines) {
    bases.set(line.vatRateBp, (bases.get(line.vatRateBp) ?? 0) + lineNet(line))
  }
  return [...bases.entries()]
    .sort(([a], [b]) => b - a)
    .map(([vatRateBp, baseCents]) => ({
      vatRateBp,
      baseCents,
      vatCents: vatAmountCents(baseCents, vatRateBp),
    }))
}

/**
 * Totaux d'un jeu de lignes : récurrent par période (le montant que la base
 * tiendra sur le contrat ou l'avenant) et ponctuel, HT, TVA par taux sur la
 * somme des bases — la règle de la facture (EN 16931, BR-CO-17) — et TTC.
 */
export function linesTotals(lines: readonly LineDraft[]): LinesTotals {
  const recurring = lines.filter((line) => line.isRecurring)
  const oneOff = lines.filter((line) => !line.isRecurring)
  const recurringVat = vatGroups(recurring)
  const oneOffVat = vatGroups(oneOff)
  const sum = (groups: VatGroup[], key: 'baseCents' | 'vatCents') =>
    groups.reduce((total, group) => total + group[key], 0)
  return {
    recurringNetCents: sum(recurringVat, 'baseCents'),
    recurringVat,
    recurringVatCents: sum(recurringVat, 'vatCents'),
    recurringGrossCents: sum(recurringVat, 'baseCents') + sum(recurringVat, 'vatCents'),
    oneOffNetCents: sum(oneOffVat, 'baseCents'),
    oneOffVat,
    oneOffGrossCents: sum(oneOffVat, 'baseCents') + sum(oneOffVat, 'vatCents'),
  }
}

/** Les deux lignes disent-elles la même chose ? Pour n'écrire que ce qui change. */
export function sameLine(a: LineDraft, b: LineDraft): boolean {
  return (
    encodeTarget(a.target) === encodeTarget(b.target) &&
    a.description === b.description &&
    a.quantity === b.quantity &&
    a.unit === b.unit &&
    a.unitPriceCents === b.unitPriceCents &&
    a.discountBp === b.discountBp &&
    a.discountAmountCents === b.discountAmountCents &&
    a.vatRateBp === b.vatRateBp &&
    a.isRecurring === b.isRecurring
  )
}
