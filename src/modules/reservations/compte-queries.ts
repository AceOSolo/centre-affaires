import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'

import { isUuid } from '../../lib/uuid.ts'
import { clients } from '../clients/schema.ts'
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
  'id' | 'status' | 'startsAt' | 'endsAt' | 'title' | 'cancellationReason' | 'clientId'
> & {
  resourceName: string
  resourceType: ResourceType
  clientName: string
}

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
        resourceName: resources.name,
        resourceType: resources.resourceType,
        clientName: clients.name,
      })
      .from(bookings)
      .innerJoin(resources, eq(resources.id, bookings.resourceId))
      .innerJoin(clients, eq(clients.id, bookings.clientId))
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
