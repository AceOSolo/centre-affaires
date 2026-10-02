import type { RateUnit, ServiceNature } from '../facturation/schema.ts'
import { parseAmountToCents, pickRateItem, type RateCandidate } from '../facturation/tarifs.ts'
import { resourceTypeLabels } from '../ressources/labels.ts'
import type { ResourceType } from '../ressources/schema.ts'
import { centsToInput, formatBpAsPercent, parsePercentToBp, type LineDraft } from './lignes.ts'
import type { BillingPeriod, ContractType } from './schema.ts'

/**
 * Un contrat tiré d'une offre groupée (R09, R12, ADR 024).
 *
 * Une offre est un modèle : le contrat en **copie** les lignes, qui ne la
 * suivent plus ensuite. Module pur : la proposition est calculée ici, ajustée
 * à l'écran, puis écrite par `createContractFromOffer` (`offres-queries.ts`).
 *
 * | Ligne d'offre | Devient |
 * |---|---|
 * | Ressource ou type de ressource | Ligne de contrat, facturée en loyer |
 * | Service `package` | Ligne de contrat visant le service, facturée en forfait |
 * | Service `act`, quantité N | Souscription rattachée au contrat : N actes inclus par période, au-delà au prix de la ligne |
 */

export type OfferResource = { id: string; code: string; name: string; resourceType: ResourceType }

export type OfferService = {
  id: string
  name: string
  nature: ServiceNature
  unit: RateUnit
  unitPriceCents: number
  vatRateBp: number
  currency: string
  isActive: boolean
  deletedAt: Date | null
}

export type OfferItemForContract = {
  id: string
  position: number
  quantity: number
  unit: RateUnit
  /** Prix forfaitaire HT par unité ; nul : prix du catalogue. */
  priceCents: number | null
  discountBp: number | null
  discountAmountCents: number | null
  /** Taux imposé ; nul : celui du service, ou celui du centre. */
  vatRateBp: number | null
  resourceType: ResourceType | null
  resource: OfferResource | null
  service: OfferService | null
}

export type OfferForContract = {
  id: string
  name: string
  billingPeriod: BillingPeriod
  commitmentMonths: number | null
  currency: string
  items: readonly OfferItemForContract[]
}

/** Un acte inclus de l'offre, souscrit avec le contrat. */
export type ProposedSubscription = {
  offerItemId: string | null
  serviceId: string
  serviceName: string
  /** Actes inclus par période de facturation. */
  includedQuantity: number
  /** Prix HT d'un acte au-delà des inclus. */
  unitPriceCents: number
  discountBp: number | null
  discountAmountCents: number | null
  vatRateBp: number
}

export type ContractProposal = {
  billingPeriod: BillingPeriod
  commitmentMonths: number | null
  contractType: ContractType
  /** Première ressource précise des lignes : celle que le contrat occupera. */
  resourceId: string | null
  lines: LineDraft[]
  subscriptions: ProposedSubscription[]
  /** Ce que l'équipe doit compléter ou vérifier avant de créer le contrat. */
  warnings: string[]
}

/** Type de contrat suggéré par les ressources de l'offre ; l'équipe le corrige au besoin. */
function suggestedContractType(types: readonly ResourceType[]): ContractType {
  if (types.includes('boite_aux_lettres')) return 'domiciliation'
  if (types.includes('bureau')) return 'bureau'
  return 'autre'
}

/** Désignation d'une ressource ou d'un type, portée sur la facture. */
export function resourceDescription(
  resource: Pick<OfferResource, 'code' | 'name' | 'resourceType'> | null,
  resourceType: ResourceType | null,
): string {
  if (resource) return `${resourceTypeLabels[resource.resourceType]} ${resource.name} (${resource.code})`
  return resourceType ? resourceTypeLabels[resourceType] : 'Prestation'
}

/**
 * Proposition de contrat tirée d'une offre :
 *
 * - le prix d'une ligne est celui de l'offre s'il est imposé, sinon celui du
 *   catalogue — grille (`rates`, la ligne nominative avant celle du type) pour
 *   une ressource, prix du service pour un service ; la remise de la ligne
 *   d'offre est reprise telle quelle ;
 * - la quantité d'une ligne d'offre est due à chaque période de facturation,
 *   telle que l'écran des offres la saisit et la chiffre (`priceOffer`,
 *   ADR 024) : un bureau dans une offre trimestrielle s'y écrit trois mois, et
 *   le contrat la reprend telle quelle — aucun multiplicateur caché ;
 * - un acte (service `act`) devient une souscription : la quantité de l'offre
 *   est le nombre d'actes inclus par période ; au-delà, le prix de l'offre ou
 *   du catalogue, avec la remise de la ligne ;
 * - la TVA est celle de la ligne d'offre, sinon du service, sinon du centre.
 *
 * Un prix introuvable n'est pas inventé (ADR 009) : la ligne est proposée à
 * 0 € et un avertissement le dit.
 */
export function proposeContractFromOffer(
  offer: OfferForContract,
  context: { rates: readonly RateCandidate[]; defaultVatRateBp: number },
): ContractProposal {
  const lines: LineDraft[] = []
  const subscriptions: ProposedSubscription[] = []
  const warnings: string[] = []
  const types: ResourceType[] = []
  let resourceId: string | null = null

  const items = [...offer.items].sort((a, b) => a.position - b.position)
  for (const item of items) {
    // Quantité et remise de l'offre, dues par période de facturation : le
    // contrat facture ce que l'écran des offres annonce (`priceOffer`).
    const quantity = item.quantity
    const discount = {
      discountBp: item.discountBp,
      discountAmountCents: item.discountAmountCents,
    }

    if (item.service) {
      const service = item.service
      if (service.deletedAt) warnings.push(`Le service « ${service.name} » est archivé : vérifiez la ligne.`)
      if (service.currency !== offer.currency) {
        warnings.push(`Le service « ${service.name} » est tarifé en ${service.currency}, l’offre en ${offer.currency}.`)
      }
      const vatRateBp = item.vatRateBp ?? service.vatRateBp
      const unitPriceCents = item.priceCents ?? service.unitPriceCents
      if (service.nature === 'act') {
        // Les inclus se comptent par période de facture (le lot est mensuel,
        // ADR 026) : la quantité de l'offre n'est pas multipliée.
        subscriptions.push({
          offerItemId: item.id,
          serviceId: service.id,
          serviceName: service.name,
          includedQuantity: item.quantity,
          unitPriceCents,
          discountBp: item.discountBp,
          discountAmountCents: item.discountAmountCents,
          vatRateBp,
        })
        continue
      }
      lines.push({
        offerItemId: item.id,
        target: { kind: 'service', serviceId: service.id },
        description: service.name,
        quantity,
        unit: item.unit,
        unitPriceCents,
        ...discount,
        vatRateBp,
        isRecurring: true,
      })
      continue
    }

    const type = item.resource?.resourceType ?? item.resourceType
    if (!type) continue
    types.push(type)
    if (item.resource && !resourceId) resourceId = item.resource.id

    const rate =
      item.priceCents === null
        ? pickRateItem(context.rates, {
            resourceId: item.resource?.id ?? null,
            resourceType: type,
            unit: item.unit,
          })
        : undefined
    const description = resourceDescription(item.resource, type)
    if (item.priceCents === null && !rate) {
      warnings.push(`Aucun prix de grille pour « ${description} » dans cette unité : saisissez-le.`)
    }
    lines.push({
      offerItemId: item.id,
      target: item.resource
        ? { kind: 'resource', resourceId: item.resource.id }
        : { kind: 'type', resourceType: type },
      description,
      quantity,
      unit: item.unit,
      unitPriceCents: item.priceCents ?? rate?.amountCents ?? 0,
      ...discount,
      vatRateBp: item.vatRateBp ?? context.defaultVatRateBp,
      isRecurring: true,
    })
  }

  return {
    billingPeriod: offer.billingPeriod,
    commitmentMonths: offer.commitmentMonths,
    contractType: suggestedContractType(types),
    resourceId,
    lines,
    subscriptions,
    warnings,
  }
}

/** Champs d'un acte inclus au formulaire de création depuis une offre. */
export const actFields = [
  'serviceId',
  'serviceName',
  'offerItemId',
  'includedQuantity',
  'unitPrice',
  'discountKind',
  'discount',
  'vatRate',
] as const
export type ActField = (typeof actFields)[number]
export type ActFormValues = Record<ActField, string> & { key: string }

export const actFieldLabels: Record<ActField, string> = {
  serviceId: 'Service',
  serviceName: 'Service',
  offerItemId: 'Ligne d’offre',
  includedQuantity: 'Actes inclus par mois',
  unitPrice: 'Prix HT d’un acte au-delà',
  discountKind: 'Remise',
  discount: 'Remise',
  vatRate: 'TVA',
}

/** Nom (et identifiant) d'un champ d'acte : `acte-2-includedQuantity`. */
export function actFieldName(key: string, field: ActField): string {
  return `acte-${key}-${field}`
}

export function actToFormValues(key: string, act: ProposedSubscription): ActFormValues {
  return {
    key,
    serviceId: act.serviceId,
    serviceName: act.serviceName,
    offerItemId: act.offerItemId ?? '',
    includedQuantity: String(act.includedQuantity),
    unitPrice: centsToInput(act.unitPriceCents),
    discountKind: act.discountBp !== null ? 'percent' : act.discountAmountCents !== null ? 'amount' : '',
    discount:
      act.discountBp !== null
        ? formatBpAsPercent(act.discountBp)
        : act.discountAmountCents !== null
          ? centsToInput(act.discountAmountCents)
          : '',
    vatRate: formatBpAsPercent(act.vatRateBp),
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Lit les actes inclus retenus à l'écran. Chaque erreur est rattachée à son
 * champ par son nom, qui est aussi son identifiant.
 */
export function readActsForm(
  keys: readonly string[],
  read: (name: string) => string,
):
  | { ok: true; subscriptions: ProposedSubscription[] }
  | { ok: false; fieldErrors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const subscriptions: ProposedSubscription[] = []
  for (const key of keys) {
    const value = (field: ActField) => (read(actFieldName(key, field)) ?? '').trim()
    const error = (field: ActField, message: string) => {
      errors[actFieldName(key, field)] = message
    }
    const serviceId = value('serviceId')
    if (!UUID.test(serviceId)) error('serviceId', 'Service inconnu.')
    const offerItemId = value('offerItemId')
    const included = value('includedQuantity')
    if (!/^\d+$/.test(included) || Number(included) > 100_000) {
      error('includedQuantity', 'Un nombre entier d’actes, 0 ou plus.')
    }
    const unitPriceCents = parseAmountToCents(value('unitPrice'))
    if (unitPriceCents === undefined) error('unitPrice', 'Montant illisible. Exemple : 1,50')
    let discountBp: number | null = null
    let discountAmountCents: number | null = null
    if (value('discountKind') === 'percent') {
      const bp = parsePercentToBp(value('discount'))
      if (bp === undefined) error('discount', 'Un pourcentage de 0 à 100.')
      else discountBp = bp
    } else if (value('discountKind') === 'amount') {
      const cents = parseAmountToCents(value('discount'))
      if (cents === undefined) error('discount', 'Montant illisible.')
      else if (unitPriceCents !== undefined && cents > unitPriceCents) {
        error('discount', 'La remise dépasse le prix de l’acte.')
      } else discountAmountCents = cents
    }
    const vatRateBp = parsePercentToBp(value('vatRate'))
    if (vatRateBp === undefined) error('vatRate', 'Un taux de 0 à 100. Exemple : 20')
    if (unitPriceCents !== undefined && vatRateBp !== undefined && UUID.test(serviceId)) {
      subscriptions.push({
        offerItemId: UUID.test(offerItemId) ? offerItemId : null,
        serviceId,
        serviceName: value('serviceName'),
        includedQuantity: Number(included),
        unitPriceCents,
        discountBp,
        discountAmountCents,
        vatRateBp,
      })
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors }
  return { ok: true, subscriptions }
}
