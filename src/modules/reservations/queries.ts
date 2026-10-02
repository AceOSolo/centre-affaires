import { and, asc, eq, gt, gte, isNull, lt, ne, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import {
  PG_CHECK_VIOLATION,
  PG_CONTRACT_OCCUPATION_LOCKED,
  PG_EXCLUSION_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  pgErrorCode,
} from '../../db/errors.ts'
import { tenants } from '../../db/tenants.ts'
import { dayRangeUtc } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { contracts, type Contract } from '../contrats/schema.ts'
import { NO_BOOKING_QUOTE, bookingQuoteColumns, type QuoteDiscount } from '../facturation/devis.ts'
import { quoteInTransaction, type QuoteRequest } from '../facturation/devis-queries.ts'
import { invoiceLines } from '../facturation/schema-factures.ts'
import { loadOpeningContext } from '../ressources/ouverture-queries.ts'
import { listBookableResources } from '../ressources/queries.ts'
import { resources, type Resource } from '../ressources/schema.ts'
import { isValidRange, occupiesResource, type TimeRange } from './availability.ts'
import { dayAvailability } from './disponibilites.ts'
import {
  BookingContractError,
  bookingClientLock,
  bookingClientLockMessages,
  bookingContractProblem,
  type BookingClientLock,
} from './rattachement.ts'
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

/**
 * Réservations d'une période, pour la vue semaine.
 *
 * Mêmes bornes que la vue jour, étendues du premier au dernier jour : une
 * réservation à cheval sur deux jours doit apparaître dans les deux colonnes,
 * et la géométrie la rogne sur chacune.
 */
export async function listBookingsBetween(
  fromIsoDate: string,
  toIsoDate: string,
  timeZone: string,
): Promise<BookingWithResource[]> {
  const from = dayRangeUtc(fromIsoDate, timeZone)
  const to = dayRangeUtc(toIsoDate, timeZone)
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ booking: bookings, resource: resources })
      .from(bookings)
      .innerJoin(resources, eq(resources.id, bookings.resourceId))
      .where(and(lt(bookings.startsAt, to.endsAt), gt(bookings.endsAt, from.startsAt)))
      .orderBy(asc(bookings.startsAt)),
  )
  return rows.map(({ booking, resource }) => ({ ...booking, resource }))
}

/** Une réservation, sa ressource et le contrat auquel elle se rattache. */
export type BookingDetail = BookingWithResource & {
  contract: Pick<Contract, 'id' | 'reference' | 'status' | 'deletedAt'> | null
}

export async function findBooking(id: string): Promise<BookingDetail | undefined> {
  const [row] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        booking: bookings,
        resource: resources,
        contract: {
          id: contracts.id,
          reference: contracts.reference,
          status: contracts.status,
          deletedAt: contracts.deletedAt,
        },
      })
      .from(bookings)
      .innerJoin(resources, eq(resources.id, bookings.resourceId))
      .leftJoin(contracts, eq(contracts.id, bookings.contractId))
      .where(eq(bookings.id, id))
      .limit(1),
  )
  return row ? { ...row.booking, resource: row.resource, contract: row.contract } : undefined
}

/**
 * Vérifie, dans la transaction qui écrit, que la réservation peut se rattacher
 * à son contrat (R05) : même client, contrat actif, période couverte. La base
 * ne contrôle que l'appartenance au centre (ADR 018).
 */
async function assertBookingContract(
  tx: Transaction,
  contractId: string,
  booking: TimeRange & { clientId: string | null },
): Promise<void> {
  const [contract] = await tx
    .select({
      clientId: contracts.clientId,
      status: contracts.status,
      deletedAt: contracts.deletedAt,
      startsOn: contracts.startsOn,
      endsOn: contracts.endsOn,
      terminatedOn: contracts.terminatedOn,
    })
    .from(contracts)
    .where(eq(contracts.id, contractId))
    .limit(1)
  if (!contract) throw new BookingContractError('introuvable')
  const [tenant] = await tx
    .select({ timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, currentTenantId()))
  const problem = bookingContractProblem(contract, booking, tenant?.timezone ?? 'UTC')
  if (problem) throw new BookingContractError(problem)
}

/**
 * Écriture directe d'une occupation de contrat, refusée par la base (`CA001`,
 * ADR 018) : elle ne se déplace, ne s'annule ni ne se rattache qu'à travers son
 * contrat.
 */
export class ContractOccupationLockedError extends Error {
  constructor() {
    super(
      'Cette occupation suit son contrat : modifiez le contrat (ressource, dates, résiliation ou archivage) pour la changer.',
    )
    this.name = 'ContractOccupationLockedError'
  }
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
  /** Entreprise cliente pour qui la ressource est réservée (ADR 015). */
  clientId?: string | null
  /**
   * Contrat au titre duquel la ressource est réservée (R05) : un contrat actif
   * du même client, qui couvre le créneau. Vérifié avant l'écriture.
   */
  contractId?: string | null
  /**
   * Prix de la réservation (R11). Par défaut, le devis de la grille
   * (`quote()`), figé sur la réservation ; `none` pour une réservation
   * interne, non chiffrée.
   */
  pricing?: BookingPricing
}

/** Comment chiffrer une réservation à l'écriture. */
export type BookingPricing =
  | { mode: 'grid'; discount?: QuoteDiscount | null }
  | { mode: 'none' }

/** Remise refusée par le devis : illisible, ou plus grande que le montant. */
export class QuoteDiscountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuoteDiscountError'
  }
}

/**
 * Colonnes `quote_*` d'une réservation à écrire : le devis de la grille,
 * calculé dans la transaction qui écrit (R11, ADR 023). Un créneau que la
 * grille ne tarife pas est écrit sans devis ; le formulaire l'a annoncé.
 */
async function quoteColumnsFor(
  tx: Transaction,
  request: Omit<QuoteRequest, 'discount'>,
  pricing: BookingPricing = { mode: 'grid' },
) {
  if (pricing.mode === 'none') return NO_BOOKING_QUOTE
  const result = await quoteInTransaction(tx, { ...request, discount: pricing.discount ?? null })
  if (result.ok) return bookingQuoteColumns(result.quote, new Date())
  if (result.reason === 'remise-invalide' || result.reason === 'remise-excessive') {
    throw new QuoteDiscountError(result.message)
  }
  return NO_BOOKING_QUOTE
}

/**
 * Refait le devis d'une réservation déplacée : d'autres heures ou une autre
 * ressource, c'est un autre prix. La remise accordée est gardée ; si elle
 * dépasse désormais le montant, elle tombe. Un prix saisi à la main (sans
 * ligne de grille) n'est pas touché, une réservation non chiffrée non plus,
 * ni une réservation déjà portée sur une facture : la facture a repris son
 * prix, il ne bouge plus.
 */
async function requoteMovedBooking(tx: Transaction, row: Booking): Promise<Booking> {
  if (!row.quotedAt || !row.quoteRatePlanItemId) return row
  const [invoiced] = await tx
    .select({ id: invoiceLines.id })
    .from(invoiceLines)
    .where(
      and(
        eq(invoiceLines.bookingId, row.id),
        isNull(invoiceLines.deletedAt),
        isNull(invoiceLines.releasedAt),
      ),
    )
    .limit(1)
  if (invoiced) return row
  const discount: QuoteDiscount | null = row.quoteDiscountBp
    ? { kind: 'percent', basisPoints: row.quoteDiscountBp }
    : row.quoteDiscountAmountCents
      ? { kind: 'amount', cents: row.quoteDiscountAmountCents }
      : null
  const request = {
    resourceId: row.resourceId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    clientId: row.clientId,
    contractId: row.contractId,
  }
  let result = await quoteInTransaction(tx, { ...request, discount })
  if (!result.ok && result.reason === 'remise-excessive') {
    result = await quoteInTransaction(tx, { ...request, discount: null })
  }
  const [requoted] = await tx
    .update(bookings)
    .set(result.ok ? bookingQuoteColumns(result.quote, new Date()) : NO_BOOKING_QUOTE)
    .where(eq(bookings.id, row.id))
    .returning()
  return requoted
}

/**
 * Réservation saisie par l'équipe dans le back-office.
 *
 * Le devis est calculé et figé dans la même transaction que l'insertion
 * (R11) : la facture le reprendra, même si la grille change ensuite.
 *
 * @throws BookingContractError si le contrat demandé ne peut pas porter cette
 * réservation : autre client, contrat pas en cours, créneau hors période.
 * @throws QuoteDiscountError si la remise demandée est refusée.
 */
export async function createBooking(input: CreateBookingInput): Promise<Booking> {
  if (!isValidRange(input)) throw new InvalidRangeError()

  try {
    const [created] = await withTenant(currentTenantId(), async (tx) => {
      if (input.contractId) {
        await assertBookingContract(tx, input.contractId, {
          clientId: input.clientId ?? null,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
        })
      }
      const quote = await quoteColumnsFor(
        tx,
        {
          resourceId: input.resourceId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          clientId: input.clientId ?? null,
          contractId: input.contractId ?? null,
        },
        input.pricing,
      )
      return tx
        .insert(bookings)
        .values({
          resourceId: input.resourceId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          title: input.title,
          notes: input.notes ?? null,
          clientId: input.clientId ?? null,
          contractId: input.contractId ?? null,
          // Saisie du back-office (R05).
          channel: 'staff',
          ...quote,
        })
        .returning()
    })
    return created
  } catch (error) {
    if (pgErrorCode(error) !== PG_EXCLUSION_VIOLATION) throw error
    // La contrainte a refusé l'écriture ; on relit pour dire au staff quelle
    // réservation occupe le créneau plutôt que « conflit ».
    const conflicts = await withTenant(currentTenantId(), (tx) => selectConflicts(tx, input))
    throw new BookingConflictError(conflicts)
  }
}

/** Déplacement demandé sur une réservation qui ne s'y prête pas. */
export class BookingNotMovableError extends Error {
  constructor() {
    super("Cette réservation n'existe pas ou a été annulée : elle ne peut pas être déplacée.")
    this.name = 'BookingNotMovableError'
  }
}

export type MoveBookingInput = {
  id: string
  resourceId: string
  startsAt: Date
  endsAt: Date
}

/**
 * Déplacement d'une réservation : d'autres heures, une autre ressource, ou les
 * deux. L'objet et les notes ne bougent pas — les changer relève d'une autre
 * intention que « la salle était trop petite ».
 *
 * Une réservation annulée ne se déplace pas : son créneau est libéré et sa
 * ligne ne subsiste que pour l'historique (décision 6). La ressusciter en la
 * déplaçant ferait réapparaître un créneau que la contrainte croyait libre.
 *
 * Le conflit s'évalue en excluant la réservation elle-même : sans cela, la
 * reculer d'un quart d'heure la ferait entrer en conflit avec sa propre place.
 *
 * Une occupation de contrat ne se déplace pas ici : elle suit son contrat
 * (ADR 018). Une réservation rattachée à un contrat ne peut pas sortir de sa
 * période (R05) : la règle est revérifiée dans la transaction du déplacement.
 */
export async function moveBooking(input: MoveBookingInput): Promise<Booking> {
  if (!isValidRange(input)) throw new InvalidRangeError()

  try {
    const moved = await withTenant(currentTenantId(), async (tx) => {
      const [row] = await tx
        .update(bookings)
        .set({
          resourceId: input.resourceId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
        })
        .where(
          and(
            eq(bookings.id, input.id),
            ne(bookings.status, 'cancelled'),
            ne(bookings.kind, 'contract'),
          ),
        )
        .returning()
      if (!row) {
        const [occupation] = await tx
          .select({ id: bookings.id })
          .from(bookings)
          .where(and(eq(bookings.id, input.id), eq(bookings.kind, 'contract')))
        throw occupation ? new ContractOccupationLockedError() : new BookingNotMovableError()
      }
      if (row.contractId) await assertBookingContract(tx, row.contractId, row)
      return requoteMovedBooking(tx, row)
    })
    return moved
  } catch (error) {
    if (pgErrorCode(error) === PG_CONTRACT_OCCUPATION_LOCKED) {
      throw new ContractOccupationLockedError()
    }
    if (pgErrorCode(error) !== PG_EXCLUSION_VIOLATION) throw error
    const conflicts = await withTenant(currentTenantId(), (tx) =>
      selectConflicts(tx, input, input.id),
    )
    throw new BookingConflictError(conflicts)
  }
}

/**
 * Annulation : la ligne est conservée, le créneau est libéré. `cancelled_at` est
 * posé dans le même ordre que la contrainte `bookings_cancelled_at_consistent`
 * l'exige.
 *
 * Une occupation de contrat est laissée intacte : l'annuler libérerait un
 * bureau toujours loué (ADR 018). Elle s'annule en archivant ou en résiliant
 * son contrat.
 *
 * `staffId` : le membre de l'équipe qui annule (`cancelled_by_staff_id`,
 * ADR 036), que l'espace client dit « annulée par le centre ».
 */
export async function cancelBooking(
  id: string,
  reason?: string | null,
  staffId?: string | null,
): Promise<void> {
  await withTenant(currentTenantId(), (tx) =>
    tx
      .update(bookings)
      .set({
        status: 'cancelled',
        cancelledAt: sql`now()`,
        cancellationReason: reason?.trim() || null,
        cancelledByStaffId: staffId ?? null,
      })
      .where(
        and(
          eq(bookings.id, id),
          ne(bookings.status, 'cancelled'),
          ne(bookings.kind, 'contract'),
        ),
      ),
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

  // Les annulées libèrent leur créneau ; les `pending` l'occupent, une demande
  // en attente ne doit pas être proposée deux fois (ADR 005). Le calcul est
  // celui de l'espace client (`disponibilites.ts`).
  const busy = bookings.filter((booking) => occupiesResource(booking.status))
  return dayAvailability(isoDate, timeZone, bookable, busy, opening)
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
    const [created] = await withTenant(currentTenantId(), async (tx) => {
      // Le montant affiché au demandeur est figé sur sa demande (R11) : celui
      // que l'équipe validera et que la facture reprendra.
      const quote = await quoteColumnsFor(
        tx,
        {
          resourceId: input.resourceId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          clientId: input.clientId ?? null,
        },
        input.pricing,
      )
      return tx
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
          clientId: input.clientId ?? null,
          // Rattachée à son entreprise, la demande vient d'une personne
          // connectée à son espace (ADR 015) ; sinon d'un visiteur (ADR 005).
          channel: input.clientId ? 'client' : 'public',
          ...quote,
        })
        .returning()
    })
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
 *
 * La base date la confirmation (`confirmed_at`, ADR 041) ; le code dit qui
 * l'a donnée, pour l'historique du client et la fiche.
 */
export async function confirmBooking(id: string, staffId: string | null = null): Promise<void> {
  await withTenant(currentTenantId(), (tx) =>
    tx
      .update(bookings)
      .set({ status: 'confirmed', confirmedByStaffId: staffId })
      .where(and(eq(bookings.id, id), eq(bookings.status, 'pending'))),
  )
}

/**
 * Refus d'une demande : une annulation avec motif, qui libère le créneau,
 * tracée au nom du membre de l'équipe qui refuse (ADR 036).
 */
export async function refuseBooking(
  id: string,
  reason?: string | null,
  staffId?: string | null,
): Promise<void> {
  await withTenant(currentTenantId(), (tx) =>
    tx
      .update(bookings)
      .set({
        status: 'cancelled',
        cancelledAt: sql`now()`,
        cancellationReason: reason?.trim() || 'Demande refusée',
        cancelledByStaffId: staffId ?? null,
      })
      .where(and(eq(bookings.id, id), eq(bookings.status, 'pending'))),
  )
}

/** Ce que la base sait du client d'une réservation : son auteur, ses états des lieux, sa facture. */
function bookingClientFacts(tx: Transaction, id: string) {
  return tx
    .select({
      clientId: bookings.clientId,
      bookedByMemberId: bookings.bookedByMemberId,
      cancelledByMemberId: bookings.cancelledByMemberId,
      inspected: sql<boolean>`exists (
        select 1 from inspections as x
         where x.tenant_id = ${bookings.tenantId} and x.booking_id = ${bookings.id})`,
      invoiced: sql<boolean>`exists (
        select 1 from invoice_lines as l
         where l.tenant_id = ${bookings.tenantId} and l.booking_id = ${bookings.id}
           and l.deleted_at is null and l.released_at is null)`,
    })
    .from(bookings)
    .where(and(eq(bookings.id, id), ne(bookings.kind, 'contract')))
    .limit(1)
}

/**
 * Pourquoi le client d'une réservation ne peut plus changer (réservée depuis
 * l'espace client, état des lieux, facture), ou `undefined`. La fiche s'en
 * sert pour ne pas proposer un rattachement que la base refuserait.
 */
export async function findBookingClientLock(id: string): Promise<BookingClientLock | undefined> {
  const [facts] = await withTenant(currentTenantId(), (tx) => bookingClientFacts(tx, id))
  return facts ? bookingClientLock(facts) : undefined
}

export type AssignBookingClientOutcome = { ok: true } | { ok: false; message: string }

/**
 * Rattache une réservation à une entreprise cliente, ou l'en détache (ADR 015).
 * Elle apparaît alors — ou disparaît — dans l'espace de ce client.
 *
 * Le contrat suit le client (R05) : changer de client détache la réservation
 * du contrat de l'ancien, qui ne la couvre plus. Une occupation de contrat
 * n'est jamais touchée : son client est celui de son contrat (ADR 018).
 *
 * Refusé, avec sa raison, quand le client est figé (`bookingClientLock`) ;
 * un refus de la base qui passerait quand même (clé étrangère, contrainte)
 * est rendu en phrase, jamais en page d'erreur.
 */
export async function assignBookingClient(id: string, clientId: string | null): Promise<AssignBookingClientOutcome> {
  try {
    return await withTenant(currentTenantId(), async (tx) => {
      const [facts] = await bookingClientFacts(tx, id).for('update', { of: bookings })
      if (!facts) return { ok: false, message: 'Réservation introuvable.' }
      if (facts.clientId === clientId) return { ok: true }
      const lock = bookingClientLock(facts)
      if (lock) return { ok: false, message: bookingClientLockMessages[lock] }
      await tx
        .update(bookings)
        .set({
          clientId,
          // Les expressions de `SET` lisent l'ancienne ligne : le contrat n'est
          // gardé que si le client ne change pas.
          contractId: sql`case when ${bookings.clientId} is not distinct from ${clientId}::uuid then ${bookings.contractId} end`,
        })
        .where(and(eq(bookings.id, id), ne(bookings.kind, 'contract')))
      return { ok: true }
    })
  } catch (error) {
    const code = pgErrorCode(error)
    if (code === PG_FOREIGN_KEY_VIOLATION) {
      return {
        ok: false,
        message: 'Ce client ne peut pas être rattaché : la réservation est liée à des éléments de son client actuel. Rien n’a été modifié.',
      }
    }
    if (code === PG_CHECK_VIOLATION) {
      return {
        ok: false,
        message: 'Cette réservation ne peut pas rester sans client. Rien n’a été modifié.',
      }
    }
    throw error
  }
}
