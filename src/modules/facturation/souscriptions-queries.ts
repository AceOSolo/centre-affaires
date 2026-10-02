import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'

import {
  PG_COMMITMENT_LOCKED,
  PG_EXCLUSION_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  pgErrorCode,
} from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { addDaysToIsoDate, toIsoDate, wallClockToUtc } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { clients } from '../clients/schema.ts'
import { contracts, type ContractStatus } from '../contrats/schema.ts'
import { mailItems } from '../courrier/schema.ts'
import { invoiceLines, subscribedServices, type SubscribedService } from './schema-factures.ts'
import { serviceCodes, services, type Service } from './schema.ts'
import {
  cancellationRefusal,
  checkSubscriptionEnd,
  planConditionChange,
  priceActs,
  sameTerms,
  type SubscriptionInput,
  type SubscriptionTerms,
} from './souscriptions-regles.ts'

/**
 * Services souscrits par un client (R18, R07, ADR 024) : lecture pour la fiche
 * client, souscription, changement de conditions, fin, annulation.
 *
 * Ce qui a été convenu ne se réécrit pas (`subscribed_services_guard`) : un
 * changement de quantité ou de prix met fin à la souscription et en ouvre une
 * nouvelle, dans la même transaction.
 */

/**
 * Le contrat d'une souscription, avec ce qui dit si elle se facture : une
 * souscription d'un contrat brouillon attend son activation, celle d'un
 * contrat archivé ne se facture plus (le lot les ignore, ADR 028, ADR 035).
 */
export type SubscriptionContract = {
  id: string
  reference: string
  status: ContractStatus
  archived: boolean
}

export type SubscriptionRow = SubscribedService & {
  service: Pick<Service, 'id' | 'name' | 'code' | 'nature' | 'unit'>
  contract: SubscriptionContract | null
}

const selection = {
  subscription: subscribedServices,
  service: {
    id: services.id,
    name: services.name,
    code: services.code,
    nature: services.nature,
    unit: services.unit,
  },
  contract: {
    id: contracts.id,
    reference: contracts.reference,
    status: contracts.status,
    archived: sql<boolean>`${contracts.deletedAt} is not null`,
  },
}

function hydrate(row: {
  subscription: SubscribedService
  service: SubscriptionRow['service']
  contract: SubscriptionContract | null
}): SubscriptionRow {
  return { ...row.subscription, service: row.service, contract: row.contract }
}

/**
 * Toutes les souscriptions d'un client, annulées comprises : l'historique se
 * lit en lignes, la plus récente d'abord.
 */
export async function listClientSubscriptions(clientId: string): Promise<SubscriptionRow[]> {
  if (!isUuid(clientId)) return []
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select(selection)
      .from(subscribedServices)
      .innerJoin(services, eq(services.id, subscribedServices.serviceId))
      .leftJoin(contracts, eq(contracts.id, subscribedServices.contractId))
      .where(eq(subscribedServices.clientId, clientId))
      .orderBy(
        desc(subscribedServices.startsOn),
        asc(services.name),
        desc(subscribedServices.createdAt),
      ),
  )
  return rows.map(hydrate)
}

/** Ce qui a déjà été facturé au titre d'une souscription. */
export type SubscriptionBilling = {
  /** Dernier jour facturé, toutes factures confondues (brouillons compris). Nul : rien. */
  billedThrough: string | null
  /** Lignes de facture qui la tiennent encore (ni retirées, ni libérées par un avoir). */
  billedLineCount: number
}

/**
 * Une ligne de brouillon tient déjà la source (ADR 026) : elle compte. Une
 * ligne retirée d'un brouillon, ou entièrement créditée (`released_at`), non.
 */
async function billingOf(tx: Transaction, subscriptionId: string): Promise<SubscriptionBilling> {
  const [row] = await tx
    .select({
      billedThrough: sql<string | null>`max(${invoiceLines.periodEnd})::text`,
      billedLineCount: sql<number>`count(*)::int`,
    })
    .from(invoiceLines)
    .where(
      and(
        eq(invoiceLines.subscribedServiceId, subscriptionId),
        isNull(invoiceLines.deletedAt),
        isNull(invoiceLines.releasedAt),
      ),
    )
  return { billedThrough: row?.billedThrough ?? null, billedLineCount: row?.billedLineCount ?? 0 }
}

export type SubscriptionDetail = SubscriptionRow & SubscriptionBilling & {
  client: { id: string; name: string; archived: boolean }
}

export async function findSubscription(id: string): Promise<SubscriptionDetail | undefined> {
  if (!isUuid(id)) return undefined
  return withTenant(currentTenantId(), async (tx) => {
    const [row] = await tx
      .select({
        ...selection,
        client: { id: clients.id, name: clients.name, deletedAt: clients.deletedAt },
      })
      .from(subscribedServices)
      .innerJoin(services, eq(services.id, subscribedServices.serviceId))
      .innerJoin(clients, eq(clients.id, subscribedServices.clientId))
      .leftJoin(contracts, eq(contracts.id, subscribedServices.contractId))
      .where(eq(subscribedServices.id, id))
      .limit(1)
    if (!row) return undefined
    return {
      ...hydrate(row),
      ...(await billingOf(tx, id)),
      client: { id: row.client.id, name: row.client.name, archived: row.client.deletedAt !== null },
    }
  })
}

/** Services proposés à la souscription : vivants et actifs. */
export async function listSubscribableServices(): Promise<Service[]> {
  return withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(services)
      .where(and(isNull(services.deletedAt), eq(services.isActive, true)))
      .orderBy(asc(services.nature), asc(services.name)),
  )
}

/** Contrats d'un client auxquels rattacher une souscription : vivants, non résiliés. */
export async function listSubscriptionContracts(
  clientId: string,
): Promise<{ id: string; reference: string; status: ContractStatus }[]> {
  if (!isUuid(clientId)) return []
  return withTenant(currentTenantId(), (tx) =>
    tx
      .select({ id: contracts.id, reference: contracts.reference, status: contracts.status })
      .from(contracts)
      .where(
        and(
          eq(contracts.clientId, clientId),
          isNull(contracts.deletedAt),
          inArray(contracts.status, ['draft', 'active']),
        ),
      )
      .orderBy(desc(contracts.startsOn), asc(contracts.reference)),
  )
}

/** Refus métier d'une écriture de souscription, à dire tel quel à l'écran. */
export class SubscriptionRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubscriptionRefusedError'
  }
}

const OVERLAP_MESSAGE =
  'Ce client a déjà ce service, pour le même contrat, sur une période qui recouvre celle-ci. ' +
  'Pour changer la quantité ou le prix, changez les conditions de la souscription en cours.'

/** Traduit les refus de la base en messages ; laisse remonter le reste. */
function translate(error: unknown): never {
  if (error instanceof SubscriptionRefusedError) throw error
  switch (pgErrorCode(error)) {
    case PG_EXCLUSION_VIOLATION:
      throw new SubscriptionRefusedError(OVERLAP_MESSAGE)
    case PG_FOREIGN_KEY_VIOLATION:
      throw new SubscriptionRefusedError(
        'Le contrat choisi n’est pas un contrat de ce client, ou le service n’existe plus.',
      )
    case PG_COMMITMENT_LOCKED:
      throw new SubscriptionRefusedError(
        'Une souscription ne se réécrit pas : mettez-y fin, puis souscrivez aux nouvelles conditions.',
      )
    default:
      throw error
  }
}

/** Valeurs à insérer pour une souscription aux conditions données. */
function rowFor(
  base: { clientId: string; contractId: string | null; serviceId: string },
  service: { unit: Service['unit']; currency: string },
  terms: SubscriptionTerms,
  period: { startsOn: string; endsOn: string | null },
  notes: string | null,
) {
  return {
    clientId: base.clientId,
    contractId: base.contractId,
    serviceId: base.serviceId,
    quantity: terms.quantity,
    // L'unité et la devise sont celles du service, figées avec le prix.
    unit: service.unit,
    currency: service.currency,
    unitPriceCents: terms.unitPriceCents,
    discountBp: terms.discountBp,
    discountAmountCents: terms.discountAmountCents,
    vatRateBp: terms.vatRateBp,
    includedQuantity: terms.includedQuantity,
    startsOn: period.startsOn,
    endsOn: period.endsOn,
    notes,
  }
}

/**
 * Souscrit un client à un service, aux conditions saisies : prix et TVA figés
 * dès maintenant. Refusé pour une fiche archivée, un service qui n'est plus
 * proposé, ou une souscription qui en recouvrirait une autre au même service.
 */
export async function subscribe(clientId: string, input: SubscriptionInput): Promise<string> {
  try {
    return await withTenant(currentTenantId(), async (tx) => {
      const [client] = await tx
        .select({ deletedAt: clients.deletedAt })
        .from(clients)
        .where(eq(clients.id, clientId))
        .for('share')
      if (!client || client.deletedAt) {
        throw new SubscriptionRefusedError('Cette fiche client est archivée : elle ne souscrit plus.')
      }
      const [service] = await tx
        .select()
        .from(services)
        .where(eq(services.id, input.serviceId))
        .for('share')
      if (!service || service.deletedAt || !service.isActive) {
        throw new SubscriptionRefusedError('Ce service n’est plus proposé à la souscription.')
      }
      const [created] = await tx
        .insert(subscribedServices)
        .values(
          rowFor(
            { clientId, contractId: input.contractId, serviceId: service.id },
            service,
            input,
            { startsOn: input.startsOn, endsOn: input.endsOn },
            input.notes,
          ),
        )
        .returning({ id: subscribedServices.id })
      return created.id
    })
  } catch (error) {
    translate(error)
  }
}

/** Souscription vivante, verrouillée jusqu'à la fin de la transaction. */
async function lockLiving(tx: Transaction, id: string): Promise<SubscribedService> {
  const [current] = await tx
    .select()
    .from(subscribedServices)
    .where(eq(subscribedServices.id, id))
    .for('update')
  if (!current) throw new SubscriptionRefusedError('Souscription introuvable.')
  if (current.deletedAt) {
    throw new SubscriptionRefusedError('Cette souscription a été annulée : elle ne change plus.')
  }
  return current
}

function termsOf(subscription: SubscribedService): SubscriptionTerms {
  return {
    quantity: subscription.quantity,
    unitPriceCents: subscription.unitPriceCents,
    discountBp: subscription.discountBp,
    discountAmountCents: subscription.discountAmountCents,
    vatRateBp: subscription.vatRateBp,
    includedQuantity: subscription.includedQuantity,
  }
}

/**
 * Nouvelles conditions à compter d'une date d'effet (`planConditionChange`) :
 * la souscription en cours prend fin la veille et une nouvelle la suit — ou,
 * au premier jour et sans rien de facturé, la remplace. Même client, même
 * service, même contrat ; le service peut ne plus être proposé, ses
 * souscriptions continuent. Rend l'identifiant de la nouvelle souscription.
 */
export async function changeSubscriptionConditions(
  id: string,
  effectiveOn: string,
  terms: SubscriptionTerms,
  notes: string | null,
): Promise<string> {
  try {
    return await withTenant(currentTenantId(), async (tx) => {
      const current = await lockLiving(tx, id)
      if (sameTerms(termsOf(current), terms)) {
        throw new SubscriptionRefusedError(
          'Les conditions saisies sont celles de la souscription en cours : rien ne change.',
        )
      }
      const { billedThrough } = await billingOf(tx, id)
      const plan = planConditionChange(current, effectiveOn, billedThrough)
      if (!plan.ok) throw new SubscriptionRefusedError(plan.error)

      if (plan.mode === 'replace') {
        await tx
          .update(subscribedServices)
          .set({ deletedAt: sql`now()` })
          .where(eq(subscribedServices.id, id))
      } else {
        await tx
          .update(subscribedServices)
          .set({ endsOn: plan.previousEndsOn })
          .where(eq(subscribedServices.id, id))
      }

      const [created] = await tx
        .insert(subscribedServices)
        .values(
          rowFor(
            current,
            { unit: current.unit, currency: current.currency },
            terms,
            { startsOn: plan.nextStartsOn, endsOn: plan.nextEndsOn },
            notes ?? current.notes,
          ),
        )
        .returning({ id: subscribedServices.id })
      return created.id
    })
  } catch (error) {
    translate(error)
  }
}

/**
 * Fixe le dernier jour d'une souscription (compris), ou le retire (`null` :
 * sans fin). Refusé avant le premier jour — elle s'annule — ou avant le
 * dernier jour déjà facturé ; prolonger jusque sur une autre souscription au
 * même service est refusé par la base.
 */
export async function setSubscriptionEnd(id: string, endsOn: string | null): Promise<void> {
  try {
    await withTenant(currentTenantId(), async (tx) => {
      const current = await lockLiving(tx, id)
      const { billedThrough } = await billingOf(tx, id)
      const refusal = checkSubscriptionEnd(current, endsOn, billedThrough)
      if (refusal) throw new SubscriptionRefusedError(refusal)
      await tx.update(subscribedServices).set({ endsOn }).where(eq(subscribedServices.id, id))
    })
  } catch (error) {
    if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION) {
      throw new SubscriptionRefusedError(
        'Une autre souscription à ce service, pour le même contrat, prend la suite : ' +
          'la fin ne peut pas la recouvrir.',
      )
    }
    translate(error)
  }
}

/**
 * Annule une souscription saisie par erreur : archivage (décision 6), permis
 * seulement si rien n'a été facturé à son titre.
 */
export async function cancelSubscription(id: string): Promise<void> {
  try {
    await withTenant(currentTenantId(), async (tx) => {
      await lockLiving(tx, id)
      const { billedLineCount } = await billingOf(tx, id)
      const refusal = cancellationRefusal(billedLineCount)
      if (refusal) throw new SubscriptionRefusedError(refusal)
      await tx
        .update(subscribedServices)
        .set({ deletedAt: sql`now()` })
        .where(eq(subscribedServices.id, id))
    })
  } catch (error) {
    translate(error)
  }
}

/** Consommation des actes inclus d'une souscription, sur le mois en cours. */
export type IncludedUsage = {
  /** Actes du mois rattachés à la souscription. */
  acts: number
  /** Dont inclus, à 0 €. */
  included: number
  /** Dont au-delà des inclus, au prix de la souscription. */
  beyond: number
}

/**
 * Plis ouverts ce mois-ci (jour du centre) et ce qu'ils consomment des actes
 * inclus de chaque souscription au service `courrier.ouverture` — la règle de
 * la facture (`priceActs`), annoncée sur la fiche client. Seul acte que
 * l'application enregistre aujourd'hui (ADR 015).
 */
export async function findMailOpeningUsage(
  clientId: string,
  today: string,
  timeZone: string,
): Promise<Map<string, IncludedUsage>> {
  const usage = new Map<string, IncludedUsage>()
  if (!isUuid(clientId)) return usage
  // Le mois civil du centre : du 1er à 0h au 1er du mois suivant, dans son fuseau.
  const monthStart = `${today.slice(0, 7)}-01`
  const nextMonth = `${addDaysToIsoDate(monthStart, 31).slice(0, 7)}-01`
  const from = wallClockToUtc(`${monthStart}T00:00`, timeZone)
  const to = wallClockToUtc(`${nextMonth}T00:00`, timeZone)

  return withTenant(currentTenantId(), async (tx) => {
    const [service] = await tx
      .select({
        id: services.id,
        unitPriceCents: services.unitPriceCents,
        vatRateBp: services.vatRateBp,
        currency: services.currency,
        nature: services.nature,
      })
      .from(services)
      .where(and(eq(services.code, serviceCodes.mailOpening), isNull(services.deletedAt)))
      .limit(1)
    if (!service) return usage

    const subscriptions = await tx
      .select()
      .from(subscribedServices)
      .where(
        and(
          eq(subscribedServices.clientId, clientId),
          eq(subscribedServices.serviceId, service.id),
          isNull(subscribedServices.deletedAt),
        ),
      )
    if (subscriptions.length === 0) return usage

    const opened = await tx
      .select({ id: mailItems.id, openedAt: mailItems.openedAt })
      .from(mailItems)
      .where(
        and(
          eq(mailItems.clientId, clientId),
          isNull(mailItems.deletedAt),
          isNotNull(mailItems.openedAt),
          gte(mailItems.openedAt, from),
          lt(mailItems.openedAt, to),
        ),
      )

    const priced = priceActs(
      opened.map((item) => ({
        id: item.id,
        at: item.openedAt as Date,
        day: toIsoDate(item.openedAt as Date, timeZone),
      })),
      subscriptions.map((subscription) => ({
        id: subscription.id,
        startsOn: subscription.startsOn,
        endsOn: subscription.endsOn,
        unitPriceCents: subscription.unitPriceCents,
        discountBp: subscription.discountBp,
        vatRateBp: subscription.vatRateBp,
        currency: subscription.currency,
        includedQuantity: subscription.includedQuantity,
      })),
      service,
    )
    for (const act of priced) {
      if (!act.subscriptionId) continue
      const entry = usage.get(act.subscriptionId) ?? { acts: 0, included: 0, beyond: 0 }
      entry.acts += 1
      if (act.source === 'included') entry.included += 1
      else entry.beyond += 1
      usage.set(act.subscriptionId, entry)
    }
    return usage
  })
}
