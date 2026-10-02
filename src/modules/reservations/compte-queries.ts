import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { isUuid } from '../../lib/uuid.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import { resources, type ResourceType } from '../ressources/schema.ts'
import { bookings, type Booking } from './schema.ts'

/**
 * Réservations vues depuis l'espace client (ADR 015) : celles des entreprises
 * du compte, et d'elles seules. Deux verrous : le filtre sur `client_id`, et
 * la portée client de la transaction (`inClientSpace`, ADR 019), qui tiendrait
 * sans lui.
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
        resourceName: resources.name,
        resourceType: resources.resourceType,
        clientName: clients.name,
        bookedBy: sql<string | null>`coalesce(${bookedByMembers.fullName}, ${bookedByMembers.email})`,
        cancelledByMember: sql<
          string | null
        >`coalesce(${cancelledByMembers.fullName}, ${cancelledByMembers.email})`,
        cancelledByCentre: sql<boolean>`${bookings.cancelledByStaffId} is not null`,
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

/**
 * Annulation d'une demande par le client : seulement en attente, pas commencée,
 * et pour l'une de ses entreprises — les trois conditions dans le `where`, pour
 * qu'une validation simultanée par le centre l'emporte proprement. Elle porte
 * la personne qui annule (`cancelled_by_member_id`, ADR 036) ; la base refuse
 * toute autre annulation par le client (CA009).
 */
export async function cancelRequestForAccounts(
  id: string,
  accounts: ClientAccount[],
): Promise<boolean> {
  if (accounts.length === 0 || !isUuid(id)) return false
  const clientIds = accounts.map((account) => account.clientId)
  const updated = await inClientSpace(accounts, async (tx) => {
    const [booking] = await tx
      .select({ clientId: bookings.clientId })
      .from(bookings)
      .where(and(eq(bookings.id, id), inArray(bookings.clientId, clientIds)))
      .limit(1)
    const account = booking && accounts.find((candidate) => candidate.clientId === booking.clientId)
    if (!account) return []
    return tx
      .update(bookings)
      .set({
        status: 'cancelled',
        cancelledAt: sql`now()`,
        cancellationReason: 'Annulée par le client',
        cancelledByMemberId: account.memberId,
      })
      .where(
        and(
          eq(bookings.id, id),
          eq(bookings.status, 'pending'),
          sql`${bookings.startsAt} > now()`,
          inArray(bookings.clientId, clientIds),
        ),
      )
      .returning({ id: bookings.id })
  })
  return updated.length > 0
}
