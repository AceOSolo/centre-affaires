import { and, asc, eq, gte, inArray, isNull, ne } from 'drizzle-orm'

import { DB_PROPOSAL_REFUSED, DB_UNIQUE_VIOLATION, dbErrorCode } from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clients } from '../clients/schema.ts'
import { dbRefusalMessage } from '../contrats/erreurs.ts'
import { productForResourceType, questionnaires, type Answers } from '../reservations/questionnaires.ts'
import { bookings } from '../reservations/schema.ts'
import { resources } from '../ressources/schema.ts'
import { bookingLineInTransaction, createProposalInTransaction, ProposalRefusedError } from './propositions-queries.ts'
import { proposals, type Proposal, type ProposalProduct } from './schema-devis.ts'

/**
 * Devis établis par l'accueil (ADR 043) : la création depuis le back-office,
 * et les réservations auxquelles un devis peut se rattacher.
 *
 * Un espace ou un véhicule se loue sur un créneau : la base exige la
 * réservation (`proposals_booking_matches_product`). La domiciliation, elle,
 * n'en a pas.
 */

/** Refus métier de la création, avec le message à afficher. */
export class StaffProposalError extends Error {}

export type StaffProposalInput = {
  product: ProposalProduct
  bookingId: string | null
  clientId: string | null
  requesterName: string | null
  requesterEmail: string | null
  requesterPhone: string | null
  requesterCompany: string | null
  answers: Answers
  message: string | null
  staffNote: string | null
  currency: string
  timeZone: string
}

/**
 * Crée le devis en brouillon (canal `staff`, jamais validé à la création :
 * l'accueil le relit). Avec une réservation, sa ligne est son prix figé
 * (`bookingLineInTransaction`), s'il existe.
 */
export async function createStaffProposal(input: StaffProposalInput): Promise<Pick<Proposal, 'id' | 'number'>> {
  const tenantId = currentTenantId()
  const needsBooking = questionnaires[input.product].resourceTypes.length > 0
  if (needsBooking && !input.bookingId) throw new StaffProposalError('Choisissez la réservation du devis.')
  if (!needsBooking && input.bookingId) throw new StaffProposalError('Une domiciliation ne se rattache à aucune réservation.')
  try {
    return await withTenant(tenantId, async (tx) => {
      let currency = input.currency
      let lines: Awaited<ReturnType<typeof bookingLineInTransaction>>[] = []
      if (input.bookingId) {
        // Verrou de la réservation : deux devis lancés en même temps ne se
        // rattachent pas au même créneau (l'index unique le refuserait aussi).
        const [row] = await tx
          .select({
            kind: bookings.kind,
            status: bookings.status,
            quoteCurrency: bookings.quoteCurrency,
            resourceType: resources.resourceType,
          })
          .from(bookings)
          .innerJoin(resources, and(eq(resources.tenantId, bookings.tenantId), eq(resources.id, bookings.resourceId)))
          .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, input.bookingId)))
          .for('update')
        if (!row) throw new StaffProposalError('Cette réservation n’existe plus.')
        if (row.kind !== 'booking') throw new StaffProposalError('Seule une réservation se chiffre en devis.')
        if (row.status === 'cancelled') throw new StaffProposalError('Cette réservation est annulée : elle ne se chiffre plus.')
        if (productForResourceType(row.resourceType) !== input.product) {
          throw new StaffProposalError(`Cette réservation ne porte pas sur : ${questionnaires[input.product].label.toLowerCase()}.`)
        }
        const [existing] = await tx
          .select({ number: proposals.number })
          .from(proposals)
          .where(and(eq(proposals.tenantId, tenantId), eq(proposals.bookingId, input.bookingId)))
        if (existing) throw new StaffProposalError(`Cette réservation a déjà son devis : ${existing.number}.`)
        currency = row.quoteCurrency ?? currency
        lines = [await bookingLineInTransaction(tx, input.bookingId, input.timeZone)]
      }
      const proposal = await createProposalInTransaction(tx, {
        product: input.product,
        channel: 'staff',
        clientId: input.clientId,
        requesterName: input.requesterName,
        requesterEmail: input.requesterEmail,
        requesterPhone: input.requesterPhone,
        requesterCompany: input.requesterCompany,
        bookingId: input.bookingId,
        answers: input.answers,
        message: input.message,
        staffNote: input.staffNote,
        currency,
        lines: lines.filter((line) => line !== undefined),
        validate: false,
      })
      return { id: proposal.id, number: proposal.number }
    })
  } catch (error) {
    if (error instanceof StaffProposalError) throw error
    if (dbErrorCode(error) === DB_UNIQUE_VIOLATION) throw new StaffProposalError('Cette réservation a déjà son devis.')
    const message = dbRefusalMessage(error, [DB_PROPOSAL_REFUSED])
    if (message) throw new ProposalRefusedError(message)
    throw error
  }
}

export type BookingForProposal = {
  id: string
  title: string
  startsAt: Date
  endsAt: Date
  resourceName: string
  clientName: string | null
  requesterName: string | null
}

/**
 * Réservations à venir d'un produit, pas annulées et encore sans devis : celles
 * auxquelles l'accueil peut rattacher un nouveau devis. Les plus proches d'abord.
 */
export async function listBookingsForNewProposal(product: ProposalProduct, from: Date): Promise<BookingForProposal[]> {
  const types = questionnaires[product].resourceTypes
  if (types.length === 0) return []
  const tenantId = currentTenantId()
  return withTenant(tenantId, (tx) =>
    tx
      .select({
        id: bookings.id,
        title: bookings.title,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
        resourceName: resources.name,
        clientName: clients.name,
        requesterName: bookings.requesterName,
      })
      .from(bookings)
      .innerJoin(resources, and(eq(resources.tenantId, bookings.tenantId), eq(resources.id, bookings.resourceId)))
      .leftJoin(clients, and(eq(clients.tenantId, bookings.tenantId), eq(clients.id, bookings.clientId)))
      .leftJoin(proposals, and(eq(proposals.tenantId, bookings.tenantId), eq(proposals.bookingId, bookings.id)))
      .where(
        and(
          eq(bookings.tenantId, tenantId),
          eq(bookings.kind, 'booking'),
          ne(bookings.status, 'cancelled'),
          gte(bookings.endsAt, from),
          inArray(resources.resourceType, [...types]),
          isNull(proposals.id),
        ),
      )
      .orderBy(asc(bookings.startsAt))
      .limit(200),
  )
}
