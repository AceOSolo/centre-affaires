import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, notExists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/mysql-core'

import { withTenant } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clients } from '../clients/schema.ts'
import { contracts } from '../contrats/schema.ts'
import { bookings, type BookingKind, type BookingStatus } from '../reservations/schema.ts'
import { resources, type ResourceType } from '../ressources/schema.ts'
import { inspections } from './schema.ts'

/**
 * Ressources non restituées (ADR 063).
 *
 * Une ressource remise par un état des lieux d'entrée clos reste occupée
 * jusqu'à la sortie close qui clôt cette entrée. Passé la fin prévue de
 * l'occupation sans elle, la base refuse toute nouvelle réservation qui finirait
 * après cette fin (`booking_assert_resource_returned`, `85-restitution.sql`),
 * et les réservations déjà posées après elle sont **en conflit** : ce module
 * les lit pour le planning, « Aujourd'hui » et la fiche de la ressource.
 *
 * La règle n'est pas recodée ici : la lecture passe par la fonction de la
 * base, `inspection_unreturned_since()`, celle que lit le trigger. La
 * disponibilité ne se vérifie jamais en code (décision 3) ; ce module ne fait
 * que montrer ce que la base refuserait.
 */

/** Réservation déjà posée après la fin prévue d'une occupation non restituée. */
export type ConflictingBooking = {
  id: string
  kind: BookingKind
  status: BookingStatus
  title: string
  startsAt: Date
  endsAt: Date
  clientId: string | null
  clientName: string | null
  contractId: string | null
}

export type UnreturnedOccupation = {
  /** L'état des lieux d'entrée, clos, que rien ne clôt. */
  entryId: string
  /** Fin prévue de l'occupation, dépassée : la ressource est non restituée depuis. */
  since: Date
  resource: { id: string; name: string; code: string; resourceType: ResourceType }
  client: { id: string; name: string }
  /** Réservation (hors occupation de contrat) ou contrat de l'occupation. */
  booking: { id: string; title: string; startsAt: Date } | null
  contract: { id: string; reference: string } | null
  /** Réservations en conflit, dans l'ordre : toutes celles qui finissent après la fin prévue. */
  conflicts: ConflictingBooking[]
}

/**
 * Occupations non restituées du centre, la plus ancienne d'abord, avec leurs
 * réservations en conflit. La lecture porte son filtre `tenant_id`
 * (décision 1).
 */
export async function listUnreturnedOccupations(): Promise<UnreturnedOccupation[]> {
  const tenantId = currentTenantId()
  return withTenant(tenantId, async (tx) => {
    // D'abord les entrées closes qu'aucune sortie close ne clôt — les
    // occupations en cours, peu nombreuses — : la fonction de la base ne lit
    // qu'elles, pas tout l'historique.
    const exit = alias(inspections, 'exit_inspection')
    const open = await tx
      .select({ id: inspections.id })
      .from(inspections)
      .where(
        and(
          eq(inspections.tenantId, tenantId),
          eq(inspections.kind, 'entry'),
          eq(inspections.status, 'closed'),
          isNull(inspections.deletedAt),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(exit)
              .where(
                and(
                  eq(exit.tenantId, inspections.tenantId),
                  eq(exit.entryInspectionId, inspections.id),
                  eq(exit.status, 'closed'),
                  isNull(exit.deletedAt),
                ),
              ),
          ),
        ),
      )
    if (open.length === 0) return []

    const since = sql<Date | null>`inspection_unreturned_since(${inspections.tenantId}, ${inspections.id})`.mapWith(
      inspections.performedAt,
    )
    const rows = await tx
      .select({
        entryId: inspections.id,
        since,
        bookingId: inspections.bookingId,
        contractId: inspections.contractId,
        resource: {
          id: resources.id,
          name: resources.name,
          code: resources.code,
          resourceType: resources.resourceType,
        },
        clientId: clients.id,
        clientName: clients.name,
        bookingKind: bookings.kind,
        bookingTitle: bookings.title,
        bookingStartsAt: bookings.startsAt,
        contractReference: contracts.reference,
      })
      .from(inspections)
      .innerJoin(
        resources,
        and(eq(resources.tenantId, inspections.tenantId), eq(resources.id, inspections.resourceId)),
      )
      .innerJoin(clients, and(eq(clients.tenantId, inspections.tenantId), eq(clients.id, inspections.clientId)))
      .leftJoin(bookings, and(eq(bookings.tenantId, inspections.tenantId), eq(bookings.id, inspections.bookingId)))
      .leftJoin(
        contracts,
        and(eq(contracts.tenantId, inspections.tenantId), eq(contracts.id, inspections.contractId)),
      )
      .where(
        and(
          eq(inspections.tenantId, tenantId),
          inArray(
            inspections.id,
            open.map((row) => row.id),
          ),
          isNotNull(since),
        ),
      )
    if (rows.length === 0) return []

    const resourceIds = [...new Set(rows.map((row) => row.resource.id))]
    const candidates = await tx
      .select({
        id: bookings.id,
        resourceId: bookings.resourceId,
        kind: bookings.kind,
        status: bookings.status,
        title: bookings.title,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
        clientId: bookings.clientId,
        clientName: clients.name,
        contractId: bookings.contractId,
      })
      .from(bookings)
      .leftJoin(clients, and(eq(clients.tenantId, bookings.tenantId), eq(clients.id, bookings.clientId)))
      .where(
        and(
          eq(bookings.tenantId, tenantId),
          inArray(bookings.resourceId, resourceIds),
          ne(bookings.status, 'cancelled'),
          // Au plus tôt la plus ancienne des fins prévues : le reste se trie ci-dessous.
          gt(bookings.endsAt, new Date(Math.min(...rows.map((row) => row.since!.getTime())))),
        ),
      )
      .orderBy(asc(bookings.startsAt))

    return rows
      .map((row): UnreturnedOccupation => {
        const since = row.since!
        const isBooking = row.bookingId !== null && row.bookingKind !== 'contract'
        return {
          entryId: row.entryId,
          since,
          resource: row.resource,
          client: { id: row.clientId, name: row.clientName },
          booking:
            isBooking && row.bookingId && row.bookingTitle && row.bookingStartsAt
              ? { id: row.bookingId, title: row.bookingTitle, startsAt: row.bookingStartsAt }
              : null,
          contract: row.contractId && row.contractReference ? { id: row.contractId, reference: row.contractReference } : null,
          // Mêmes exclusions que `booking_assert_resource_returned` : l'occupation elle-même.
          conflicts: candidates
            .filter(
              (booking) =>
                booking.resourceId === row.resource.id &&
                booking.endsAt.getTime() > since.getTime() &&
                booking.id !== row.bookingId &&
                !(booking.kind === 'contract' && booking.contractId !== null && booking.contractId === row.contractId),
            )
            .map(({ resourceId: _resourceId, ...booking }) => booking),
        }
      })
      .toSorted((a, b) => a.since.getTime() - b.since.getTime())
  })
}

/** Identifiants des réservations en conflit avec une ressource non restituée. */
export function conflictingBookingIds(occupations: readonly UnreturnedOccupation[]): Set<string> {
  return new Set(occupations.flatMap((occupation) => occupation.conflicts.map((booking) => booking.id)))
}

/**
 * Les réservations d'un planning, celles en conflit marquées `conflict` : les
 * blocs les montrent alors en `--statut-conflit`, avec le libellé « Conflit »
 * (`affichage.ts`).
 */
export function markConflicts<T extends { id: string }>(
  rows: readonly T[],
  occupations: readonly UnreturnedOccupation[],
): (T & { conflict?: boolean })[] {
  const ids = conflictingBookingIds(occupations)
  if (ids.size === 0) return [...rows]
  return rows.map((row) => (ids.has(row.id) ? { ...row, conflict: true } : row))
}

/** Les occupations non restituées d'une ressource. */
export function unreturnedFor(
  occupations: readonly UnreturnedOccupation[],
  resourceId: string,
): UnreturnedOccupation[] {
  return occupations.filter((occupation) => occupation.resource.id === resourceId)
}
