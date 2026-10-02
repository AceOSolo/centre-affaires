import type { ResourceType } from '../ressources/schema.ts'
import {
  bpToPercentInput,
  centsToAmountInput,
  field,
  parseInteger,
  parsePercentToBp,
  type FormLike,
} from './saisie.ts'
import {
  billingPeriods,
  rateUnits,
  type BillingPeriod,
  type RateUnit,
  type ServiceNature,
} from './schema.ts'
import type { OfferPricing, OfferTarget } from './services-labels.ts'
import { parseAmountToCents } from './tarifs.ts'

/**
 * Saisie d'une offre groupée et de ses lignes (R09, ADR 024).
 *
 * Module sans Next ni base : les actions serveur, l'aperçu du formulaire et
 * les tests passent par les mêmes règles. Les contraintes de la base
 * (`offer_items_one_target`, `offer_items_one_pricing`) en sont le filet.
 */

/* ------------------------------------------------------------------------ */
/* En-tête de l'offre                                                       */
/* ------------------------------------------------------------------------ */

export type OfferHeaderValues = {
  name: string
  description: string
  billingPeriod: string
  commitmentMonths: string
  /** Case « présentée dans l'espace client » : `on`, ou vide. */
  clientVisible: string
}

export type OfferHeaderInput = {
  name: string
  description: string | null
  billingPeriod: BillingPeriod
  commitmentMonths: number | null
  /** Présentée dans l'espace client, avec son prix (R23, ADR 036). Absente : inchangée. */
  clientVisible?: boolean
}

export type OfferHeaderField = keyof OfferHeaderValues
export type OfferHeaderErrors = Partial<Record<OfferHeaderField, string>>

export const offerHeaderLabels: Record<OfferHeaderField, string> = {
  name: 'Nom de l’offre',
  description: 'Description',
  billingPeriod: 'Période de facturation',
  commitmentMonths: 'Engagement proposé',
  clientVisible: 'Espace client',
}

const MAX_NAME_LENGTH = 120
/** Bornes de `offers_commitment_valid` : de 1 à 120 mois. */
export const MAX_COMMITMENT_MONTHS = 120

export function readOfferHeaderForm(
  form: FormLike,
):
  | { values: OfferHeaderValues; input: OfferHeaderInput; fieldErrors?: undefined }
  | { values: OfferHeaderValues; fieldErrors: OfferHeaderErrors } {
  const values: OfferHeaderValues = {
    name: field(form, 'name').replace(/\s+/g, ' '),
    description: field(form, 'description'),
    billingPeriod: field(form, 'billingPeriod'),
    commitmentMonths: field(form, 'commitmentMonths'),
    clientVisible: field(form, 'clientVisible') === 'on' ? 'on' : '',
  }
  const fieldErrors: OfferHeaderErrors = {}

  if (!values.name) fieldErrors.name = 'Nommez l’offre, comme « Domiciliation Premium ».'
  else if (values.name.length > MAX_NAME_LENGTH) fieldErrors.name = `${MAX_NAME_LENGTH} caractères au plus.`

  const billingPeriod = billingPeriods.includes(values.billingPeriod as BillingPeriod)
    ? (values.billingPeriod as BillingPeriod)
    : undefined
  if (!billingPeriod) fieldErrors.billingPeriod = 'Choisissez une période de facturation.'

  let commitmentMonths: number | null = null
  if (values.commitmentMonths) {
    const months = parseInteger(values.commitmentMonths, 1)
    if (months === undefined || months > MAX_COMMITMENT_MONTHS) {
      fieldErrors.commitmentMonths = `Saisissez un nombre de mois entre 1 et ${MAX_COMMITMENT_MONTHS}, ou laissez vide.`
    } else commitmentMonths = months
  }

  if (Object.keys(fieldErrors).length > 0) return { values, fieldErrors }
  return {
    values,
    input: {
      name: values.name,
      description: values.description || null,
      billingPeriod: billingPeriod as BillingPeriod,
      commitmentMonths,
      clientVisible: values.clientVisible === 'on',
    },
  }
}

/* ------------------------------------------------------------------------ */
/* Lignes de l'offre                                                        */
/* ------------------------------------------------------------------------ */

export type OfferItemValues = {
  target: OfferTarget
  resourceType: string
  resourceId: string
  serviceId: string
  quantity: string
  unit: string
  pricing: OfferPricing
  price: string
  discountPercent: string
  discountAmount: string
  vatRate: string
  /** Désignation commerciale, montrée au client (ADR 036) ; vide : le nom du catalogue. */
  label: string
}

/** Ce qui s'écrit dans `offer_items`, hors offre et position. */
export type OfferItemInput = {
  resourceType: ResourceType | null
  resourceId: string | null
  serviceId: string | null
  quantity: number
  unit: RateUnit
  priceCents: number | null
  discountBp: number | null
  discountAmountCents: number | null
  vatRateBp: number | null
  /** Désignation commerciale ; nulle ou absente : le nom du catalogue. */
  label?: string | null
}

export type OfferItemField = Exclude<keyof OfferItemValues, 'target'>
export type OfferItemErrors = Partial<Record<OfferItemField, string>>

export const offerItemLabels: Record<OfferItemField, string> = {
  resourceType: 'Type de ressource',
  resourceId: 'Ressource',
  serviceId: 'Service',
  quantity: 'Quantité par période',
  unit: 'Unité',
  pricing: 'Prix',
  price: 'Prix forfaitaire HT',
  discountPercent: 'Remise en pourcentage',
  discountAmount: 'Remise en montant',
  vatRate: 'TVA',
  label: 'Désignation commerciale',
}

/** Ce qu'il faut savoir du catalogue pour valider une ligne. */
export type OfferItemContext = {
  resourceTypes: readonly ResourceType[]
  resources: readonly { id: string; resourceType: ResourceType; archived: boolean }[]
  services: readonly {
    id: string
    nature: ServiceNature
    unit: RateUnit
    isActive: boolean
    archived: boolean
  }[]
}

/** Désignation commerciale d'une ligne : « Bureau fermé de 12 m² ». */
export const MAX_ITEM_LABEL_LENGTH = 120

const targets: readonly OfferTarget[] = ['resource_type', 'resource', 'service']
const pricings: readonly OfferPricing[] = ['catalogue', 'price', 'discount_bp', 'discount_amount']

export function offerItemValues(form: FormLike): OfferItemValues {
  const target = field(form, 'target')
  const pricing = field(form, 'pricing')
  return {
    target: targets.includes(target as OfferTarget) ? (target as OfferTarget) : 'resource_type',
    resourceType: field(form, 'resourceType'),
    resourceId: field(form, 'resourceId'),
    serviceId: field(form, 'serviceId'),
    quantity: field(form, 'quantity'),
    unit: field(form, 'unit'),
    pricing: pricings.includes(pricing as OfferPricing) ? (pricing as OfferPricing) : 'catalogue',
    price: field(form, 'price'),
    discountPercent: field(form, 'discountPercent'),
    discountAmount: field(form, 'discountAmount'),
    vatRate: field(form, 'vatRate'),
    label: field(form, 'label').replace(/\s+/g, ' '),
  }
}

/**
 * Lecture d'une ligne d'offre :
 *
 * - **une cible**, exactement : un type de ressource, une ressource vivante,
 *   ou un service proposé ;
 * - **l'unité** : celle du service pour un service (un acte est à l'unité) ;
 *   au choix pour une ressource — le prix du catalogue est lu dans la grille
 *   pour cette unité ;
 * - **la quantité, par période de facturation** : trois mois de bureau dans
 *   une offre trimestrielle, dix actes inclus par mois ;
 * - **au plus un** de : prix forfaitaire, remise en pourcentage, remise en
 *   montant par période (pas sur un acte). Aucun : prix du catalogue ;
 * - **la TVA**, facultative : vide, celle du service ou du centre.
 */
export function validateOfferItem(
  values: OfferItemValues,
  context: OfferItemContext,
): { input?: OfferItemInput; errors: OfferItemErrors } {
  const errors: OfferItemErrors = {}
  let resourceType: ResourceType | null = null
  let resourceId: string | null = null
  let serviceId: string | null = null
  let unit: RateUnit | undefined
  let nature: ServiceNature | null = null

  if (values.target === 'service') {
    const service = context.services.find((candidate) => candidate.id === values.serviceId)
    if (!service) errors.serviceId = 'Choisissez un service du catalogue.'
    else if (service.archived || !service.isActive) {
      errors.serviceId = 'Ce service n’est plus proposé : choisissez-en un autre.'
    } else {
      serviceId = service.id
      unit = service.unit
      nature = service.nature
    }
  } else if (values.target === 'resource') {
    const resource = context.resources.find((candidate) => candidate.id === values.resourceId)
    if (!resource || resource.archived) errors.resourceId = 'Choisissez une ressource du parc.'
    else resourceId = resource.id
  } else if (context.resourceTypes.includes(values.resourceType as ResourceType)) {
    resourceType = values.resourceType as ResourceType
  } else {
    errors.resourceType = 'Choisissez un type de ressource.'
  }

  if (values.target !== 'service') {
    unit = rateUnits.includes(values.unit as RateUnit) ? (values.unit as RateUnit) : undefined
    if (!unit) errors.unit = 'Choisissez une unité.'
  }

  const quantity = parseInteger(values.quantity, 1)
  if (quantity === undefined) {
    errors.quantity =
      nature === 'act'
        ? 'Saisissez le nombre d’actes inclus par période, 1 ou plus.'
        : 'Saisissez un nombre entier, 1 ou plus.'
  }

  let priceCents: number | null = null
  let discountBp: number | null = null
  let discountAmountCents: number | null = null
  if (values.pricing === 'price') {
    const cents = parseAmountToCents(values.price)
    if (cents === undefined) errors.price = 'Saisissez un montant en euros, comme 25,00.'
    else priceCents = cents
  } else if (values.pricing === 'discount_bp') {
    const bp = parsePercentToBp(values.discountPercent)
    if (bp === undefined || bp === 0) {
      errors.discountPercent = 'Saisissez un pourcentage entre 0,01 et 100, comme 10.'
    } else discountBp = bp
  } else if (values.pricing === 'discount_amount') {
    if (nature === 'act') {
      errors.discountAmount =
        'Une remise en montant vaut par période : pour un acte, saisissez un pourcentage.'
    } else {
      const cents = parseAmountToCents(values.discountAmount)
      if (cents === undefined || cents === 0) {
        errors.discountAmount = 'Saisissez un montant en euros, comme 10,00.'
      } else discountAmountCents = cents
    }
  }

  let vatRateBp: number | null = null
  if (values.vatRate) {
    const bp = parsePercentToBp(values.vatRate)
    if (bp === undefined) errors.vatRate = 'Saisissez un taux entre 0 et 100, ou laissez vide.'
    else vatRateBp = bp
  }

  if (values.label.length > MAX_ITEM_LABEL_LENGTH) {
    errors.label = `${MAX_ITEM_LABEL_LENGTH} caractères au plus.`
  }

  if (Object.keys(errors).length > 0 || !unit || quantity === undefined) return { errors }
  return {
    errors,
    input: {
      resourceType,
      resourceId,
      serviceId,
      quantity,
      unit,
      priceCents,
      discountBp,
      discountAmountCents,
      vatRateBp,
      label: values.label || null,
    },
  }
}

/** Valeurs de formulaire d'une ligne enregistrée, pour la modifier. */
export function offerItemToValues(item: OfferItemInput): OfferItemValues {
  return {
    target: item.serviceId ? 'service' : item.resourceId ? 'resource' : 'resource_type',
    resourceType: item.resourceType ?? '',
    resourceId: item.resourceId ?? '',
    serviceId: item.serviceId ?? '',
    quantity: String(item.quantity),
    unit: item.unit,
    pricing:
      item.priceCents !== null
        ? 'price'
        : item.discountBp !== null
          ? 'discount_bp'
          : item.discountAmountCents !== null
            ? 'discount_amount'
            : 'catalogue',
    price: item.priceCents !== null ? centsToAmountInput(item.priceCents) : '',
    discountPercent: item.discountBp !== null ? bpToPercentInput(item.discountBp) : '',
    discountAmount: item.discountAmountCents !== null ? centsToAmountInput(item.discountAmountCents) : '',
    vatRate: item.vatRateBp !== null ? bpToPercentInput(item.vatRateBp) : '',
    label: item.label ?? '',
  }
}
