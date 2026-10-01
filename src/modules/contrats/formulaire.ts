import { parseAmountToCents } from '../facturation/tarifs.ts'
import type { ContractInput } from './queries.ts'
import {
  billingPeriods,
  contractTypes,
  type BillingPeriod,
  type ContractType,
} from './schema.ts'

/**
 * Lecture et contrôle du formulaire de contrat, partagés par la création et la
 * modification d'un brouillon : les mêmes règles s'appliquent aux deux (R12).
 *
 * Hors de `actions.ts`, qui ne peut exporter que des actions serveur, pour être
 * éprouvé sans serveur. Chaque erreur est rattachée à son champ : le formulaire
 * l'affiche à côté et la reprend dans le résumé en tête.
 */
export const contractFields = [
  'clientId',
  'reference',
  'contractType',
  'resourceId',
  'startsOn',
  'endsOn',
  'billingPeriod',
  'amount',
  'noticeDays',
  'ratePlanId',
  'notes',
] as const
export type ContractField = (typeof contractFields)[number]

/** Libellés repris par le résumé d'erreurs, identiques à ceux des champs. */
export const contractFieldLabels: Record<ContractField, string> = {
  clientId: 'Client',
  reference: 'Référence',
  contractType: 'Type',
  resourceId: 'Ressource attribuée',
  startsOn: 'Début',
  endsOn: 'Fin',
  billingPeriod: 'Périodicité',
  amount: 'Montant HT',
  noticeDays: 'Préavis',
  ratePlanId: 'Grille tarifaire',
  notes: 'Notes',
}

export type ContractFormValues = Record<ContractField, string>
export type ContractFieldErrors = Partial<Record<ContractField, string>>

export type ContractFormResult =
  | { ok: true; input: ContractInput; values: ContractFormValues }
  | { ok: false; fieldErrors: ContractFieldErrors; values: ContractFormValues }

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Plafond d'une colonne `integer` : au-delà, la base lèverait une erreur brute. */
const MAX_INTEGER = 2_147_483_647
const MAX_REFERENCE_LENGTH = 50

/**
 * « 900,00 » : un montant en centimes rendu au format de saisie, pour remplir
 * le formulaire d'un brouillon. `parseAmountToCents` en est l'inverse exact.
 */
export function centsToAmountInput(amountCents: number): string {
  return `${Math.trunc(amountCents / 100)},${String(amountCents % 100).padStart(2, '0')}`
}

/** Une date de calendrier qui existe : « 2026-02-30 » est refusé ici, pas en base. */
export function isCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value)
  if (!match) return false
  const [, year, month, day] = match.map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

/**
 * - `create` : la référence est facultative. Vide, la base attribue le numéro
 *   suivant de la série du centre (ADR 021) — il faut alors passer `undefined`,
 *   jamais une chaîne vide, que la base refuse.
 * - `update` : la référence est déjà attribuée ; elle reste modifiable mais ne
 *   peut pas être effacée.
 */
export function readContractForm(
  read: (key: ContractField) => string,
  mode: 'create' | 'update',
): ContractFormResult {
  const values = Object.fromEntries(
    contractFields.map((field) => [field, read(field).trim()]),
  ) as ContractFormValues
  const errors: ContractFieldErrors = {}

  if (!UUID.test(values.clientId)) errors.clientId = 'Choisissez le client.'

  if (!values.reference && mode === 'update') {
    errors.reference = 'Indiquez la référence du contrat.'
  } else if (values.reference.length > MAX_REFERENCE_LENGTH) {
    errors.reference = `${MAX_REFERENCE_LENGTH} caractères au plus.`
  }

  if (!contractTypes.includes(values.contractType as ContractType)) {
    errors.contractType = 'Choisissez un type de contrat.'
  }
  if (values.resourceId && !UUID.test(values.resourceId)) {
    errors.resourceId = 'Ressource inconnue.'
  }

  if (!values.startsOn) errors.startsOn = 'Indiquez la date de début.'
  else if (!isCalendarDate(values.startsOn)) errors.startsOn = 'Date illisible.'

  if (values.endsOn && !isCalendarDate(values.endsOn)) {
    errors.endsOn = 'Date illisible.'
  } else if (values.endsOn && !errors.startsOn && values.endsOn < values.startsOn) {
    errors.endsOn = 'La fin ne peut pas précéder le début.'
  }

  if (!billingPeriods.includes(values.billingPeriod as BillingPeriod)) {
    errors.billingPeriod = 'Choisissez une périodicité.'
  }

  // Saisi en euros, stocké en centimes (décision 5).
  const amountCents = parseAmountToCents(values.amount)
  if (!values.amount) errors.amount = 'Indiquez le montant.'
  else if (amountCents === undefined) errors.amount = 'Montant illisible. Exemple : 900,00'
  else if (amountCents > MAX_INTEGER) errors.amount = 'Montant trop élevé.'

  const noticeDays = values.noticeDays === '' ? 90 : Number(values.noticeDays)
  if (!Number.isInteger(noticeDays) || noticeDays < 0 || noticeDays > 3650) {
    errors.noticeDays = 'Un nombre entier de jours, entre 0 et 3650.'
  }

  if (values.ratePlanId && !UUID.test(values.ratePlanId)) {
    errors.ratePlanId = 'Grille inconnue.'
  }

  if (Object.keys(errors).length > 0 || amountCents === undefined) {
    return { ok: false, fieldErrors: errors, values }
  }

  return {
    ok: true,
    values,
    input: {
      clientId: values.clientId,
      reference: values.reference || undefined,
      contractType: values.contractType as ContractType,
      billingPeriod: values.billingPeriod as BillingPeriod,
      startsOn: values.startsOn,
      endsOn: values.endsOn || null,
      amountCents,
      ratePlanId: values.ratePlanId || null,
      resourceId: values.resourceId || null,
      noticeDays,
      notes: values.notes || null,
    },
  }
}
