import { checked, field, parsePercentToBp, type FormLike } from './saisie.ts'
import { rateUnits, serviceNatures, type RateUnit, type ServiceNature } from './schema.ts'
import { parseAmountToCents } from './tarifs.ts'

/**
 * Saisie d'un service du catalogue (R18, ADR 024).
 *
 * Module sans Next ni base : l'action serveur et les tests passent par les
 * mêmes règles. L'unicité du code parmi les services vivants est tenue par la
 * base (`services_tenant_code_key`) ; l'action traduit son refus.
 */

export type ServiceValues = {
  code: string
  name: string
  description: string
  nature: string
  unit: string
  unitPrice: string
  vatRate: string
  isActive: boolean
}

export type ServiceInput = {
  code: string | null
  name: string
  description: string | null
  nature: ServiceNature
  unit: RateUnit
  unitPriceCents: number
  vatRateBp: number
  isActive: boolean
}

export type ServiceField = Exclude<keyof ServiceValues, 'isActive'>
export type ServiceFieldErrors = Partial<Record<ServiceField, string>>

export const serviceFieldLabels: Record<ServiceField, string> = {
  code: 'Code',
  name: 'Nom',
  description: 'Description',
  nature: 'Nature',
  unit: 'Unité de facturation',
  unitPrice: 'Prix unitaire HT',
  vatRate: 'TVA',
}

/** Même forme que la contrainte `services_code_format` : « courrier.ouverture ». */
export const SERVICE_CODE = /^[a-z0-9]+([._-][a-z0-9]+)*$/
const MAX_CODE_LENGTH = 64
const MAX_NAME_LENGTH = 120

/** Ce qu'un service déjà enregistré impose à sa modification. */
export type ExistingService = { code: string | null; nature: ServiceNature }

/**
 * Lecture du formulaire de service, en création comme en modification.
 *
 * - Un acte se facture toujours à l'unité (`services_act_per_unit`) : l'unité
 *   est forcée, pas refusée.
 * - En modification, la nature ne change pas — un forfait ne devient pas un
 *   acte sous les souscriptions et les offres qui l'emploient — et un code
 *   posé ne change plus : la facturation le cherche (`serviceCodes`).
 */
export function readServiceForm(
  form: FormLike,
  existing?: ExistingService,
):
  | { values: ServiceValues; input: ServiceInput; fieldErrors?: undefined }
  | { values: ServiceValues; fieldErrors: ServiceFieldErrors } {
  const values: ServiceValues = {
    code: field(form, 'code').toLowerCase(),
    name: field(form, 'name').replace(/\s+/g, ' '),
    description: field(form, 'description'),
    nature: existing?.nature ?? field(form, 'nature'),
    unit: field(form, 'unit'),
    unitPrice: field(form, 'unitPrice'),
    vatRate: field(form, 'vatRate'),
    isActive: checked(form, 'isActive'),
  }
  const fieldErrors: ServiceFieldErrors = {}

  if (existing?.code) values.code = existing.code
  if (values.code && (values.code.length > MAX_CODE_LENGTH || !SERVICE_CODE.test(values.code))) {
    fieldErrors.code =
      'Minuscules, chiffres, et un point, un tiret ou un souligné entre deux mots : courrier.ouverture.'
  }

  if (!values.name) fieldErrors.name = 'Nommez le service, tel qu’il figurera sur la facture.'
  else if (values.name.length > MAX_NAME_LENGTH) {
    fieldErrors.name = `${MAX_NAME_LENGTH} caractères au plus.`
  }

  const nature = serviceNatures.includes(values.nature as ServiceNature)
    ? (values.nature as ServiceNature)
    : undefined
  if (!nature) fieldErrors.nature = 'Choisissez forfait ou acte.'

  if (nature === 'act') values.unit = 'unit'
  const unit = rateUnits.includes(values.unit as RateUnit) ? (values.unit as RateUnit) : undefined
  if (!unit) fieldErrors.unit = 'Choisissez une unité de facturation.'

  const unitPriceCents = parseAmountToCents(values.unitPrice)
  if (unitPriceCents === undefined) {
    fieldErrors.unitPrice = 'Saisissez un montant en euros, comme 3,00.'
  }

  const vatRateBp = parsePercentToBp(values.vatRate)
  if (vatRateBp === undefined) fieldErrors.vatRate = 'Saisissez un taux entre 0 et 100, comme 20.'

  if (Object.keys(fieldErrors).length > 0) return { values, fieldErrors }
  return {
    values,
    input: {
      code: values.code || null,
      name: values.name,
      description: values.description || null,
      nature: nature as ServiceNature,
      unit: unit as RateUnit,
      unitPriceCents: unitPriceCents as number,
      vatRateBp: vatRateBp as number,
      isActive: values.isActive,
    },
  }
}
