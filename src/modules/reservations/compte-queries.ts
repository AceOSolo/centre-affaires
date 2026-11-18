import { and, desc, eq, gt, gte, inArray, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/mysql-core'

import { maintenant } from '../../db/columns.ts'
import { DB_CLIENT_CHANGE_REFUSED, dbErrorCode } from '../../db/errors.ts'
import type { Transaction } from '../../db/index.ts'
import { updateReturning } from '../../db/returning.ts'
import { tenants } from '../../db/tenants.ts'
import { isUuid } from '../../lib/uuid.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import { guardMessage } from '../facturation/erreurs-base.ts'
import { resources, type ResourceType } from '../ressources/schema.ts'
import { clientChangeBlocker, clientChangeBlockerMessage, type ClientChangePolicy } from './compte-regles.ts'
import { cancelOptionsInTransaction } from './options-cascade.ts'
import { bookings, type Booking } from './schema.ts'

/**
 * Réservations vues depuis l'espace client (ADR 015) : celles des entreprises
 * du compte, et d'elles seules. Le filtre sur `client_id` est
 * obligatoire : MySQL n'a pas de RLS, la base ne filtre pas les lectures sous
 * `inClientSpace` (ADR 019, conventions §6). Les écritures, elles, sont
 * gardées par les triggers de `bookings`.
 */
export type ClientBookingRow = Pick<
  Booking,
  | 'id'
  | 'status'
  | 'startsAt'
  | 'endsAt'
  | 'title'
  | 'cancellationReason'
  | 'clientId'
  | 'channel'
  | 'cancelledAt'
  | 'quoteUnit'
  | 'quoteQuantity'
  | 'quoteUnitPriceCents'
  | 'quoteDiscountBp'
  | 'quoteDiscountAmountCents'
  | 'quoteAmountCents'
  | 'quoteVatRateBp'
  | 'quoteCurrency'
  | 'quotedAt'
  | 'parentBookingId'
> & {
  resourceName: string
  resourceType: ResourceType
  clientName: string
  /** Personne de l'entreprise qui a réservé depuis l'espace (ADR 036) : son nom, ou son adresse. */
  bookedBy: string | null
  /** Personne de l'entreprise qui a annulé depuis l'espace. */
  cancelledByMember: string | null
  /** Annulée ou refusée par l'équipe du centre. */
  cancelledByCentre: boolean
  /** Matériel en option encore vivant (ADR 062) : une réservation qui en a ne se modifie pas d'ici (ADR 076). */
  optionCount: number
}

// Deux lectures de la même table : l'auteur de la réservation et celui de l'annulation.
const bookedByMembers = alias(clientMembers, 'booked_by_members')
const cancelledByMembers = alias(clientMembers, 'cancelled_by_members')

/** Historique limité aux six derniers mois : l'espace sert à ce qui vient. */
const HISTORY_DAYS = 183

export async function listBookingsForAccounts(accounts: ClientAccount[]): Promise<ClientBookingRow[]> {
  if (accounts.length === 0) return []
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000)

  return inClientSpace(accounts, (tx) =>
    tx
      .select({
        id: bookings.id,
        status: bookings.status,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
        title: bookings.title,
        cancellationReason: bookings.cancellationReason,
        clientId: bookings.clientId,
        channel: bookings.channel,
        cancelledAt: bookings.cancelledAt,
        quoteUnit: bookings.quoteUnit,
        quoteQuantity: bookings.quoteQuantity,
        quoteUnitPriceCents: bookings.quoteUnitPriceCents,
        quoteDiscountBp: bookings.quoteDiscountBp,
        quoteDiscountAmountCents: bookings.quoteDiscountAmountCents,
        quoteAmountCents: bookings.quoteAmountCents,
        quoteVatRateBp: bookings.quoteVatRateBp,
        quoteCurrency: bookings.quoteCurrency,
        quotedAt: bookings.quotedAt,
        parentBookingId: bookings.parentBookingId,
        resourceName: resources.name,
        resourceType: resources.resourceType,
        clientName: clients.name,
        bookedBy: sql<string | null>`coalesce(${bookedByMembers.fullName}, ${bookedByMembers.email})`,
        cancelledByMember: sql<
          string | null
        >`coalesce(${cancelledByMembers.fullName}, ${cancelledByMembers.email})`,
        cancelledByCentre: sql<boolean>`${bookings.cancelledByStaffId} is not null`.mapWith(Boolean),
        optionCount: sql<number>`(select count(*) from bookings as live_options
           where live_options.tenant_id = ${bookings.tenantId}
             and live_options.parent_booking_id = ${bookings.id}
             and live_options.status <> 'cancelled')`.mapWith(Number),
      })
      .from(bookings)
      .innerJoin(resources, eq(resources.id, bookings.resourceId))
      .innerJoin(clients, eq(clients.id, bookings.clientId))
      // Les personnes sont de l'entreprise de la réservation (clé étrangère
      // composite) : la portée client les laisse lire.
      .leftJoin(bookedByMembers, eq(bookedByMembers.id, bookings.bookedByMemberId))
      .leftJoin(cancelledByMembers, eq(cancelledByMembers.id, bookings.cancelledByMemberId))
      .where(
        and(
          inArray(
            bookings.clientId,
            accounts.map((account) => account.clientId),
          ),
          eq(bookings.kind, 'booking'),
          gte(bookings.endsAt, since),
        ),
      )
      .orderBy(desc(bookings.startsAt))
      .limit(300),
  )
}

/** Le délai du centre (ADR 076), lu dans la transaction de l'appelant. */
export async function clientChangePolicy(tx: Transaction): Promise<ClientChangePolicy> {
  const [tenant] = await tx
    .select({ days: tenants.bookingChangeDays, timeZone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, currentTenantId()))
    .limit(1)
  if (!tenant) throw new Error('Centre introuvable : impossible de lire le délai de modification.')
  return tenant
}

/** Motif posé sur une annulation par le client, reconnu par l'historique du compte. */
const CLIENT_CANCELLATION_REASON = 'Annulée par le client'

/** Issue d'une annulation par le client : ce qu'il faut pour prévenir l'accueil, ou pourquoi non. */
export type ClientCancelOutcome =
  | { ok: true; wasConfirmed: boolean; memberId: string; optionIds: string[] }
  | { ok: false; message: string }

const notCancellable =
  'Cette réservation ne peut plus être annulée d’ici : elle vient peut-être de changer. Contactez le centre.'

/**
 * Annulation par le client (ADR 076) : une demande en attente ou une
 * réservation confirmée, pas commencée, jusqu'à N jours avant son début
 * (`booking_change_days`), pour l'une de ses entreprises — les conditions
 * reprises dans le `where`, pour qu'une validation simultanée par le centre
 * l'emporte proprement. Elle porte la personne qui annule
 * (`cancelled_by_member_id`, ADR 036) ; la base refuse toute autre annulation
 * par le client (CA022).
 *
 * Le matériel en option ne s'annule pas seul (ADR 062) : il est annulé avec
 * sa salle, d'abord, dans la même transaction et au nom de la même personne.
 */
export async function cancelForAccounts(id: string, accounts: ClientAccount[]): Promise<ClientCancelOutcome> {
  if (accounts.length === 0 || !isUuid(id)) return { ok: false, message: notCancellable }
  const clientIds = accounts.map((account) => account.clientId)
  try {
    return await inClientSpace(accounts, async (tx): Promise<ClientCancelOutcome> => {
      const [booking] = await tx
        .select({
          clientId: bookings.clientId,
          parentBookingId: bookings.parentBookingId,
          status: bookings.status,
          startsAt: bookings.startsAt,
          endsAt: bookings.endsAt,
        })
        .from(bookings)
        .where(and(eq(bookings.id, id), inArray(bookings.clientId, clientIds), eq(bookings.kind, 'booking')))
        .limit(1)
      const account = booking && accounts.find((candidate) => candidate.clientId === booking.clientId)
      if (!account) return { ok: false, message: notCancellable }
      const policy = await clientChangePolicy(tx)
      const blocker = clientChangeBlocker(booking, new Date(), policy)
      if (blocker) return { ok: false, message: clientChangeBlockerMessage(blocker, policy) }
      const options = await cancelOptionsInTransaction(tx, [id], {
        cancelledAt: maintenant(),
        cancellationReason: CLIENT_CANCELLATION_REASON,
        cancelledByMemberId: account.memberId,
      })
      const updated = await updateReturning(
        tx,
        bookings,
        {
          status: 'cancelled',
          cancelledAt: maintenant(),
          cancellationReason: CLIENT_CANCELLATION_REASON,
          cancelledByMemberId: account.memberId,
        },
        and(
          eq(bookings.id, id),
          inArray(bookings.status, ['pending', 'confirmed']),
          gt(bookings.startsAt, maintenant()),
          inArray(bookings.clientId, clientIds),
        ),
      )
      if (updated.length === 0) return { ok: false, message: notCancellable }
      return {
        ok: true,
        wasConfirmed: booking.status === 'confirmed',
        memberId: account.memberId,
        optionIds: options.map((option) => option.id),
      }
    })
  } catch (error) {
    // La base a le dernier mot sur le délai (`24-formules-et-modifications.sql`).
    if (dbErrorCode(error) === DB_CLIENT_CHANGE_REFUSED) return { ok: false, message: guardMessage(error) ?? notCancellable }
    throw error
  }
}

/** Même annulation, réduite à « faite ou non » (tests, appels qui n'ont rien à prévenir). */
export async function cancelRequestForAccounts(id: string, accounts: ClientAccount[]): Promise<boolean> {
  return (await cancelForAccounts(id, accounts)).ok
}
