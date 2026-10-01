import { and, asc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { subscribedServices } from '../facturation/schema-factures.ts'
import { services } from '../facturation/schema.ts'
import type { ProposedSubscription } from './offres.ts'
import { contracts } from './schema.ts'

/**
 * Souscriptions rattachées à un contrat (R09, R18, ADR 024) : les actes
 * inclus d'une offre (« dix numérisations par mois ») deviennent, à la
 * création du contrat, une souscription du client au service de l'acte,
 * rattachée au contrat, avec `included_quantity`.
 *
 * Une souscription ne se réécrit pas (`CA004`) : seuls sa fin, ses notes et
 * son archivage changent. Elle suit donc le contrat par ces seuls moyens :
 *
 * - le brouillon change de dates : la souscription est archivée et refaite
 *   aux nouvelles dates, aux mêmes conditions ;
 * - le contrat est résilié : la souscription prend fin le même jour ;
 * - le contrat est archivé : la souscription l'est aussi, au même instant ;
 *   le désarchivage la rétablit si rien ne l'a remplacée entre-temps.
 *
 * Toutes ces fonctions s'exécutent dans la transaction de l'appelant.
 */

const live = (contractId: string) =>
  and(eq(subscribedServices.contractId, contractId), isNull(subscribedServices.deletedAt))

/** Souscrit le client du contrat aux actes inclus de son offre, sur la période du contrat. */
export async function insertContractSubscriptions(
  tx: Transaction,
  contract: { id: string; clientId: string; startsOn: string; endsOn: string | null; currency: string },
  subscriptions: readonly ProposedSubscription[],
): Promise<void> {
  if (subscriptions.length === 0) return
  await tx.insert(subscribedServices).values(
    subscriptions.map((subscription) => ({
      clientId: contract.clientId,
      contractId: contract.id,
      serviceId: subscription.serviceId,
      quantity: 1,
      unit: 'unit' as const,
      unitPriceCents: subscription.unitPriceCents,
      discountBp: subscription.discountBp,
      discountAmountCents: subscription.discountAmountCents,
      vatRateBp: subscription.vatRateBp,
      currency: contract.currency,
      includedQuantity: subscription.includedQuantity,
      startsOn: contract.startsOn,
      endsOn: contract.endsOn,
      notes: 'Actes inclus de l’offre du contrat',
    })),
  )
}

/**
 * Aligne les souscriptions d'un brouillon sur ses dates : une souscription
 * dont le début diffère est archivée et refaite ; une fin seule se corrige en
 * place.
 */
export async function alignDraftSubscriptions(
  tx: Transaction,
  contract: { id: string; startsOn: string; endsOn: string | null },
): Promise<void> {
  const current = await tx.select().from(subscribedServices).where(live(contract.id))
  for (const subscription of current) {
    if (subscription.startsOn === contract.startsOn) {
      if (subscription.endsOn !== contract.endsOn) {
        await tx
          .update(subscribedServices)
          .set({ endsOn: contract.endsOn })
          .where(eq(subscribedServices.id, subscription.id))
      }
      continue
    }
    await tx
      .update(subscribedServices)
      .set({ deletedAt: sql`now()` })
      .where(eq(subscribedServices.id, subscription.id))
    await tx.insert(subscribedServices).values({
      clientId: subscription.clientId,
      contractId: subscription.contractId,
      serviceId: subscription.serviceId,
      quantity: subscription.quantity,
      unit: subscription.unit,
      unitPriceCents: subscription.unitPriceCents,
      discountBp: subscription.discountBp,
      discountAmountCents: subscription.discountAmountCents,
      vatRateBp: subscription.vatRateBp,
      currency: subscription.currency,
      includedQuantity: subscription.includedQuantity,
      notes: subscription.notes,
      startsOn: contract.startsOn,
      endsOn: contract.endsOn,
    })
  }
}

/**
 * Le contrat est résilié : ses souscriptions prennent fin avec lui. Celle qui
 * aurait commencé après le dernier jour est archivée.
 */
export async function endContractSubscriptions(
  tx: Transaction,
  contractId: string,
  lastDay: string,
): Promise<void> {
  await tx
    .update(subscribedServices)
    .set({ deletedAt: sql`now()` })
    .where(and(live(contractId), gt(subscribedServices.startsOn, lastDay)))
  await tx
    .update(subscribedServices)
    .set({ endsOn: lastDay })
    .where(
      and(
        live(contractId),
        lte(subscribedServices.startsOn, lastDay),
        or(isNull(subscribedServices.endsOn), gt(subscribedServices.endsOn, lastDay)),
      ),
    )
}

/** Archivage du contrat : ses souscriptions vivantes sont archivées au même instant. */
export async function archiveContractSubscriptions(
  tx: Transaction,
  contractId: string,
): Promise<void> {
  await tx
    .update(subscribedServices)
    .set({ deletedAt: sql`now()` })
    .where(live(contractId))
}

/**
 * Désarchivage du contrat : les souscriptions archivées avec lui (même
 * instant) sont rétablies, chacune dans un point de sauvegarde — celle qu'une
 * nouvelle souscription a remplacée entre-temps reste archivée plutôt que de
 * faire échouer le désarchivage.
 */
export async function restoreContractSubscriptions(
  tx: Transaction,
  contractId: string,
): Promise<void> {
  // Comparé en base : un `Date` JavaScript perdrait les microsecondes.
  const archived = await tx
    .select({ id: subscribedServices.id })
    .from(subscribedServices)
    .where(
      and(
        eq(subscribedServices.contractId, contractId),
        sql`${subscribedServices.deletedAt} = (select k.deleted_at from ${contracts} as k where k.id = ${contractId})`,
      ),
    )
  for (const { id } of archived) {
    try {
      await tx.transaction((savepoint) =>
        savepoint
          .update(subscribedServices)
          .set({ deletedAt: null })
          .where(eq(subscribedServices.id, id)),
      )
    } catch {
      // Remplacée par une souscription au même service : elle reste archivée.
    }
  }
}

/** Souscriptions vivantes d'un contrat, pour sa fiche. */
export async function listContractSubscriptions(contractId: string) {
  return withTenant(currentTenantId(), (tx) => selectContractSubscriptions(tx, contractId))
}

/** Souscriptions vivantes d'un contrat, avec le nom du service. */
export async function selectContractSubscriptions(tx: Transaction, contractId: string) {
  return tx
    .select({
      subscription: subscribedServices,
      serviceName: services.name,
      serviceNature: services.nature,
    })
    .from(subscribedServices)
    .innerJoin(services, eq(services.id, subscribedServices.serviceId))
    .where(live(contractId))
    .orderBy(asc(subscribedServices.startsOn), asc(services.name))
}
