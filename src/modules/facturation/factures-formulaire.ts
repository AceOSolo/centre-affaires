import type { PaymentMethod } from '../../db/tenants.ts'
import { paymentMethodChoices } from './factures-labels.ts'
import type { DraftInvoiceInput, LineEditInput, ManualLineInput } from './factures-queries.ts'
import { parseAmountToCents } from './tarifs.ts'

/**
 * Lecture et contrôle des formulaires de facture (R13) : conditions d'un
 * brouillon, ligne ajoutée, ligne modifiée, motif d'un avoir.
 *
 * Hors des actions serveur pour s'éprouver sans serveur. Chaque erreur est
 * rattachée à son champ, dont le nom est aussi l'`id` : le résumé d'erreurs y
 * mène par un lien (`ErrorSummary`).
 */

export type FieldErrors = Record<string, string>
export type FormRead<T> =
  | { ok: true; input: T; values: Record<string, string> }
  | { ok: false; fieldErrors: FieldErrors; values: Record<string, string> }

type Get = (name: string) => string

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const INTEGER = /^\d+$/

/** Une date qui existe : « 2026-02-30 » est refusée ici, pas en base. */
export function isCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value)
  if (!match) return false
  const [, year, month, day] = match.map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function isIsoMonthInput(value: string): boolean {
  return ISO_MONTH.test(value)
}

/** « 900,00 » : un montant en centimes au format de saisie, inverse de `parseAmountToCents`. */
export function centsToAmountInput(amountCents: number): string {
  const absolute = Math.abs(amountCents)
  return `${Math.trunc(absolute / 100)},${String(absolute % 100).padStart(2, '0')}`
}

/** Taux de TVA proposés à la saisie, en points de base : 20 %, 10 %, 5,5 %, 2,1 %, exonéré. */
export const vatRateChoices = [2000, 1000, 550, 210, 0] as const

/** Quantité d'une ligne : un entier d'au moins 1, sous le plafond d'un `integer`. */
const MAX_QUANTITY = 100_000
/** Prix unitaire : sous le plafond d'un `integer` en centimes. */
const MAX_UNIT_PRICE_CENTS = 100_000_000

function readQuantity(raw: string, errors: FieldErrors): number {
  if (!INTEGER.test(raw) || Number(raw) < 1 || Number(raw) > MAX_QUANTITY) {
    errors.quantity = `Saisissez un nombre entier entre 1 et ${MAX_QUANTITY.toLocaleString('fr-FR')}.`
    return 0
  }
  return Number(raw)
}

function readPrice(raw: string, errors: FieldErrors): number {
  const cents = parseAmountToCents(raw)
  if (cents === undefined || cents > MAX_UNIT_PRICE_CENTS) {
    errors.unitPrice = 'Saisissez un montant en euros, par exemple 120,50.'
    return 0
  }
  return cents
}

function readDescription(raw: string, errors: FieldErrors): string {
  if (!raw) errors.description = 'La désignation est obligatoire : elle figure sur la facture.'
  else if (raw.length > 500) errors.description = '500 caractères au plus.'
  return raw
}

/**
 * Période facultative d'une ligne : les deux bornes, ou aucune. Ses champs
 * s'appellent `linePeriodStart` et `linePeriodEnd` : ils partagent la page
 * avec ceux de la période de la facture, et un `id` ne se répète pas.
 */
function readOptionalPeriod(get: Get, errors: FieldErrors): { start: string | null; end: string | null } {
  const start = get('linePeriodStart')
  const end = get('linePeriodEnd')
  if (!start && !end) return { start: null, end: null }
  if (!start || !isCalendarDate(start)) errors.linePeriodStart = 'Saisissez le premier jour, ou aucune date.'
  if (!end || !isCalendarDate(end)) errors.linePeriodEnd = 'Saisissez le dernier jour, ou aucune date.'
  if (!errors.linePeriodStart && !errors.linePeriodEnd && end < start) {
    errors.linePeriodEnd = 'Le dernier jour suit le premier.'
  }
  return { start, end }
}

export const draftInvoiceFieldLabels: Record<string, string> = {
  periodStart: 'Début de la période',
  periodEnd: 'Fin de la période',
  paymentTermsDays: 'Délai de paiement',
  expectedPaymentMethod: 'Mode de paiement',
  buyerReference: 'Référence de l’acheteur',
  notes: 'Mentions',
}

/** Conditions d'un brouillon. */
export function readDraftInvoiceForm(get: Get): FormRead<DraftInvoiceInput> {
  const values = Object.fromEntries(Object.keys(draftInvoiceFieldLabels).map((name) => [name, get(name)]))
  const errors: FieldErrors = {}

  if (!isCalendarDate(values.periodStart)) errors.periodStart = 'Saisissez le premier jour de la période.'
  if (!isCalendarDate(values.periodEnd)) errors.periodEnd = 'Saisissez le dernier jour de la période.'
  if (!errors.periodStart && !errors.periodEnd && values.periodEnd < values.periodStart) {
    errors.periodEnd = 'Le dernier jour suit le premier.'
  }

  let paymentTermsDays: number | null = null
  if (values.paymentTermsDays) {
    if (!INTEGER.test(values.paymentTermsDays) || Number(values.paymentTermsDays) > 60) {
      errors.paymentTermsDays = 'Entre 0 et 60 jours (art. L. 441-10 du Code de commerce), ou vide pour le délai du centre.'
    } else {
      paymentTermsDays = Number(values.paymentTermsDays)
    }
  }

  if (!(paymentMethodChoices as readonly string[]).includes(values.expectedPaymentMethod)) {
    errors.expectedPaymentMethod = 'Choisissez un mode de paiement.'
  }
  if (values.buyerReference.length > 200) errors.buyerReference = '200 caractères au plus.'
  if (values.notes.length > 2000) errors.notes = '2 000 caractères au plus.'

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors, values }
  return {
    ok: true,
    values,
    input: {
      periodStart: values.periodStart,
      periodEnd: values.periodEnd,
      paymentTermsDays,
      expectedPaymentMethod: values.expectedPaymentMethod as PaymentMethod,
      buyerReference: values.buyerReference || null,
      notes: values.notes || null,
    },
  }
}

export const manualLineFieldLabels: Record<string, string> = {
  kind: 'Nature',
  description: 'Désignation',
  quantity: 'Quantité',
  unitPrice: 'Prix unitaire HT',
  vatRate: 'TVA',
  vatExemptionReason: 'Motif d’exonération',
  linePeriodStart: 'Du',
  linePeriodEnd: 'Au',
}

/** Ligne libre ou remise ajoutée à un brouillon. */
export function readManualLineForm(get: Get): FormRead<ManualLineInput> {
  const values = Object.fromEntries(Object.keys(manualLineFieldLabels).map((name) => [name, get(name)]))
  const errors: FieldErrors = {}

  if (values.kind !== 'other' && values.kind !== 'discount') errors.kind = 'Choisissez la nature de la ligne.'
  const description = readDescription(values.description, errors)
  const quantity = readQuantity(values.quantity, errors)
  const unitPriceCents = readPrice(values.unitPrice, errors)

  const vatRateBp = Number(values.vatRate)
  if (values.vatRate === '' || !(vatRateChoices as readonly number[]).includes(vatRateBp)) {
    errors.vatRate = 'Choisissez un taux de TVA.'
  }
  if (vatRateBp === 0 && !values.vatExemptionReason) {
    errors.vatExemptionReason = 'Une ligne sans TVA porte son motif d’exonération (mention obligatoire).'
  } else if (values.vatExemptionReason.length > 300) {
    errors.vatExemptionReason = '300 caractères au plus.'
  }
  const period = readOptionalPeriod(get, errors)

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors, values }
  return {
    ok: true,
    values,
    input: {
      kind: values.kind as 'other' | 'discount',
      description,
      quantity,
      unitPriceCents,
      vatRateBp,
      vatCategory: vatRateBp > 0 ? 'S' : 'E',
      vatExemptionReason: vatRateBp > 0 ? null : values.vatExemptionReason,
      periodStart: period.start,
      periodEnd: period.end,
    },
  }
}

export const lineEditFieldLabels: Record<string, string> = {
  description: 'Désignation',
  quantity: 'Quantité',
  unitPrice: 'Prix unitaire HT',
  vatExemptionReason: 'Motif d’exonération',
}

/**
 * Ligne modifiée : désignation et quantité toujours, prix et motif
 * d'exonération quand la ligne les laisse modifier.
 */
export function readLineEditForm(
  get: Get,
  options: { priceEditable: boolean; exemptionEditable: boolean },
): FormRead<LineEditInput> {
  const values = Object.fromEntries(Object.keys(lineEditFieldLabels).map((name) => [name, get(name)]))
  const errors: FieldErrors = {}
  const description = readDescription(values.description, errors)
  const quantity = readQuantity(values.quantity, errors)
  const unitPriceCents = options.priceEditable ? readPrice(values.unitPrice, errors) : undefined
  if (options.exemptionEditable && values.vatExemptionReason.length > 300) {
    errors.vatExemptionReason = '300 caractères au plus.'
  }
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors, values }
  return {
    ok: true,
    values,
    input: {
      description,
      quantity,
      unitPriceCents,
      vatExemptionReason: options.exemptionEditable ? values.vatExemptionReason || null : undefined,
    },
  }
}

/** Motif d'un avoir : obligatoire, il figure sur l'avoir. */
export function readCreditReason(raw: string): { ok: true; reason: string } | { ok: false; error: string } {
  const reason = raw.trim()
  if (!reason) return { ok: false, error: 'Le motif est obligatoire : il figure sur l’avoir.' }
  if (reason.length > 500) return { ok: false, error: 'Le motif tient en 500 caractères au plus.' }
  return { ok: true, reason }
}
