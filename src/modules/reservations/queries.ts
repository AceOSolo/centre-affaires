import { and, asc, eq, gt, gte, isNull, lt, ne, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { PG_EXCLUSION_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { dayRangeUtc } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { openingWindows } from '../ressources/ouverture.ts'
import { loadOpeningContext } from '../ressources/ouverture-queries.ts'
import { listBookableResources } from '../ressources/queries.ts'
import { resources, type Resource } from '../ressources/schema.ts'
import { isValidRange, occupiesResource, type TimeRange } from './availability.ts'
import { freeMinutes, freeRanges } from './slots.ts'
import { bookings, type Booking } from './schema.ts'

/** Une réservation et la ressource qu'elle occupe, tel que le planning l'affiche. */
export type BookingWithResource = Booking & { resource: Resource }

/**
 * Réservations d'une journée du centre, annulées comprises pour que le staff
 * garde trace de ce qui a été libéré.
 *
 * Le filtre porte sur les bornes UTC de la journée locale : à Paris, la journée
 * du 15 juillet commence à 22h00 UTC la veille.
 */
export async function listBookingsForDay(
  isoDate: string,
  timeZone: string,
): Promise<BookingWithResource[]> {
  const day = dayRangeUtc(isoDate, timeZone)
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ booking: bookings, resource: resources })
      .from(bookings)
      .innerJoin(resources, eq(resources.id, bookings.resourceId))
      .where(and(lt(bookings.startsAt, day.endsAt), gt(bookings.endsAt, day.startsAt)))
      .orderBy(asc(bookings.startsAt)),
  )
  return rows.map(({ booking, resource }) => ({ ...booking, resource }))
}

export async function findBooking(id: string): Promise<BookingWithResource | undefined> {
  const [row] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ booking: bookings, resource: resources })
      .from(bookings)
      .innerJoin(resources, eq(resources.id, bookings.resourceId))
      .where(eq(bookings.id, id))
      .limit(1),
  )
  return row ? { ...row.booking, resource: row.resource } : undefined
}

/**
 * Réservations qui occupent déjà la ressource sur l'intervalle.
 *
 * Reproduit le prédicat de `bookings_no_overlap` : bornes `[)` et annulées
 * exclues. Sert à nommer le conflit dans le message d'erreur, jamais à
 * autoriser l'écriture — c'est la contrainte qui tranche (décision 3).
 */
function selectConflicts(
  tx: Transaction,
  candidate: { resourceId: string; startsAt: Date; endsAt: Date },
  excludeBookingId?: string,
) {
  return tx
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.resourceId, candidate.resourceId),
        ne(bookings.status, 'cancelled'),
        lt(bookings.startsAt, candidate.endsAt),
        gt(bookings.endsAt, candidate.startsAt),
        excludeBookingId ? ne(bookings.id, excludeBookingId) : undefined,
      ),
    )
    .orderBy(asc(bookings.startsAt))
}

/** Créneau déjà pris. Porte les réservations en cause pour l'affichage. */
export class BookingConflictError extends Error {
  // Champ déclaré puis affecté, et non `constructor(public …)` : le strip de
  // types de Node ne compile pas les paramètres-propriétés, ce qui rendrait ce
  // module — et tout ce qui l'importe — impossible à charger sous `node --test`.
  readonly conflicts: Booking[]

  constructor(conflicts: Booking[]) {
    super('Ce créneau est déjà réservé sur cette ressource.')
    this.name = 'BookingConflictError'
    this.conflicts = conflicts
  }
}

/** Intervalle vide ou inversé, refusé avant même d'atteindre la base. */
export class InvalidRangeError extends Error {
  constructor() {
    super("L'heure de fin doit être postérieure à l'heure de début.")
    this.name = 'InvalidRangeError'
  }
}

export type CreateBookingInput = {
  resourceId: string
  startsAt: Date
  endsAt: Date
  title: string
  notes?: string | null
}

export async function createBooking(input: CreateBookingInput): Promise<Booking> {
  if (!isValidRange(input)) throw new InvalidRangeError()

  try {
    const [created] = await withTenant(currentTenantId(), (tx) =>
      tx
        .insert(bookings)
        .values({
          resourceId: input.resourceId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          title: input.title,
          notes: input.notes ?? null,
        })
        .returning(),
    )
    return created
  } catch (error) {
    if (pgErrorCode(error) !== PG_EXCLUSION_VIOLATION) throw error
    // La contrainte a refusé l'écriture ; on relit pour dire au staff quelle
    // réservation occupe le créneau plutôt que « conflit ».
    const conflicts = await withTenant(currentTenantId(), (tx) => selectConflicts(tx, input))
    throw new BookingConflictError(conflicts)
  }
}

/**
 * Annulation : la ligne est conservée, le créneau est libéré. `cancelled_at` est
 * posé dans le même ordre que la contrainte `bookings_cancelled_at_consistent`
 * l'exige.
 */
export async function cancelBooking(id: string, reason?: string | null): Promise<void> {
  await withTenant(currentTenantId(), (tx) =>
    tx
      .update(bookings)
      .set({
        status: 'cancelled',
        cancelledAt: sql`now()`,
        cancellationReason: reason?.trim() || null,
      })
      .where(and(eq(bookings.id, id), ne(bookings.status, 'cancelled'))),
  )
}


/* ------------------------------------------------------------------------ */
/* Page publique et file de validation (ADR 005)                            */
/* ------------------------------------------------------------------------ */

/** Ce qu'une ressource a de libre un jour donné, tel que la page publique le montre. */
export type ResourceAvailability = {
  resource: Resource
  free: TimeRange[]
  freeMinutes: number
  /** Fermé ce jour-là : aucune plage d'ouverture, ou fermeture exceptionnelle. */
  closed: boolean
}

/**
 * Disponibilités du jour, ressource par ressource.
 *
 * Ne remonte que les ressources `active` : une salle en maintenance n'est pas
 * proposée au public.
 *
 * Les trous sont cherchés à l'intérieur des vraies plages d'ouverture, une par
 * une : un centre qui ferme entre 12h et 14h ne doit pas proposer la pause
 * déjeuner sous prétexte qu'aucune réservation ne l'occupe. « Fermé » et
 * « complet » sont deux réponses différentes, et l'écran doit pouvoir les
 * distinguer.
 */
export async function listDayAvailability(
  isoDate: string,
  timeZone: string,
): Promise<ResourceAvailability[]> {
  const [bookable, bookings, opening] = await Promise.all([
    listBookableResources(),
    listBookingsForDay(isoDate, timeZone),
    loadOpeningContext(isoDate, isoDate),
  ])

  return bookable.map((resource) => {
    const windows = openingWindows(isoDate, timeZone, {
      rules: opening.rules,
      closures: opening.closures,
      resourceId: resource.id,
    })
    // Les annulées libèrent leur créneau ; les `pending` l'occupent, une demande
    // en attente ne doit pas être proposée deux fois (ADR 005).
    const busy = bookings.filter(
      (booking) => booking.resourceId === resource.id && occupiesResource(booking.status),
    )
    const free = windows.flatMap((window) => freeRanges(window, busy))
    return { resource, free, freeMinutes: freeMinutes(free), closed: windows.length === 0 }
  })
}

/**
 * Demandes déposées depuis la même adresse sur une fenêtre glissante.
 *
 * Comptées en base et non en mémoire : l'application tourne sur plusieurs
 * instances sans état partagé, un compteur en mémoire ne limiterait rien.
 */
export async function countRecentRequestsByEmail(
  email: string,
  windowHours: number,
): Promise<number> {
  const since = new Date(Date.now() - windowHours * 3_600_000)
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(bookings)
      .where(
        and(eq(bookings.requesterEmail, email.trim().toLowerCase()), gte(bookings.createdAt, since)),
      ),
  )
  return rows[0]?.count ?? 0
}

export type BookingRequestInput = CreateBookingInput & {
  requesterName: string
  requesterEmail: string
  requesterPhone: string
}

/**
 * Dépôt d'une demande publique : une réservation `pending`, qui occupe le
 * créneau dès maintenant (ADR 005).
 *
 * Passe par le même chemin que `createBooking`, donc sous la même contrainte
 * d'exclusion : deux demandes simultanées sur le même créneau ne peuvent pas
 * être acceptées toutes les deux.
 */
export async function createBookingRequest(input: BookingRequestInput): Promise<Booking> {
  if (!isValidRange(input)) throw new InvalidRangeError()

  try {
    const [created] = await withTenant(currentTenantId(), (tx) =>
      tx
        .insert(bookings)
        .values({
          resourceId: input.resourceId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          title: input.title,
          notes: input.notes ?? null,
          status: 'pending',
          requesterName: input.requesterName.trim(),
          requesterEmail: input.requesterEmail.trim().toLowerCase(),
          requesterPhone: input.requesterPhone.trim(),
        })
        .returning(),
    )
    return created
  } catch (error) {
    if (pgErrorCode(error) !== PG_EXCLUSION_VIOLATION) throw error
    const conflicts = await withTenant(currentTenantId(), (tx) => selectConflicts(tx, input))
    throw new BookingConflictError(conflicts)
  }
}

/** Demandes en attente de validation, la plus proche d'abord. */
export async function listPendingBookings(): Promise<BookingWithResource[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ booking: bookings, resource: resources })
      .from(bookings)
      .innerJoin(resources, eq(resources.id, bookings.resourceId))
      .where(and(eq(bookings.status, 'pending'), isNull(resources.deletedAt)))
      .orderBy(asc(bookings.startsAt)),
  )
  return rows.map(({ booking, resource }) => ({ ...booking, resource }))
}

/**
 * Validation d'une demande : elle devient ferme.
 *
 * Le créneau était déjà bloqué depuis le dépôt, la contrainte d'exclusion n'a
 * donc rien à refuser ici — c'est tout l'intérêt d'avoir fait occuper le
 * créneau par le statut `pending`.
 */
export async function confirmBooking(id: string): Promise<void> {
  await withTenant(currentTenantId(), (tx) =>
    tx
      .update(bookings)
      .set({ status: 'confirmed' })
      .where(and(eq(bookings.id, id), eq(bookings.status, 'pending'))),
  )
}

/** Refus d'une demande : une annulation avec motif, qui libère le créneau. */
export async function refuseBooking(id: string, reason?: string | null): Promise<void> {
  await withTenant(currentTenantId(), (tx) =>
    tx
      .update(bookings)
      .set({
        status: 'cancelled',
        cancelledAt: sql`now()`,
        cancellationReason: reason?.trim() || 'Demande refusée',
      })
      .where(and(eq(bookings.id, id), eq(bookings.status, 'pending'))),
  )
}
