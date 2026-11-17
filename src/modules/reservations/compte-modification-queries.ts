import { and, eq, gt, inArray, sql } from 'drizzle-orm'

import { maintenant } from '../../db/columns.ts'
import {
  DB_CLIENT_BOOKING_REFUSED,
  DB_CLIENT_CHANGE_REFUSED,
  DB_CLIENT_SCOPE_REFUSED,
  DB_EXCLUSION_VIOLATION,
  DB_INVOICE_LOCKED,
  DB_PROPOSAL_REFUSED,
  dbErrorCode,
} from '../../db/errors.ts'
import { updateReturning } from '../../db/returning.ts'
import { isUuid } from '../../lib/uuid.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import { clients } from '../clients/schema.ts'
import {
  NO_BOOKING_QUOTE,
  bookingQuoteColumns,
  frozenQuoteDisplay,
  type QuotableUnit,
  type QuoteDiscount,
  type QuoteDisplay,
} from '../facturation/devis.ts'
import { quoteInTransaction } from '../facturation/devis-queries.ts'
import { guardMessage } from '../facturation/erreurs-base.ts'
import { bookingLineInTransaction, createProposalInTransaction } from '../facturation/propositions-queries.ts'
import { proposals } from '../facturation/schema-devis.ts'
import { resources, type Resource } from '../ressources/schema.ts'
import type { TimeRange } from './availability.ts'
import { clientChangePolicy } from './compte-queries.ts'
import { clientChangeBlocker, clientChangeBlockerMessage, type ClientChangePolicy } from './compte-regles.ts'
import { isPortalBookable } from './portail-regles.ts'
import { bookings, type Booking } from './schema.ts'

/**
 * Modification d'une demande ou d'une réservation par son client (ADR 076).
 *
 * Tout passe par la portée client (`inClientSpace`, ADR 019) : la réservation
 * doit être celle d'une entreprise du compte. Les nouvelles dates sont
 * chiffrées dans la transaction qui écrit, à l'unité de la formule choisie
 * (`quote()`), et la réservation **repasse en attente** : l'accueil la valide
 * de nouveau. La base garde le délai du centre et le reste
 * (`24-formules-et-modifications.sql`, `CA022`), et le chevauchement
 * (décision 3, `CA000`).
 *
 * Le devis né avec la demande (ADR 043) est annulé par la base
 * (`bookings_client_change_proposal`) et remplacé ici par un devis aux
 * nouvelles dates, dans la même transaction, avec les mêmes réponses.
 */

/** Ce que l'écran de modification sait d'une réservation. */
export type ChangeableBooking = Pick<
  Booking,
  | 'id'
  | 'clientId'
  | 'status'
  | 'startsAt'
  | 'endsAt'
  | 'title'
  | 'parentBookingId'
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
  clientName: string
  optionCount: number
  resource: Pick<Resource, 'id' | 'name' | 'resourceType' | 'attributes' | 'clientBookingMode' | 'status' | 'deletedAt'>
  policy: ClientChangePolicy
}

/** La réservation d'une entreprise du compte, et le délai du centre ; `undefined` : pas la sienne. */
export async function findBookingForChange(
  accounts: readonly ClientAccount[],
  id: string,
): Promise<ChangeableBooking | undefined> {
  if (accounts.length === 0 || !isUuid(id)) return undefined
  const clientIds = accounts.map((account) => account.clientId)
  return inClientSpace(accounts, async (tx) => {
    const [row] = await tx
      .select({
        booking: bookings,
        clientName: clients.name,
        resource: {
          id: resources.id,
          name: resources.name,
          resourceType: resources.resourceType,
          attributes: resources.attributes,
          clientBookingMode: resources.clientBookingMode,
          status: resources.status,
          deletedAt: resources.deletedAt,
        },
        optionCount: sql<number>`(select count(*) from bookings as live_options
           where live_options.tenant_id = ${bookings.tenantId}
             and live_options.parent_booking_id = ${bookings.id}
             and live_options.status <> 'cancelled')`.mapWith(Number),
      })
      .from(bookings)
      .innerJoin(resources, and(eq(resources.tenantId, bookings.tenantId), eq(resources.id, bookings.resourceId)))
      .innerJoin(clients, and(eq(clients.tenantId, bookings.tenantId), eq(clients.id, bookings.clientId)))
      .where(
        and(
          eq(bookings.tenantId, currentTenantId()),
          eq(bookings.id, id),
          inArray(bookings.clientId, clientIds),
          eq(bookings.kind, 'booking'),
        ),
      )
      .limit(1)
    if (!row) return undefined
    const { booking } = row
    return {
      id: booking.id,
      clientId: booking.clientId,
      status: booking.status,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      title: booking.title,
      parentBookingId: booking.parentBookingId,
      quoteUnit: booking.quoteUnit,
      quoteQuantity: booking.quoteQuantity,
      quoteUnitPriceCents: booking.quoteUnitPriceCents,
      quoteDiscountBp: booking.quoteDiscountBp,
      quoteDiscountAmountCents: booking.quoteDiscountAmountCents,
      quoteAmountCents: booking.quoteAmountCents,
      quoteVatRateBp: booking.quoteVatRateBp,
      quoteCurrency: booking.quoteCurrency,
      quotedAt: booking.quotedAt,
      clientName: row.clientName,
      optionCount: row.optionCount,
      resource: row.resource,
      policy: await clientChangePolicy(tx),
    }
  })
}

/**
 * Pourquoi la réservation ne se modifie pas depuis l'espace : le délai, une
 * option à déplacer avec elle, ou un espace que le centre ne propose plus en
 * ligne. `undefined` : elle se modifie.
 */
export function changeRefusal(booking: ChangeableBooking, now: Date): string | undefined {
  const blocker = clientChangeBlocker(booking, now, booking.policy)
  if (blocker) return clientChangeBlockerMessage(blocker, booking.policy)
  if (booking.optionCount > 0) {
    return 'Cette réservation emporte du matériel en option : pour la modifier, contactez l’accueil. Vous pouvez aussi l’annuler, matériel compris.'
  }
  const { resource } = booking
  if (resource.status !== 'active' || resource.deletedAt || !isPortalBookable(resource.clientBookingMode)) {
    return `« ${resource.name} » ne se réserve plus depuis l’espace client : pour modifier cette réservation, contactez l’accueil.`
  }
  return undefined
}

export type ModifyBookingInput = {
  id: string
  accounts: readonly ClientAccount[]
  startsAt: Date
  endsAt: Date
  /** Unité imposée par la formule de location choisie ; absente : la moins chère (ADR 023). */
  unit?: QuotableUnit
  timeZone: string
}

export type ModifyBookingOutcome =
  | { ok: true; previous: TimeRange; wasConfirmed: boolean; memberId: string; quote: QuoteDisplay | undefined }
  | { ok: false; reason: 'conflit' | 'refus'; message: string }

const refused = 'Cette réservation ne peut plus être modifiée d’ici : elle vient peut-être de changer. Contactez le centre.'

export async function modifyBookingForAccounts(input: ModifyBookingInput): Promise<ModifyBookingOutcome> {
  const { accounts } = input
  if (accounts.length === 0 || !isUuid(input.id) || !(input.endsAt > input.startsAt)) {
    return { ok: false, reason: 'refus', message: refused }
  }
  const clientIds = accounts.map((account) => account.clientId)
  try {
    return await inClientSpace(accounts, async (tx): Promise<ModifyBookingOutcome> => {
      const tenantId = currentTenantId()
      const [row] = await tx
        .select()
        .from(bookings)
        .where(
          and(
            eq(bookings.tenantId, tenantId),
            eq(bookings.id, input.id),
            inArray(bookings.clientId, clientIds),
            eq(bookings.kind, 'booking'),
          ),
        )
        .limit(1)
      const account = row && accounts.find((candidate) => candidate.clientId === row.clientId)
      if (!row || !account) return { ok: false, reason: 'refus', message: refused }
      const policy = await clientChangePolicy(tx)
      const blocker = clientChangeBlocker(row, new Date(), policy)
      if (blocker) return { ok: false, reason: 'refus', message: clientChangeBlockerMessage(blocker, policy) }

      // La remise accordée par l'accueil suit la réservation ; si elle dépasse
      // désormais le montant, elle tombe (comme un déplacement par l'équipe).
      const discount: QuoteDiscount | null = row.quoteDiscountBp
        ? { kind: 'percent', basisPoints: row.quoteDiscountBp }
        : row.quoteDiscountAmountCents
          ? { kind: 'amount', cents: row.quoteDiscountAmountCents }
          : null
      const request = {
        resourceId: row.resourceId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        clientId: row.clientId,
        unit: input.unit,
      }
      let quote = await quoteInTransaction(tx, { ...request, discount })
      if (!quote.ok && quote.reason === 'remise-excessive') quote = await quoteInTransaction(tx, { ...request, discount: null })

      // Le devis encore ouvert, que la base annule à la modification.
      const [proposal] = await tx
        .select()
        .from(proposals)
        .where(
          and(
            eq(proposals.tenantId, tenantId),
            eq(proposals.bookingId, input.id),
            inArray(proposals.status, ['draft', 'ready', 'sent']),
          ),
        )
        .limit(1)

      const updated = await updateReturning(
        tx,
        bookings,
        {
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          // Une réservation modifiée par son client attend de nouveau l'accueil.
          status: 'pending',
          ...(quote.ok ? bookingQuoteColumns(quote.quote, new Date()) : NO_BOOKING_QUOTE),
        },
        and(
          eq(bookings.id, input.id),
          inArray(bookings.status, ['pending', 'confirmed']),
          gt(bookings.startsAt, maintenant()),
          inArray(bookings.clientId, clientIds),
        ),
      )
      if (updated.length === 0) return { ok: false, reason: 'refus', message: refused }

      if (proposal) {
        const line = await bookingLineInTransaction(tx, input.id, input.timeZone)
        await createProposalInTransaction(tx, {
          product: proposal.product,
          channel: 'client',
          clientId: row.clientId,
          requesterName: proposal.requesterName,
          requesterEmail: proposal.requesterEmail,
          requesterPhone: proposal.requesterPhone,
          requesterCompany: proposal.requesterCompany,
          bookingId: input.id,
          answers: proposal.answers,
          message: proposal.message,
          currency: updated[0].quoteCurrency ?? proposal.currency,
          lines: line ? [line] : [],
        })
      }

      return {
        ok: true,
        previous: { startsAt: row.startsAt, endsAt: row.endsAt },
        wasConfirmed: row.status === 'confirmed',
        memberId: account.memberId,
        quote: frozenQuoteDisplay(updated[0]),
      }
    })
  } catch (error) {
    const code = dbErrorCode(error)
    if (code === DB_EXCLUSION_VIOLATION) {
      return {
        ok: false,
        reason: 'conflit',
        message: 'Ce créneau est déjà pris : choisissez-en un autre parmi les horaires libres.',
      }
    }
    if (
      code === DB_CLIENT_CHANGE_REFUSED ||
      code === DB_CLIENT_BOOKING_REFUSED ||
      code === DB_CLIENT_SCOPE_REFUSED ||
      code === DB_PROPOSAL_REFUSED ||
      code === DB_INVOICE_LOCKED
    ) {
      return { ok: false, reason: 'refus', message: guardMessage(error) ?? refused }
    }
    throw error
  }
}
