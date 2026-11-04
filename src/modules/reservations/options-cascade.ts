import { and, eq, inArray, isNotNull, ne, type SQL } from 'drizzle-orm'

import { tenantContext } from '../../db/contexte.ts'
import type { Transaction } from '../../db/index.ts'
import { updateReturning } from '../../db/returning.ts'
import { bookings, type Booking } from './schema.ts'

/**
 * Le matériel en option suit sa réservation principale (ADR 062) : ces
 * écritures se font **dans la transaction** qui change la principale, avant
 * elle quand elle s'annule.
 *
 * MySQL interdit à un trigger d'écrire dans la table qui le déclenche : la
 * cascade ne peut pas se faire en base. La base garantit seulement qu'elle
 * n'est pas oubliée — une principale ne s'annule pas tant qu'une option vit,
 * une option ne sort ni de sa période ni de son client (`CA018`,
 * `src/db/regles/25-reservations-liees.sql`).
 *
 * Module bas : il ne dépend que du schéma, pour servir aussi bien
 * `queries.ts` que l'espace client et les séries.
 */

/** Filtre de centre : la lecture porte son `tenant_id` (décision 1). */
function inTenant() {
  const tenantId = tenantContext.getStore()
  return tenantId ? eq(bookings.tenantId, tenantId) : undefined
}

/** Options encore vivantes de ces réservations. */
function liveOptionsOf(parentIds: readonly string[]) {
  return and(
    inTenant(),
    inArray(bookings.parentBookingId, [...parentIds]),
    ne(bookings.status, 'cancelled'),
  )
}

/** Ce que porte l'annulation : la même que celle de la principale. */
export type OptionCancellation = {
  /** L'instant de l'annulation : `maintenant()`, celui de la base. */
  cancelledAt: Date | SQL
  cancellationReason: string | null
  cancelledByStaffId?: string | null
  cancelledByMemberId?: string | null
}

/**
 * Annule les options vivantes des réservations données, avec le motif et
 * l'auteur de l'annulation de la principale. À appeler **avant** d'annuler
 * la principale : la base refuse l'inverse. Rend les options annulées (leur
 * agenda Google est à mettre à jour après la réponse).
 */
export async function cancelOptionsInTransaction(
  tx: Transaction,
  parentIds: readonly string[],
  cancellation: OptionCancellation,
): Promise<Booking[]> {
  if (parentIds.length === 0) return []
  return updateReturning(
    tx,
    bookings,
    {
      status: 'cancelled',
      cancelledAt: cancellation.cancelledAt,
      cancellationReason: cancellation.cancellationReason,
      cancelledByStaffId: cancellation.cancelledByStaffId ?? null,
      cancelledByMemberId: cancellation.cancelledByMemberId ?? null,
    },
    liveOptionsOf(parentIds),
  )
}

/**
 * Valide les options en attente d'une demande que l'équipe valide, au nom du
 * même membre. À appeler **après** la principale : la base refuse de
 * confirmer une option avant elle.
 */
export async function confirmOptionsInTransaction(
  tx: Transaction,
  parentId: string,
  staffId: string | null,
): Promise<Booking[]> {
  return updateReturning(
    tx,
    bookings,
    { status: 'confirmed', confirmedByStaffId: staffId },
    and(inTenant(), eq(bookings.parentBookingId, parentId), eq(bookings.status, 'pending')),
  )
}

/**
 * Reporte la période de la principale sur ses options vivantes, après son
 * déplacement. Un appareil déjà pris sur la nouvelle période fait refuser
 * l'ensemble par le trigger anti-chevauchement (`CA000`) : la transaction
 * entière est annulée, la salle ne part pas sans son matériel.
 */
export async function moveOptionsInTransaction(
  tx: Transaction,
  parent: Pick<Booking, 'id' | 'startsAt' | 'endsAt'>,
): Promise<Booking[]> {
  return updateReturning(
    tx,
    bookings,
    { startsAt: parent.startsAt, endsAt: parent.endsAt },
    liveOptionsOf([parent.id]),
  )
}

/**
 * Le client de la principale change : ses options vivantes suivent (la base
 * l'exige). Une option annulée reste l'historique de l'ancien client.
 */
export async function reassignOptionsInTransaction(
  tx: Transaction,
  parentId: string,
  clientId: string | null,
): Promise<void> {
  await tx
    .update(bookings)
    .set({ clientId, contractId: null })
    .where(liveOptionsOf([parentId]))
}

/** Les options, vivantes ou non, de réservations données : pour l'affichage et les agendas. */
export async function optionIdsOf(tx: Transaction, parentIds: readonly string[]): Promise<string[]> {
  if (parentIds.length === 0) return []
  const rows = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(inTenant(), isNotNull(bookings.parentBookingId), inArray(bookings.parentBookingId, [...parentIds])))
  return rows.map((row) => row.id)
}
