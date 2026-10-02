import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { tenants } from '../../db/tenants.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { contracts } from '../contrats/schema.ts'
import { resources } from '../ressources/schema.ts'
import type { OfferCatalogue, OfferInput, OfferLineInput } from './offres-prix.ts'
import type { OfferItemInput, OfferHeaderInput } from './offres-regles.ts'
import {
  offerItems,
  offers,
  ratePlanItems,
  ratePlans,
  services,
  type Offer,
  type OfferItem,
} from './schema.ts'
import { defaultRatePlanOn } from './queries.ts'

/**
 * Offres groupées (R09, ADR 024) : lecture, création, modification,
 * archivage, et le catalogue dont le devis d'une offre a besoin.
 */

export type OfferWithItems = Offer & { items: OfferItem[] }

async function itemsOf(tx: Transaction, offerIds: string[]): Promise<OfferItem[]> {
  if (offerIds.length === 0) return []
  // Une ligne retirée ne compte plus (décision 6) : elle reste en base.
  return tx
    .select()
    .from(offerItems)
    .where(and(inArray(offerItems.offerId, offerIds), isNull(offerItems.deletedAt)))
    .orderBy(asc(offerItems.position), asc(offerItems.id))
}

/** Offres du centre, actives par défaut ; `archived: true` ne rend que les archivées. */
export async function listOffers(filters: { archived?: boolean } = {}): Promise<OfferWithItems[]> {
  return withTenant(currentTenantId(), async (tx) => {
    const rows = await tx
      .select()
      .from(offers)
      .where(filters.archived ? isNotNull(offers.deletedAt) : isNull(offers.deletedAt))
      .orderBy(filters.archived ? desc(offers.deletedAt) : asc(offers.name))
    const items = await itemsOf(
      tx,
      rows.map((offer) => offer.id),
    )
    return rows.map((offer) => ({
      ...offer,
      items: items.filter((item) => item.offerId === offer.id),
    }))
  })
}

export async function findOffer(id: string): Promise<OfferWithItems | undefined> {
  if (!isUuid(id)) return undefined
  return withTenant(currentTenantId(), async (tx) => {
    const [offer] = await tx.select().from(offers).where(eq(offers.id, id)).limit(1)
    if (!offer) return undefined
    return { ...offer, items: await itemsOf(tx, [offer.id]) }
  })
}

/** Contrats vivants tirés de l'offre (`contracts.offer_id`). */
export async function countContractsFromOffer(offerId: string): Promise<number> {
  if (!isUuid(offerId)) return 0
  const [row] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ total: sql<number>`count(*)::int` })
      .from(contracts)
      .where(and(eq(contracts.offerId, offerId), isNull(contracts.deletedAt))),
  )
  return row?.total ?? 0
}

/** Une offre et ses lignes, dans la forme qu'attend `priceOffer`. */
export function toOfferInput(offer: OfferWithItems): OfferInput {
  return {
    billingPeriod: offer.billingPeriod,
    commitmentMonths: offer.commitmentMonths,
    currency: offer.currency,
    items: offer.items.map(toOfferLineInput),
  }
}

export function toOfferLineInput(item: OfferItem): OfferLineInput {
  return {
    id: item.id,
    position: item.position,
    resourceType: item.resourceType,
    resourceId: item.resourceId,
    serviceId: item.serviceId,
    quantity: item.quantity,
    unit: item.unit,
    priceCents: item.priceCents,
    discountBp: item.discountBp,
    discountAmountCents: item.discountAmountCents,
    vatRateBp: item.vatRateBp,
    label: item.label,
  }
}

/**
 * Le catalogue au jour `today` : grille par défaut du centre si elle est en
 * vigueur ce jour-là (dates de validité, ADR 023), services et ressources —
 * archivés compris, pour qu'une ligne qui les vise soit signalée plutôt
 * qu'ignorée — et taux de TVA par défaut du centre.
 */
export async function loadOfferCatalogue(today: string): Promise<OfferCatalogue> {
  return withTenant(currentTenantId(), (tx) => loadOfferCatalogueInTransaction(tx, today))
}

/**
 * Le même catalogue, dans une transaction ouverte : celle de l'espace client
 * (`inClientSpace`, ADR 019), qui montre les offres et leur prix (R23). Les
 * tables lues n'ont pas de client : la portée ne les restreint pas.
 */
export async function loadOfferCatalogueInTransaction(
  tx: Transaction,
  today: string,
): Promise<OfferCatalogue> {
  // La grille par défaut en vigueur ce jour-là, lue comme le moteur de devis
  // la lit (R08, `defaultRatePlanOn`).
  const [plan] = await tx
    .select({ id: ratePlans.id, currency: ratePlans.currency })
    .from(ratePlans)
    .where(defaultRatePlanOn(today))
    .limit(1)
  // Un prix retiré ne s'applique plus (décision 6) : la ligne reste en base.
  const planItems = plan
    ? await tx
        .select({
          resourceType: ratePlanItems.resourceType,
          resourceId: ratePlanItems.resourceId,
          unit: ratePlanItems.unit,
          amountCents: ratePlanItems.amountCents,
        })
        .from(ratePlanItems)
        .where(and(eq(ratePlanItems.ratePlanId, plan.id), isNull(ratePlanItems.deletedAt)))
    : []
  const [tenant] = await tx
    .select({ defaultVatRateBp: tenants.defaultVatRateBp })
    .from(tenants)
    .where(eq(tenants.id, currentTenantId()))
    .limit(1)
  const rateItems = planItems.map(({ resourceType, resourceId, unit, amountCents }) => ({
    resourceType,
    resourceId,
    unit,
    amountCents,
  }))
  const serviceRows = await tx.select().from(services).orderBy(asc(services.name))
  const resourceRows = await tx
    .select({
      id: resources.id,
      code: resources.code,
      name: resources.name,
      resourceType: resources.resourceType,
      deletedAt: resources.deletedAt,
    })
    .from(resources)
    .orderBy(asc(resources.resourceType), asc(resources.code))

  return {
    defaultVatRateBp: tenant?.defaultVatRateBp ?? 2_000,
    rateItems,
    rateCurrency: plan?.currency ?? null,
    services: serviceRows.map((service) => ({
      id: service.id,
      name: service.name,
      nature: service.nature,
      unit: service.unit,
      unitPriceCents: service.unitPriceCents,
      vatRateBp: service.vatRateBp,
      currency: service.currency,
      isActive: service.isActive,
      archived: service.deletedAt !== null,
    })),
    resources: resourceRows.map((resource) => ({
      id: resource.id,
      code: resource.code,
      name: resource.name,
      resourceType: resource.resourceType,
      archived: resource.deletedAt !== null,
    })),
  }
}

/** Levée quand on touche à une offre archivée : elle est figée. */
export class ArchivedOfferError extends Error {
  constructor() {
    super('Cette offre est archivée : elle ne se modifie plus.')
    this.name = 'ArchivedOfferError'
  }
}

/**
 * Refuse d'écrire dans une offre archivée. L'offre reste verrouillée jusqu'à
 * la fin de la transaction : un archivage simultané attend.
 */
async function assertOfferActive(tx: Transaction, offerId: string): Promise<void> {
  const [offer] = await tx
    .select({ deletedAt: offers.deletedAt })
    .from(offers)
    .where(eq(offers.id, offerId))
    .for('update')
  if (!offer || offer.deletedAt) throw new ArchivedOfferError()
}

export async function createOffer(
  input: OfferHeaderInput & { currency?: string },
): Promise<Offer> {
  const [created] = await withTenant(currentTenantId(), (tx) =>
    tx.insert(offers).values(input).returning(),
  )
  return created
}

export async function updateOffer(id: string, input: OfferHeaderInput): Promise<void> {
  await withTenant(currentTenantId(), async (tx) => {
    await assertOfferActive(tx, id)
    await tx.update(offers).set(input).where(eq(offers.id, id))
  })
}

/**
 * Archivage (décision 6) : l'offre n'est plus proposée. Les contrats qui en
 * ont été tirés n'en dépendent pas — ils ont copié ses lignes (ADR 024).
 */
export async function archiveOffer(id: string): Promise<boolean> {
  if (!isUuid(id)) return false
  const archived = await withTenant(currentTenantId(), (tx) =>
    tx
      .update(offers)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(offers.id, id), isNull(offers.deletedAt)))
      .returning({ id: offers.id }),
  )
  return archived.length > 0
}

/** Ajoute une ligne en fin d'offre. */
export async function addOfferItem(offerId: string, input: OfferItemInput): Promise<OfferItem> {
  return withTenant(currentTenantId(), async (tx) => {
    await assertOfferActive(tx, offerId)
    const [last] = await tx
      .select({ position: sql<number>`coalesce(max(${offerItems.position}), -1)::int` })
      .from(offerItems)
      .where(and(eq(offerItems.offerId, offerId), isNull(offerItems.deletedAt)))
    const [created] = await tx
      .insert(offerItems)
      .values({ ...input, offerId, position: (last?.position ?? -1) + 1 })
      .returning()
    return created
  })
}

/** Modifie une ligne vivante d'une offre active. Rend `false` si elle n'existe plus. */
export async function updateOfferItem(
  offerId: string,
  id: string,
  input: OfferItemInput,
): Promise<boolean> {
  if (!isUuid(id)) return false
  return withTenant(currentTenantId(), async (tx) => {
    await assertOfferActive(tx, offerId)
    const updated = await tx
      .update(offerItems)
      .set(input)
      .where(
        and(eq(offerItems.id, id), eq(offerItems.offerId, offerId), isNull(offerItems.deletedAt)),
      )
      .returning({ id: offerItems.id })
    return updated.length > 0
  })
}

/**
 * Retrait d'une ligne : suppression logique (décision 6). Une ligne de contrat
 * qui en a été copiée garde son lien (`contract_lines.offer_item_id`).
 */
export async function removeOfferItem(offerId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false
  return withTenant(currentTenantId(), async (tx) => {
    await assertOfferActive(tx, offerId)
    const removed = await tx
      .update(offerItems)
      .set({ deletedAt: sql`now()` })
      .where(
        and(eq(offerItems.id, id), eq(offerItems.offerId, offerId), isNull(offerItems.deletedAt)),
      )
      .returning({ id: offerItems.id })
    return removed.length > 0
  })
}
