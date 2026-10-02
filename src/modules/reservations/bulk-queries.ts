import { randomUUID } from 'node:crypto'
import { and, asc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { pgErrorCode, PG_EXCLUSION_VIOLATION } from '../../db/errors.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { resources } from '../ressources/schema.ts'
import { overlaps } from './availability.ts'
import { BookingConflictError, type BookingWithResource } from './queries.ts'
import { expandRecurrence, MAX_BULK_BOOKINGS, RecurrenceError, type RecurrenceInput } from './recurrence.ts'
import { bookings, type Booking } from './schema.ts'

export type BulkBookingInput = RecurrenceInput & {
  resourceIds: string[]
  kind: 'booking' | 'unavailability'
  title: string
  notes?: string
}

/** Primitive transactionnelle partagée par l’action et les tests d’intégration. */
export async function insertBookingSeries(tx: Transaction, input: BulkBookingInput, timeZone: string) {
  const ranges = expandRecurrence(input, timeZone)
  const resourceIds = [...new Set(input.resourceIds)]
  if (!resourceIds.length || resourceIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    throw new RecurrenceError('Choisissez au moins une ressource.')
  }
  if (!['booking', 'unavailability'].includes(input.kind) || !input.title.trim() || input.title.trim().length > 200) {
    throw new RecurrenceError('Indiquez un type et un objet valides (200 caractères maximum).')
  }
  if (ranges.length * resourceIds.length > MAX_BULK_BOOKINGS) {
    throw new RecurrenceError(`Un lot est limité à ${MAX_BULK_BOOKINGS} réservations, toutes ressources comprises.`)
  }
  const available = await tx.select({ id: resources.id }).from(resources)
    .where(and(inArray(resources.id, resourceIds), eq(resources.status, 'active'), isNull(resources.deletedAt)))
    .for('share')
  if (available.length !== resourceIds.length) throw new RecurrenceError('Une des ressources choisies n’est plus en service.')

  const existing = await tx.select().from(bookings).where(and(
    inArray(bookings.resourceId, resourceIds), ne(bookings.status, 'cancelled'),
    lt(bookings.startsAt, ranges[ranges.length - 1].endsAt), gt(bookings.endsAt, ranges[0].startsAt),
  )).orderBy(asc(bookings.startsAt))
  const conflicts = existing.filter((booking) => ranges.some((range) => overlaps(range, booking)))
  if (conflicts.length) throw new BookingConflictError(conflicts)

  const seriesId = randomUUID()
  const created = await tx.insert(bookings).values(resourceIds.flatMap((resourceId) => ranges.map((range) => ({
    ...range, resourceId, seriesId, kind: input.kind, channel: 'staff' as const,
    title: input.kind === 'unavailability' ? `Indisponible — ${input.title.trim()}` : input.title.trim(),
    notes: input.notes?.trim() || null,
  })))).returning({ id: bookings.id })
  return { seriesId, count: created.length }
}

export async function createBookingSeries(input: BulkBookingInput, timeZone: string) {
  try {
    return await withTenant(currentTenantId(), (tx) => insertBookingSeries(tx, input, timeZone))
  } catch (error) {
    // La contrainte d’exclusion tranche aussi lorsqu’un autre utilisateur écrit
    // entre la lecture et l’insertion. La transaction annule alors tout le lot.
    if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION) throw new BookingConflictError([])
    throw error
  }
}

export async function listBookingSeries(seriesId: string): Promise<BookingWithResource[]> {
  const rows = await withTenant(currentTenantId(), (tx) => tx
    .select({ booking: bookings, resource: resources }).from(bookings)
    .innerJoin(resources, eq(resources.id, bookings.resourceId))
    .where(eq(bookings.seriesId, seriesId)).orderBy(asc(bookings.startsAt), asc(resources.name)))
  return rows.map(({ booking, resource }) => ({ ...booking, resource }))
}

export async function cancelFutureSeries(tx: Transaction, seriesId: string): Promise<Pick<Booking, 'id'>[]> {
  return tx.update(bookings).set({
    status: 'cancelled', cancelledAt: sql`now()`, cancellationReason: 'Annulation des occurrences à venir de la série',
  }).where(and(eq(bookings.seriesId, seriesId), ne(bookings.status, 'cancelled'), gt(bookings.startsAt, sql`now()`)))
    .returning({ id: bookings.id })
}
