import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { tenants } from '../../db/tenants.ts'
import { toIsoDate } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { contracts } from '../contrats/schema.ts'
import { resources } from '../ressources/schema.ts'
import {
  quoteBooking,
  quoteFailureMessages,
  type BookingQuote,
  type QuoteDiscount,
  type QuoteFailure,
  type QuotePlan,
  type QuotePlanSource,
  type QuoteRules,
} from './devis.ts'
import { ratePlanItems, ratePlans } from './schema.ts'

/**
 * `quote()` — le devis d'une réservation, lu en base (R11, ADR 023).
 *
 * Seule fonction serveur qui chiffre un créneau. Elle rassemble ce que
 * `quoteBooking()` (`devis.ts`) demande — les règles du centre, la ressource,
 * les grilles candidates — et le lui confie. L'écran du back-office, la page
 * publique et l'écriture d'une réservation l'appellent ; aucun ne refait le
 * calcul.
 */

export type QuoteRequest = {
  resourceId: string
  startsAt: Date
  endsAt: Date
  /** Entreprise pour qui la ressource est réservée : la grille de son contrat passe avant. */
  clientId?: string | null
  /** Contrat auquel la réservation est rattachée : sa grille passe avant les autres. */
  contractId?: string | null
  discount?: QuoteDiscount | null
}

export type QuoteResultFailure = QuoteFailure | 'ressource-inconnue'

export type QuoteResult =
  | { ok: true; quote: BookingQuote }
  | { ok: false; reason: QuoteResultFailure; message: string }

const resultMessages: Record<QuoteResultFailure, string> = {
  ...quoteFailureMessages,
  'ressource-inconnue': 'Cette ressource n’existe pas ou n’est plus au catalogue.',
}

/** Règles tarifaires et fuseau du centre courant. */
async function loadRules(tx: Transaction): Promise<{ timeZone: string; rules: QuoteRules }> {
  const [tenant] = await tx
    .select({
      timezone: tenants.timezone,
      halfDayMinutes: tenants.halfDayMinutes,
      startedUnitToleranceMinutes: tenants.startedUnitToleranceMinutes,
      defaultVatRateBp: tenants.defaultVatRateBp,
    })
    .from(tenants)
    .where(eq(tenants.id, currentTenantId()))
    .limit(1)
  if (!tenant) throw new Error('Centre introuvable : impossible de lire ses règles tarifaires.')
  return {
    timeZone: tenant.timezone,
    rules: {
      halfDayMinutes: tenant.halfDayMinutes,
      startedUnitToleranceMinutes: tenant.startedUnitToleranceMinutes,
      defaultVatRateBp: tenant.defaultVatRateBp,
    },
  }
}

/** Grilles par identifiant, avec leurs prix vivants. Les archivées sont rendues, marquées. */
async function loadPlans(tx: Transaction, ids: readonly string[]): Promise<Map<string, QuotePlan>> {
  if (ids.length === 0) return new Map()
  const plans = await tx
    .select({
      id: ratePlans.id,
      name: ratePlans.name,
      currency: ratePlans.currency,
      validFrom: ratePlans.validFrom,
      validTo: ratePlans.validTo,
      deletedAt: ratePlans.deletedAt,
    })
    .from(ratePlans)
    .where(inArray(ratePlans.id, [...ids]))
  // Un prix retiré ne s'applique plus (décision 6) : la ligne reste en base.
  const items = await tx
    .select({
      id: ratePlanItems.id,
      ratePlanId: ratePlanItems.ratePlanId,
      resourceType: ratePlanItems.resourceType,
      resourceId: ratePlanItems.resourceId,
      unit: ratePlanItems.unit,
      amountCents: ratePlanItems.amountCents,
    })
    .from(ratePlanItems)
    .where(and(inArray(ratePlanItems.ratePlanId, [...ids]), isNull(ratePlanItems.deletedAt)))
  return new Map(
    plans.map((plan) => [
      plan.id,
      { ...plan, items: items.filter((item) => item.ratePlanId === plan.id) },
    ]),
  )
}

/**
 * Contrats du client qui désignent une grille et couvrent ce jour : en cours
 * (actifs, ou résiliés dont le dernier jour n'est pas passé), non archivés.
 * Le contrat rattaché passe en tête ; puis le plus récent.
 */
async function contractPlanSources(
  tx: Transaction,
  clientId: string,
  day: string,
  contractId: string | null | undefined,
): Promise<{ ratePlanId: string; contractId: string; reference: string }[]> {
  const rows = await tx
    .select({
      id: contracts.id,
      reference: contracts.reference,
      ratePlanId: contracts.ratePlanId,
    })
    .from(contracts)
    .where(
      and(
        eq(contracts.clientId, clientId),
        isNull(contracts.deletedAt),
        isNotNull(contracts.ratePlanId),
        inArray(contracts.status, ['active', 'terminated']),
        sql`${contracts.startsOn} <= ${day}::date`,
        sql`(least(${contracts.endsOn}, ${contracts.terminatedOn}) is null or least(${contracts.endsOn}, ${contracts.terminatedOn}) >= ${day}::date)`,
      ),
    )
    .orderBy(desc(contracts.startsOn), asc(contracts.reference))
  const ordered = [
    ...rows.filter((row) => row.id === contractId),
    ...rows.filter((row) => row.id !== contractId),
  ]
  return ordered.map((row) => ({
    ratePlanId: row.ratePlanId as string,
    contractId: row.id,
    reference: row.reference,
  }))
}

/**
 * Devis dans une transaction ouverte : celle de l'écriture de la réservation,
 * pour que le prix figé soit lu dans le même instantané que l'insertion.
 */
export async function quoteInTransaction(tx: Transaction, request: QuoteRequest): Promise<QuoteResult> {
  const { timeZone, rules } = await loadRules(tx)

  const [resource] = await tx
    .select({ id: resources.id, resourceType: resources.resourceType })
    .from(resources)
    .where(and(eq(resources.id, request.resourceId), isNull(resources.deletedAt)))
    .limit(1)
  if (!resource) return { ok: false, reason: 'ressource-inconnue', message: resultMessages['ressource-inconnue'] }

  const day = toIsoDate(request.startsAt, timeZone)
  const fromContracts = request.clientId
    ? await contractPlanSources(tx, request.clientId, day, request.contractId)
    : []
  const [defaultPlan] = await tx
    .select({ id: ratePlans.id })
    .from(ratePlans)
    .where(and(eq(ratePlans.isDefault, true), isNull(ratePlans.deletedAt)))
    .limit(1)

  const plans = await loadPlans(tx, [
    ...new Set([...fromContracts.map((source) => source.ratePlanId), ...(defaultPlan ? [defaultPlan.id] : [])]),
  ])
  const candidates: { plan: QuotePlan; source: QuotePlanSource }[] = []
  for (const source of fromContracts) {
    const plan = plans.get(source.ratePlanId)
    if (plan) {
      candidates.push({
        plan,
        source: { kind: 'contract', contractId: source.contractId, contractReference: source.reference },
      })
    }
  }
  const fallback = defaultPlan ? plans.get(defaultPlan.id) : undefined
  if (fallback) candidates.push({ plan: fallback, source: { kind: 'default' } })

  const outcome = quoteBooking({
    resource,
    startsAt: request.startsAt,
    endsAt: request.endsAt,
    timeZone,
    plans: candidates,
    rules,
    discount: request.discount,
  })
  return outcome.ok ? outcome : { ...outcome, message: resultMessages[outcome.reason] }
}

/**
 * Devis d'un créneau sur une ressource, pour un client facultatif.
 *
 * Grille appliquée : celle du contrat du client en cours ce jour-là (le
 * contrat rattaché d'abord), si elle est en vigueur et tarife la ressource ;
 * sinon la grille par défaut du centre, si elle est en vigueur. Règles du
 * centre : unité entamée, demi-journée, TVA (ADR 023).
 *
 * Ne lève pas quand le créneau n'est pas chiffrable : rend la raison, que
 * l'écran affiche telle quelle.
 */
export async function quote(request: QuoteRequest): Promise<QuoteResult> {
  return withTenant(currentTenantId(), (tx) => quoteInTransaction(tx, request))
}
