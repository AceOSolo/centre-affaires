import { and, asc, count, eq, isNull } from 'drizzle-orm'

import { PG_EXCLUSION_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { todayIsoDate } from '../../lib/dates.ts'
import { currentTenant, currentTenantId } from '../../lib/tenant.ts'
import { listResources } from '../ressources/queries.ts'
import {
  offerItems,
  offers,
  ratePlanItems,
  ratePlans,
  services,
  type Offer,
} from '../facturation/schema.ts'
import type { RateCandidate } from '../facturation/tarifs.ts'
import { resources } from '../ressources/schema.ts'
import { encodeTarget, targetOf, type LineDraft } from './lignes.ts'
import { linesRefusal, writeDraftLines } from './lignes-queries.ts'
import type { LinesCatalog } from './lines-editor.tsx'
import type { OfferForContract, ProposedSubscription } from './offres.ts'
import { insertContract, referenceRefusal, type ContractInput } from './queries.ts'
import { contracts, type Contract } from './schema.ts'
import { insertContractSubscriptions } from './souscriptions.ts'
import type { ContractLineWithTarget } from './versions.ts'

/**
 * Lecture des offres groupées pour en tirer un contrat (R09, ADR 024), et
 * création du contrat. Le catalogue lui-même (créer, modifier, archiver une
 * offre) relève de l'écran des offres ; ce module ne fait que le lire.
 */

export type OfferSummary = Offer & { itemCount: number }

/** Offres vivantes du centre, par nom, avec leur nombre de lignes. */
export async function listOffersForContract(): Promise<OfferSummary[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ offer: offers, itemCount: count(offerItems.id) })
      .from(offers)
      .leftJoin(
        offerItems,
        and(eq(offerItems.offerId, offers.id), isNull(offerItems.deletedAt)),
      )
      .where(isNull(offers.deletedAt))
      .groupBy(offers.id)
      .orderBy(asc(offers.name)),
  )
  return rows.map((row) => ({ ...row.offer, itemCount: Number(row.itemCount) }))
}

/** Une offre vivante et ses lignes vivantes, avec leur ressource ou leur service. */
export async function findOfferForContract(offerId: string): Promise<OfferForContract | undefined> {
  return withTenant(currentTenantId(), async (tx) => {
    const [offer] = await tx
      .select()
      .from(offers)
      .where(and(eq(offers.id, offerId), isNull(offers.deletedAt)))
    if (!offer) return undefined
    const items = await tx
      .select({
        item: offerItems,
        resource: {
          id: resources.id,
          code: resources.code,
          name: resources.name,
          resourceType: resources.resourceType,
        },
        service: services,
      })
      .from(offerItems)
      .leftJoin(resources, eq(resources.id, offerItems.resourceId))
      .leftJoin(services, eq(services.id, offerItems.serviceId))
      .where(and(eq(offerItems.offerId, offerId), isNull(offerItems.deletedAt)))
      .orderBy(asc(offerItems.position), asc(offerItems.createdAt))
    return {
      id: offer.id,
      name: offer.name,
      billingPeriod: offer.billingPeriod,
      commitmentMonths: offer.commitmentMonths,
      currency: offer.currency,
      items: items.map(({ item, resource, service }) => ({
        id: item.id,
        position: item.position,
        quantity: item.quantity,
        unit: item.unit,
        priceCents: item.priceCents,
        discountBp: item.discountBp,
        discountAmountCents: item.discountAmountCents,
        vatRateBp: item.vatRateBp,
        resourceType: item.resourceType,
        resource: resource?.id ? resource : null,
        service: service
          ? {
              id: service.id,
              name: service.name,
              nature: service.nature,
              unit: service.unit,
              unitPriceCents: service.unitPriceCents,
              vatRateBp: service.vatRateBp,
              currency: service.currency,
              isActive: service.isActive,
              deletedAt: service.deletedAt,
            }
          : null,
      })),
    }
  })
}

/**
 * Prix de la grille par défaut du centre, qui valorise une ligne d'offre de
 * ressource sans prix imposé. Une grille hors de ses dates de validité ce
 * jour-là n'est pas retenue.
 */
export async function listCatalogRates(day: string): Promise<RateCandidate[]> {
  return withTenant(currentTenantId(), async (tx) => {
    const [plan] = await tx
      .select()
      .from(ratePlans)
      .where(and(eq(ratePlans.isDefault, true), isNull(ratePlans.deletedAt)))
      .limit(1)
    if (!plan) return []
    if ((plan.validFrom && plan.validFrom > day) || (plan.validTo && plan.validTo < day)) return []
    return tx
      .select({
        resourceType: ratePlanItems.resourceType,
        resourceId: ratePlanItems.resourceId,
        unit: ratePlanItems.unit,
        amountCents: ratePlanItems.amountCents,
      })
      .from(ratePlanItems)
      .where(and(eq(ratePlanItems.ratePlanId, plan.id), isNull(ratePlanItems.deletedAt)))
  })
}

/** Forfaits vivants et proposés du catalogue : ce qu'une ligne de contrat peut viser. */
export async function listPackageServices() {
  return withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        id: services.id,
        name: services.name,
        unit: services.unit,
        unitPriceCents: services.unitPriceCents,
        vatRateBp: services.vatRateBp,
      })
      .from(services)
      .where(
        and(
          eq(services.nature, 'package'),
          eq(services.isActive, true),
          isNull(services.deletedAt),
        ),
      )
      .orderBy(asc(services.name)),
  )
}

/**
 * Ce que l'éditeur de lignes propose : ressources vivantes, forfaits, prix de
 * la grille par défaut, taux de TVA du centre ; et le libellé des objets déjà
 * portés par des lignes qui ne sont plus au catalogue.
 */
export async function loadLinesCatalog(
  existing: readonly ContractLineWithTarget[] = [],
): Promise<LinesCatalog> {
  const tenant = await currentTenant()
  const [resourceRows, packages, rates] = await Promise.all([
    listResources(),
    listPackageServices(),
    listCatalogRates(todayIsoDate(tenant.timezone)),
  ])
  return {
    resources: resourceRows.map(({ id, code, name, resourceType }) => ({
      id,
      code,
      name,
      resourceType,
    })),
    services: packages,
    rates,
    defaultVatRateBp: tenant.defaultVatRateBp,
    targetLabels: Object.fromEntries(
      existing.flatMap((line) =>
        line.targetLabel ? [[encodeTarget(targetOf(line)), `${line.targetLabel} (hors catalogue)`]] : [],
      ),
    ),
  }
}

/** Deux actes inclus sur le même service se recouvrent : la base refuse. */
export class DuplicateSubscriptionError extends Error {
  constructor() {
    super(
      'Deux actes inclus visent le même service sur la même période : gardez-en un seul, avec la quantité totale.',
    )
    this.name = 'DuplicateSubscriptionError'
  }
}

/**
 * Crée, en une transaction, le brouillon tiré d'une offre : le contrat (avec
 * `offer_id`), ses lignes (avec `offer_item_id`) — la base en déduit le
 * montant —, et les souscriptions des actes inclus, rattachées au contrat sur
 * sa période. Rien n'est écrit si une étape échoue.
 *
 * @throws DuplicateReferenceError si la référence saisie est déjà prise.
 * @throws ContractLinesRefusedError si une ligne est refusée.
 * @throws DuplicateSubscriptionError si deux actes inclus se recouvrent.
 */
export async function createContractFromOffer(input: {
  contract: ContractInput & { offerId: string }
  lines: readonly LineDraft[]
  subscriptions: readonly ProposedSubscription[]
}): Promise<Contract> {
  try {
    return await withTenant(currentTenantId(), async (tx) => {
      const created = await insertContract(tx, input.contract)
      await writeDraftLines(tx, { contractId: created.id, amendmentId: null }, input.lines)
      await insertContractSubscriptions(tx, created, input.subscriptions)
      // Relu : la base a recalculé le montant depuis les lignes.
      const [contract] = await tx.select().from(contracts).where(eq(contracts.id, created.id))
      return contract
    })
  } catch (error) {
    if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION) throw new DuplicateSubscriptionError()
    const reference = referenceRefusal(error, input.contract.reference)
    if (reference !== error) throw reference
    throw linesRefusal(error)
  }
}
