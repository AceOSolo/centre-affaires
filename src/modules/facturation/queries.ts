import { and, asc, eq, isNull, sql } from 'drizzle-orm'

import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import type { ResourceType } from '../ressources/schema.ts'
import { resolveRate, type RateLookup } from './tarifs.ts'
import {
  ratePlanItems,
  ratePlans,
  type RatePlan,
  type RatePlanItem,
  type RateUnit,
} from './schema.ts'

export type RatePlanWithItems = RatePlan & { items: RatePlanItem[] }

export async function listRatePlans(): Promise<RatePlan[]> {
  return withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(ratePlans)
      .where(isNull(ratePlans.deletedAt))
      .orderBy(asc(ratePlans.name)),
  )
}

export async function findRatePlan(id: string): Promise<RatePlanWithItems | undefined> {
  return withTenant(currentTenantId(), async (tx) => {
    const [plan] = await tx.select().from(ratePlans).where(eq(ratePlans.id, id)).limit(1)
    if (!plan) return undefined
    // Un prix retiré ne s'applique plus (décision 6) : la ligne reste en base.
    const items = await tx
      .select()
      .from(ratePlanItems)
      .where(and(eq(ratePlanItems.ratePlanId, id), isNull(ratePlanItems.deletedAt)))
      .orderBy(asc(ratePlanItems.resourceType), asc(ratePlanItems.unit))
    return { ...plan, items }
  })
}

/** Grille appliquée quand un contrat ou une réservation n'en désigne aucune. */
export async function findDefaultRatePlan(): Promise<RatePlanWithItems | undefined> {
  const [plan] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(ratePlans)
      .where(and(eq(ratePlans.isDefault, true), isNull(ratePlans.deletedAt)))
      .limit(1),
  )
  return plan ? findRatePlan(plan.id) : undefined
}

export type RatePlanInput = {
  name: string
  currency?: string
  isDefault?: boolean
  validFrom?: string | null
  validTo?: string | null
}

/** Levée quand une autre grille porte déjà le drapeau « par défaut ». */
export class DefaultRatePlanConflictError extends Error {
  constructor() {
    super('Une autre grille est déjà la grille par défaut du centre.')
    this.name = 'DefaultRatePlanConflictError'
  }
}

export async function createRatePlan(input: RatePlanInput): Promise<RatePlan> {
  try {
    const [created] = await withTenant(currentTenantId(), (tx) =>
      tx
        .insert(ratePlans)
        .values({
          name: input.name,
          currency: input.currency || 'EUR',
          isDefault: input.isDefault ?? false,
          validFrom: input.validFrom || null,
          validTo: input.validTo || null,
        })
        .returning(),
    )
    return created
  } catch (error) {
    // L'index partiel garantit une seule grille par défaut à la fois.
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw new DefaultRatePlanConflictError()
    throw error
  }
}

export type RatePlanItemInput = {
  ratePlanId: string
  resourceType: ResourceType
  resourceId?: string | null
  unit: RateUnit
  amountCents: number
}

/** Levée quand la grille contient déjà un prix pour cette cible et cette unité. */
export class DuplicateRateError extends Error {
  constructor() {
    super('Cette grille fixe déjà un prix pour cette ressource et cette unité.')
    this.name = 'DuplicateRateError'
  }
}

/** Levée quand on touche aux prix d'une grille archivée : ils sont figés. */
export class ArchivedRatePlanError extends Error {
  constructor() {
    super('Cette grille est archivée : ses prix sont figés et ne se modifient plus.')
    this.name = 'ArchivedRatePlanError'
  }
}

/**
 * Refuse d'écrire dans une grille archivée. La grille reste verrouillée en
 * partage jusqu'à la fin de la transaction : un archivage simultané attend.
 */
async function assertRatePlanActive(tx: Transaction, ratePlanId: string): Promise<void> {
  const [plan] = await tx
    .select({ deletedAt: ratePlans.deletedAt })
    .from(ratePlans)
    .where(eq(ratePlans.id, ratePlanId))
    .for('share')
  if (plan?.deletedAt) throw new ArchivedRatePlanError()
}

export async function addRatePlanItem(input: RatePlanItemInput): Promise<RatePlanItem> {
  try {
    const [created] = await withTenant(currentTenantId(), async (tx) => {
      await assertRatePlanActive(tx, input.ratePlanId)
      return tx
        .insert(ratePlanItems)
        .values({ ...input, resourceId: input.resourceId || null })
        .returning()
    })
    return created
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw new DuplicateRateError()
    throw error
  }
}

/**
 * Retrait d'un prix de la grille : suppression logique (décision 6). Le prix
 * cesse de s'appliquer et libère sa place pour celui qui le remplace ; la
 * ligne reste pour expliquer un montant calculé avec lui.
 *
 * Rend `false` quand il n'y avait rien à retirer (déjà retiré, inconnu). Lève
 * `ArchivedRatePlanError` sur une grille archivée, dont les prix sont figés.
 */
export async function removeRatePlanItem(id: string): Promise<boolean> {
  if (!isUuid(id)) return false
  return withTenant(currentTenantId(), async (tx) => {
    const [item] = await tx
      .select({ ratePlanId: ratePlanItems.ratePlanId })
      .from(ratePlanItems)
      .where(and(eq(ratePlanItems.id, id), isNull(ratePlanItems.deletedAt)))
      .limit(1)
    if (!item) return false
    await assertRatePlanActive(tx, item.ratePlanId)
    const removed = await tx
      .update(ratePlanItems)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(ratePlanItems.id, id), isNull(ratePlanItems.deletedAt)))
      .returning({ id: ratePlanItems.id })
    return removed.length > 0
  })
}

/**
 * Archivage d'une grille. Ses prix restent tels quels, figés : la grille reste
 * lisible depuis les contrats qui la désignaient (décision 6).
 */
export async function archiveRatePlan(id: string): Promise<void> {
  await withTenant(currentTenantId(), (tx) =>
    tx
      .update(ratePlans)
      .set({ deletedAt: sql`now()`, isDefault: false })
      .where(and(eq(ratePlans.id, id), isNull(ratePlans.deletedAt))),
  )
}

/**
 * Tarif applicable à une ressource, dans une grille donnée ou dans celle par
 * défaut. Renvoie `undefined` quand aucune grille ne couvre le besoin — au
 * lecteur de décider quoi en faire, pas à cette fonction d'inventer un prix.
 */
export async function findApplicableRate(
  lookup: RateLookup,
  ratePlanId?: string | null,
): Promise<{ plan: RatePlan; item: RatePlanItem } | undefined> {
  const plan = ratePlanId ? await findRatePlan(ratePlanId) : await findDefaultRatePlan()
  if (!plan) return undefined
  const item = resolveRate(plan.items, lookup)
  return item ? { plan, item } : undefined
}
