import { resourceTypeLabels } from '../ressources/labels.ts'
import type { ResourceType } from '../ressources/schema.ts'
import { invoiceAmounts, lineNetAmountCents } from './montants.ts'
import type { BillingPeriod, RateUnit, ServiceNature } from './schema.ts'
import type { OfferTarget } from './services-labels.ts'
import { resolveRate, type RateCandidate } from './tarifs.ts'

/**
 * Prix d'une offre groupée (R09, ADR 024) : le moteur de devis appliqué aux
 * lignes d'une offre, pour l'annoncer à l'écran avant qu'un contrat n'en soit
 * tiré.
 *
 * Module pur, sans base ni Next : la page de l'offre, la liste des offres et
 * l'aperçu du formulaire de ligne (côté navigateur) appellent la même
 * fonction, et `offres-prix.test.ts` l'éprouve.
 *
 * Règles (ADR 024, « Mise en œuvre ») :
 *
 * - **Le prix d'une offre est celui d'une période de facturation.** La
 *   quantité d'une ligne est due à chaque période : un bureau dans une offre
 *   trimestrielle s'écrit trois mois. Aucun multiplicateur caché.
 * - **Prix unitaire** : le prix forfaitaire de la ligne s'il y en a un, sinon
 *   celui du catalogue — la grille par défaut du centre pour une ressource
 *   (la ligne nominative l'emporte sur celle du type, `resolveRate`), le prix
 *   du service pour un service. Sans prix, la ligne est signalée et sort du
 *   total : on n'invente pas de prix (ADR 009).
 * - **Remise** : en pourcentage ou en montant par période, jamais les deux ;
 *   le net suit `lineNetAmountCents`, la règle d'arrondi unique de la base
 *   (ADR 023). Une remise qui rendrait la ligne négative est signalée.
 * - **Actes** : une ligne d'acte de quantité N porte N actes inclus par
 *   période. Elle ne coûte rien dans le prix de l'offre ; au-delà, chaque
 *   acte est dû au prix de la ligne (remise en pourcentage comprise).
 * - **TVA** : taux de la ligne, sinon celui du service, sinon le taux par
 *   défaut du centre. Calculée comme sur une facture (`invoiceAmounts`) : par
 *   taux, sur la somme des bases, l'écart d'arrondi porté par la ligne de plus
 *   forte valeur. Le devis tombe ainsi au centime de la facture à venir.
 */

/** Un service du catalogue, tel que le devis d'une offre le lit. */
export type OfferCatalogueService = {
  id: string
  name: string
  nature: ServiceNature
  unit: RateUnit
  unitPriceCents: number
  vatRateBp: number
  currency: string
  isActive: boolean
  archived: boolean
}

/** Une ressource du parc, telle que le devis d'une offre la lit. */
export type OfferCatalogueResource = {
  id: string
  code: string
  name: string
  resourceType: ResourceType
  archived: boolean
}

/** Ce que le catalogue du centre dit des prix, au jour du devis. */
export type OfferCatalogue = {
  /** Taux de TVA par défaut du centre (`tenants.default_vat_rate_bp`). */
  defaultVatRateBp: number
  /** Lignes vivantes de la grille par défaut ; vide sans grille. */
  rateItems: readonly RateCandidate[]
  /** Devise de la grille par défaut ; nulle sans grille. */
  rateCurrency: string | null
  services: readonly OfferCatalogueService[]
  resources: readonly OfferCatalogueResource[]
}

/** Une ligne d'offre (`offer_items`), telle qu'elle est en base ou saisie. */
export type OfferLineInput = {
  id: string
  position: number
  resourceType: ResourceType | null
  resourceId: string | null
  serviceId: string | null
  quantity: number
  unit: RateUnit
  priceCents: number | null
  discountBp: number | null
  discountAmountCents: number | null
  vatRateBp: number | null
}

export type OfferInput = {
  billingPeriod: BillingPeriod
  commitmentMonths: number | null
  currency: string
  items: readonly OfferLineInput[]
}

/** Nature de facturation d'une ligne, celle qu'elle aura dans le contrat tiré. */
export type OfferLineKind = 'rent' | 'package' | 'act'

export type PricedOfferLine = {
  id: string
  position: number
  kind: OfferLineKind
  target: OfferTarget
  /** Désignation : « Bureau 3 (BUR-03) », « Standard téléphonique ». */
  label: string
  quantity: number
  unit: RateUnit
  /** Prix unitaire HT appliqué. Nul : aucun prix connu. */
  unitPriceCents: number | null
  /** D'où vient le prix appliqué : la ligne d'offre, ou le catalogue. */
  priceSource: 'offer' | 'catalogue' | null
  /** Prix unitaire HT du catalogue, pour mesurer la remise. Nul : inconnu. */
  catalogueUnitPriceCents: number | null
  discountBp: number | null
  discountAmountCents: number | null
  /** Quantité × prix du catalogue, sans remise. Nul : prix du catalogue inconnu. */
  listAmountCents: number | null
  /** Montant net HT dû par période. Zéro pour des actes inclus. Nul : ligne non chiffrée. */
  netAmountCents: number | null
  vatRateBp: number
  /** TVA de la ligne après répartition de l'arrondi. Nulle : ligne non chiffrée. */
  vatAmountCents: number | null
  /** Ligne d'acte : nombre d'actes inclus par période. */
  includedActs: number | null
  /** Ligne d'acte : prix HT d'un acte au-delà des inclus, remise comprise. */
  extraActNetCents: number | null
  /** Défaut qui empêche de chiffrer la ligne ; elle sort alors du total. */
  problem: string | null
  /** Remarque qui n'empêche pas de chiffrer : service qui n'est plus proposé. */
  notice: string | null
}

export type OfferVatBreakdown = {
  vatRateBp: number
  taxableAmountCents: number
  vatAmountCents: number
}

export type OfferQuote = {
  currency: string
  lines: PricedOfferLine[]
  /** Totaux d'une période de facturation, sur les lignes chiffrées. */
  totalExclTaxCents: number
  totalTaxCents: number
  totalInclTaxCents: number
  vatBreakdown: OfferVatBreakdown[]
  /** Prix catalogue de l'ensemble, actes inclus compris. Nul si une ligne n'en a pas. */
  listAmountCents: number | null
  /** Ce que l'offre retranche au prix catalogue. Nul si le prix catalogue est inconnu. */
  savingsCents: number | null
  /** Mois d'une période de facturation : 1, 3 ou 12. */
  periodMonths: number
  /** Total sur la durée d'engagement, quand elle compte un nombre entier de périodes. */
  commitment: {
    months: number
    periods: number
    totalExclTaxCents: number
    totalInclTaxCents: number
  } | null
  /** Toutes les lignes sont chiffrées, et il y en a au moins une. */
  complete: boolean
  /** Un défaut par ligne non chiffrée, préfixé de sa désignation. */
  problems: string[]
}

export const billingPeriodMonths: Record<BillingPeriod, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
}

function targetOf(line: OfferLineInput): OfferTarget {
  if (line.serviceId) return 'service'
  if (line.resourceId) return 'resource'
  return 'resource_type'
}

type Pricing = {
  kind: OfferLineKind
  label: string
  catalogueUnitPriceCents: number | null
  /** TVA du catalogue de la cible, avant celle du centre. */
  catalogueVatRateBp: number | null
  problem: string | null
  notice: string | null
}

/** Ce que le catalogue dit de la cible d'une ligne : désignation, prix, TVA. */
function catalogueFor(line: OfferLineInput, offerCurrency: string, catalogue: OfferCatalogue): Pricing {
  if (line.serviceId) {
    const service = catalogue.services.find((candidate) => candidate.id === line.serviceId)
    if (!service) {
      return {
        kind: 'package',
        label: 'Service introuvable',
        catalogueUnitPriceCents: null,
        catalogueVatRateBp: null,
        problem: 'service introuvable dans le catalogue.',
        notice: null,
      }
    }
    const kind: OfferLineKind = service.nature === 'act' ? 'act' : 'package'
    const base = { kind, label: service.name, catalogueVatRateBp: service.vatRateBp }
    if (service.archived) {
      return {
        ...base,
        catalogueUnitPriceCents: null,
        problem: 'service archivé : retirez la ligne ou choisissez un autre service.',
        notice: null,
      }
    }
    if (service.unit !== line.unit) {
      return {
        ...base,
        catalogueUnitPriceCents: null,
        problem: 'l’unité de la ligne n’est plus celle du service : retirez la ligne et ajoutez-la de nouveau.',
        notice: null,
      }
    }
    if (service.currency !== offerCurrency) {
      return {
        ...base,
        catalogueUnitPriceCents: null,
        problem: `service facturé en ${service.currency}, offre en ${offerCurrency}.`,
        notice: null,
      }
    }
    return {
      ...base,
      catalogueUnitPriceCents: service.unitPriceCents,
      problem: null,
      notice: service.isActive ? null : 'service qui n’est plus proposé à la souscription.',
    }
  }

  const resource = line.resourceId
    ? catalogue.resources.find((candidate) => candidate.id === line.resourceId)
    : undefined
  if (line.resourceId && !resource) {
    return {
      kind: 'rent',
      label: 'Ressource introuvable',
      catalogueUnitPriceCents: null,
      catalogueVatRateBp: null,
      problem: 'ressource introuvable dans le parc.',
      notice: null,
    }
  }
  const resourceType = resource?.resourceType ?? line.resourceType
  if (!resourceType) {
    return {
      kind: 'rent',
      label: 'Ligne sans cible',
      catalogueUnitPriceCents: null,
      catalogueVatRateBp: null,
      problem: 'la ligne ne vise ni ressource, ni type de ressource, ni service.',
      notice: null,
    }
  }
  const label = resource
    ? `${resource.name} (${resource.code})`
    : `${resourceTypeLabels[resourceType]}, au choix du centre`
  if (resource?.archived) {
    return {
      kind: 'rent',
      label,
      catalogueUnitPriceCents: null,
      catalogueVatRateBp: null,
      problem: 'ressource archivée : retirez la ligne.',
      notice: null,
    }
  }

  // La ligne nominative de la grille l'emporte sur celle du type ; une ligne
  // d'offre par type ne lit que le prix du type.
  const rate = resource
    ? resolveRate(catalogue.rateItems, {
        resourceId: resource.id,
        resourceType,
        unit: line.unit,
      })
    : catalogue.rateItems.find(
        (item) =>
          item.resourceType === resourceType && item.resourceId === null && item.unit === line.unit,
      )
  const currencyMismatch =
    rate !== undefined && catalogue.rateCurrency !== null && catalogue.rateCurrency !== offerCurrency
  return {
    kind: 'rent',
    label,
    catalogueUnitPriceCents: rate && !currencyMismatch ? rate.amountCents : null,
    catalogueVatRateBp: null,
    problem: currencyMismatch
      ? `grille par défaut en ${catalogue.rateCurrency}, offre en ${offerCurrency}.`
      : null,
    notice: null,
  }
}

/**
 * Chiffre une offre : chaque ligne, puis la TVA et les totaux d'une période de
 * facturation, et le total sur la durée d'engagement.
 */
export function priceOffer(offer: OfferInput, catalogue: OfferCatalogue): OfferQuote {
  const ordered = [...offer.items].sort(
    (a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )

  const lines: PricedOfferLine[] = ordered.map((line): PricedOfferLine => {
    const pricing = catalogueFor(line, offer.currency, catalogue)
    const target = targetOf(line)
    const vatRateBp =
      line.vatRateBp ?? pricing.catalogueVatRateBp ?? catalogue.defaultVatRateBp
    const unitPriceCents = line.priceCents ?? pricing.catalogueUnitPriceCents
    const priceSource: PricedOfferLine['priceSource'] =
      line.priceCents !== null ? 'offer' : unitPriceCents !== null ? 'catalogue' : null
    const listAmountCents =
      pricing.catalogueUnitPriceCents === null
        ? null
        : lineNetAmountCents({
            quantity: line.quantity,
            unitPriceCents: pricing.catalogueUnitPriceCents,
          })

    let problem = pricing.problem
    if (!problem && unitPriceCents === null) {
      problem =
        target === 'service'
          ? 'aucun prix : fixez un prix forfaitaire.'
          : 'aucun prix dans la grille par défaut pour cette unité : fixez un prix forfaitaire ou complétez la grille.'
    }

    const base = {
      id: line.id,
      position: line.position,
      kind: pricing.kind,
      target,
      label: pricing.label,
      quantity: line.quantity,
      unit: line.unit,
      unitPriceCents,
      priceSource,
      catalogueUnitPriceCents: pricing.catalogueUnitPriceCents,
      discountBp: line.discountBp,
      discountAmountCents: line.discountAmountCents,
      listAmountCents,
      vatRateBp,
      vatAmountCents: null,
      notice: pricing.notice,
    }

    if (pricing.kind === 'act') {
      if (!problem && line.discountAmountCents !== null) {
        problem = 'une remise en montant ne s’applique pas à un acte : saisissez un pourcentage.'
      }
      return {
        ...base,
        netAmountCents: problem ? null : 0,
        includedActs: line.quantity,
        extraActNetCents:
          problem || unitPriceCents === null
            ? null
            : lineNetAmountCents({
                quantity: 1,
                unitPriceCents,
                discountBp: line.discountBp,
              }),
        problem,
      }
    }

    let netAmountCents: number | null = null
    if (!problem && unitPriceCents !== null) {
      netAmountCents = lineNetAmountCents({
        quantity: line.quantity,
        unitPriceCents,
        discountBp: line.discountBp,
        discountAmountCents: line.discountAmountCents,
      })
      if (netAmountCents < 0) {
        problem = 'la remise dépasse le prix de la ligne.'
        netAmountCents = null
      }
    }
    return { ...base, netAmountCents, includedActs: null, extraActNetCents: null, problem }
  })

  // TVA comme sur la facture : par taux, sur la somme des bases. Les actes
  // inclus, à zéro, n'y ajoutent rien et n'y créent pas de taux vide.
  const taxed = lines.filter(
    (line) => line.netAmountCents !== null && line.kind !== 'act',
  )
  const amounts = invoiceAmounts(
    taxed.map((line) => ({
      id: line.id,
      position: line.position,
      netAmountCents: line.netAmountCents ?? 0,
      vatRateBp: line.vatRateBp,
      vatCategory: line.vatRateBp > 0 ? ('S' as const) : ('Z' as const),
    })),
  )
  for (const line of lines) {
    if (line.netAmountCents === null) continue
    line.vatAmountCents = line.kind === 'act' ? 0 : (amounts.lineVatCents.get(line.id) ?? 0)
  }

  const problems = lines
    .filter((line) => line.problem)
    .map((line) => `${line.label} : ${line.problem}`)
  const listKnown = lines.every((line) => line.listAmountCents !== null)
  const listAmountCents = listKnown
    ? lines.reduce((total, line) => total + (line.listAmountCents ?? 0), 0)
    : null
  const complete = lines.length > 0 && problems.length === 0

  // Sur la durée d'engagement : autant de périodes entières qu'elle en compte.
  // Un engagement de cinq mois facturé au trimestre ne se résume pas en un
  // nombre de périodes ; le total n'est alors pas annoncé.
  const periodMonths = billingPeriodMonths[offer.billingPeriod]
  const periods =
    offer.commitmentMonths !== null && offer.commitmentMonths % periodMonths === 0
      ? offer.commitmentMonths / periodMonths
      : null
  const commitment =
    offer.commitmentMonths !== null && periods !== null
      ? {
          months: offer.commitmentMonths,
          periods,
          totalExclTaxCents: amounts.totalExclTaxCents * periods,
          totalInclTaxCents: amounts.totalInclTaxCents * periods,
        }
      : null

  return {
    currency: offer.currency,
    lines,
    totalExclTaxCents: amounts.totalExclTaxCents,
    totalTaxCents: amounts.totalTaxCents,
    totalInclTaxCents: amounts.totalInclTaxCents,
    vatBreakdown: amounts.breakdown
      .map((group) => ({
        vatRateBp: group.vatRateBp,
        taxableAmountCents: group.taxableAmountCents,
        vatAmountCents: group.vatAmountCents,
      }))
      .sort((a, b) => b.vatRateBp - a.vatRateBp),
    listAmountCents,
    savingsCents:
      listAmountCents !== null && complete ? listAmountCents - amounts.totalExclTaxCents : null,
    periodMonths,
    commitment,
    complete,
    problems,
  }
}
