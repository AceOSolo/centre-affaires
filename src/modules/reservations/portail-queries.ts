import { and, asc, eq, gte, isNull, lte, ne, sql } from 'drizzle-orm'

import {
  PG_CLIENT_BOOKING_REFUSED,
  PG_EXCLUSION_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  pgErrorCode,
} from '../../db/errors.ts'
import type { Transaction } from '../../db/index.ts'
import { dayRangeUtc } from '../../lib/dates.ts'
import { isUuid } from '../../lib/uuid.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import {
  NO_BOOKING_QUOTE,
  bookingQuoteColumns,
  frozenQuoteDisplay,
  toQuoteDisplay,
  type QuoteDisplay,
} from '../facturation/devis.ts'
import { quoteInTransaction } from '../facturation/devis-queries.ts'
import { guardMessage } from '../facturation/erreurs-base.ts'
import { closures, openingHours, resources, type Resource } from '../ressources/schema.ts'
import { isValidRange } from './availability.ts'
import { dayAvailability, type BusyRange, type DayAvailabilityOf } from './disponibilites.ts'
import {
  isPortalBookable,
  type PortalBookingMode,
  type PortalBookingOutcome,
} from './portail-regles.ts'
import { bookings } from './schema.ts'

/**
 * Réservation depuis l'espace client (R23, ADR 016 décision D4, ADR 036).
 *
 * Tout passe par la portée client (`inClientSpace`, ADR 019) : les
 * ressources, les horaires et la grille se lisent comme sous `withTenant()`
 * (tables sans client), les contrats du client sont les siens, et les
 * réservations des autres ne se lisent que par leurs heures
 * (`booking_busy_ranges()`). Le devis est celui de la vague 2 (`quote()`,
 * ADR 023), calculé dans la transaction qui écrit et figé avec la
 * réservation ; le statut est posé par la base selon le réglage de la
 * ressource.
 */

/** Une ressource proposée dans l'espace client : en service, non archivée, non fermée au portail. */
export type PortalResource = Pick<
  Resource,
  'id' | 'name' | 'resourceType' | 'capacity' | 'description' | 'attributes' | 'photoPath'
> & { clientBookingMode: PortalBookingMode }

export type PortalDayAvailability = DayAvailabilityOf<PortalResource>

async function portalResources(tx: Transaction): Promise<PortalResource[]> {
  const rows = await tx
    .select({
      id: resources.id,
      name: resources.name,
      resourceType: resources.resourceType,
      capacity: resources.capacity,
      description: resources.description,
      attributes: resources.attributes,
      photoPath: resources.photoPath,
      clientBookingMode: resources.clientBookingMode,
    })
    .from(resources)
    .where(
      and(
        eq(resources.status, 'active'),
        isNull(resources.deletedAt),
        ne(resources.clientBookingMode, 'closed'),
      ),
    )
    .orderBy(asc(resources.resourceType), asc(resources.name))
  return rows.flatMap((row) =>
    isPortalBookable(row.clientBookingMode)
      ? [{ ...row, clientBookingMode: row.clientBookingMode }]
      : [],
  )
}

/** Créneaux occupés d'une journée, toutes ressources : leurs heures seulement. */
async function busyRanges(tx: Transaction, isoDate: string, timeZone: string): Promise<BusyRange[]> {
  const day = dayRangeUtc(isoDate, timeZone)
  // Les `timestamptz` d'un `execute` reviennent en chaînes.
  const rows = await tx.execute(sql`
    select resource_id, starts_at, ends_at
      from booking_busy_ranges(${day.startsAt.toISOString()}::timestamptz, ${day.endsAt.toISOString()}::timestamptz)`)
  return rows.map((row) => ({
    resourceId: String(row.resource_id),
    startsAt: new Date(row.starts_at as string),
    endsAt: new Date(row.ends_at as string),
  }))
}

/**
 * Disponibilités d'une journée pour l'espace client : les ressources ouvertes
 * au portail, et leurs plages libres, par le même calcul que la page publique
 * et le back-office (`dayAvailability`).
 */
export async function listPortalDayAvailability(
  accounts: readonly ClientAccount[],
  isoDate: string,
  timeZone: string,
): Promise<PortalDayAvailability[]> {
  if (accounts.length === 0) return []
  return inClientSpace(accounts, async (tx) => {
    const list = await portalResources(tx)
    if (list.length === 0) return []
    const rules = await tx
      .select({
        resourceId: openingHours.resourceId,
        weekday: openingHours.weekday,
        opensAt: openingHours.opensAt,
        closesAt: openingHours.closesAt,
      })
      .from(openingHours)
    const periods = await tx
      .select({ resourceId: closures.resourceId, startsOn: closures.startsOn, endsOn: closures.endsOn })
      .from(closures)
      .where(and(lte(closures.startsOn, isoDate), gte(closures.endsOn, isoDate)))
    const busy = await busyRanges(tx, isoDate, timeZone)
    return dayAvailability(isoDate, timeZone, list, busy, { rules, closures: periods })
  })
}

/** Montant annoncé avant l'envoi, et le réglage de la ressource qui dira la suite. */
export type PortalQuotePreview = {
  mode: PortalBookingMode
  /** Nul : le créneau n'est pas chiffré, l'accueil précisera le montant. */
  quote: QuoteDisplay | null
  /** Le prix vient de la grille du contrat du client. */
  fromContract: boolean
}

/**
 * Devis d'un créneau pour une entreprise du compte, par `quote()` — le calcul
 * qui le figera à l'écriture, sur la grille de son contrat d'abord.
 * `undefined` : ressource qui ne se réserve pas depuis l'espace client.
 */
export async function previewPortalQuote(
  accounts: readonly ClientAccount[],
  request: { clientId: string; resourceId: string; startsAt: Date; endsAt: Date },
): Promise<PortalQuotePreview | undefined> {
  if (!isUuid(request.resourceId) || !accounts.some((account) => account.clientId === request.clientId)) {
    return undefined
  }
  return inClientSpace(accounts, async (tx) => {
    const [resource] = await tx
      .select({ mode: resources.clientBookingMode, status: resources.status, deletedAt: resources.deletedAt })
      .from(resources)
      .where(eq(resources.id, request.resourceId))
      .limit(1)
    if (!resource || resource.status !== 'active' || resource.deletedAt || !isPortalBookable(resource.mode)) {
      return undefined
    }
    const result = await quoteInTransaction(tx, request)
    return {
      mode: resource.mode,
      quote: result.ok ? toQuoteDisplay(result.quote) : null,
      fromContract: result.ok && result.quote.source.kind === 'contract',
    }
  })
}

/** Refus de l'écriture d'une réservation du portail, avec le message à montrer au client. */
export class PortalBookingError extends Error {
  /** `conflit` : créneau pris ; `refus` : ressource fermée ou écriture refusée ; `acces` : personne d'une autre entreprise. */
  readonly reason: 'conflit' | 'refus' | 'acces'

  constructor(reason: 'conflit' | 'refus' | 'acces', message: string) {
    super(message)
    this.name = 'PortalBookingError'
    this.reason = reason
  }
}

export type PortalBookingInput = {
  /** L'entreprise et la personne au nom desquelles on réserve. */
  account: ClientAccount
  /** Toutes les entreprises du compte : la portée de la transaction. */
  accounts: readonly ClientAccount[]
  resourceId: string
  startsAt: Date
  endsAt: Date
  title: string
  notes: string | null
}

export type CreatedPortalBooking = {
  id: string
  /** Le statut posé par la base, et non celui qu'aurait annoncé l'écran. */
  status: PortalBookingOutcome
  /** Le devis figé, ou `undefined` si le créneau n'a pas été chiffré. */
  quote: QuoteDisplay | undefined
}

/**
 * Écrit une réservation du portail, au nom de la personne connectée
 * (`booked_by_member_id`), canal `client`, sous la portée de ses entreprises.
 *
 * Le devis est calculé par `quote()` dans la transaction qui écrit, sur la
 * grille du contrat du client, et figé (R11) ; un créneau que la grille ne
 * chiffre pas est écrit sans devis et attend l'accueil (ADR 036). Le statut
 * écrit ici est ignoré : la base le pose selon le réglage de la ressource, et
 * c'est celui qu'elle rend qui est renvoyé.
 *
 * @throws PortalBookingError pour un créneau pris (23P01), une ressource
 * fermée au portail ou une écriture refusée (CA009), une personne qui n'est
 * plus de l'entreprise (23503).
 */
export async function createPortalBooking(input: PortalBookingInput): Promise<CreatedPortalBooking> {
  if (!isValidRange(input)) {
    throw new PortalBookingError('refus', 'Le créneau doit finir après son début.')
  }
  const { account } = input
  try {
    const created = await inClientSpace(input.accounts, async (tx) => {
      const quote = await quoteInTransaction(tx, {
        resourceId: input.resourceId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        clientId: account.clientId,
      })
      const [row] = await tx
        .insert(bookings)
        .values({
          resourceId: input.resourceId,
          clientId: account.clientId,
          kind: 'booking',
          channel: 'client',
          bookedByMemberId: account.memberId,
          title: input.title,
          notes: input.notes,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          // Ignoré : la base le pose selon le réglage de la ressource (ADR 036).
          status: 'pending',
          ...(quote.ok ? bookingQuoteColumns(quote.quote, new Date()) : NO_BOOKING_QUOTE),
        })
        .returning()
      return row
    })
    return {
      id: created.id,
      status: created.status === 'confirmed' ? 'confirmed' : 'pending',
      quote: frozenQuoteDisplay(created),
    }
  } catch (error) {
    const code = pgErrorCode(error)
    if (code === PG_EXCLUSION_VIOLATION) {
      throw new PortalBookingError(
        'conflit',
        'Ce créneau vient d’être pris. Choisissez-en un autre parmi les créneaux libres.',
      )
    }
    if (code === PG_CLIENT_BOOKING_REFUSED) {
      throw new PortalBookingError(
        'refus',
        guardMessage(error) ?? 'Cette ressource ne se réserve pas depuis l’espace client : contactez le centre.',
      )
    }
    if (code === PG_FOREIGN_KEY_VIOLATION) {
      throw new PortalBookingError(
        'acces',
        'Votre accès à cette entreprise a changé. Reconnectez-vous, puis réessayez.',
      )
    }
    throw error
  }
}
