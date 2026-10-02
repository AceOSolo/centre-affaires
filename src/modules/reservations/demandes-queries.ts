import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { withTenant } from '../../db/index.ts'
import { staffMembers } from '../../db/staff.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { resources } from '../ressources/schema.ts'
import type { BookingWithResource } from './queries.ts'
import { bookings } from './schema.ts'

/**
 * File des demandes à valider (« Demandes », ADR 005), toutes origines : la
 * page publique et l'espace client (ADR 036). Chaque demande dit son canal,
 * son entreprise, et — depuis l'espace client — la personne qui l'a faite.
 */
export type PendingRequest = BookingWithResource & {
  clientName: string | null
  /** Personne de l'entreprise qui a réservé depuis son espace. */
  bookedBy: { name: string | null; email: string } | null
}

/** Demandes en attente de validation, la plus proche d'abord. */
export async function listPendingRequests(): Promise<PendingRequest[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        booking: bookings,
        resource: resources,
        clientName: clients.name,
        memberName: clientMembers.fullName,
        memberEmail: clientMembers.email,
      })
      .from(bookings)
      .innerJoin(resources, eq(resources.id, bookings.resourceId))
      .leftJoin(clients, eq(clients.id, bookings.clientId))
      .leftJoin(
        clientMembers,
        and(eq(clientMembers.clientId, bookings.clientId), eq(clientMembers.id, bookings.bookedByMemberId)),
      )
      .where(and(eq(bookings.status, 'pending'), isNull(resources.deletedAt)))
      .orderBy(asc(bookings.startsAt)),
  )
  return rows.map(({ booking, resource, clientName, memberName, memberEmail }) => ({
    ...booking,
    resource,
    clientName,
    bookedBy: memberEmail ? { name: memberName, email: memberEmail } : null,
  }))
}

/** Qui a fait et qui a annulé une réservation (ADR 036), pour la fiche du back-office. */
export type BookingAuthors = {
  bookedBy: string | null
  cancelledByMember: string | null
  cancelledByStaff: string | null
}

const bookedBy = alias(clientMembers, 'booked_by_members')
const cancelledByMember = alias(clientMembers, 'cancelled_by_members')

/** Noms (ou adresses) des auteurs ; tout à `null` pour une réservation sans trace. */
export async function findBookingAuthors(id: string): Promise<BookingAuthors> {
  const [row] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        bookedBy: sql<string | null>`coalesce(${bookedBy.fullName}, ${bookedBy.email})`,
        cancelledByMember: sql<string | null>`coalesce(${cancelledByMember.fullName}, ${cancelledByMember.email})`,
        cancelledByStaff: sql<string | null>`coalesce(${staffMembers.fullName}, ${staffMembers.email})`,
      })
      .from(bookings)
      .leftJoin(bookedBy, eq(bookedBy.id, bookings.bookedByMemberId))
      .leftJoin(cancelledByMember, eq(cancelledByMember.id, bookings.cancelledByMemberId))
      .leftJoin(staffMembers, eq(staffMembers.id, bookings.cancelledByStaffId))
      .where(eq(bookings.id, id))
      .limit(1),
  )
  return row ?? { bookedBy: null, cancelledByMember: null, cancelledByStaff: null }
}
