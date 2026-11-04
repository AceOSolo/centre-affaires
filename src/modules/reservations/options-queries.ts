import { and, asc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm'

import { maintenant } from '../../db/columns.ts'
import { tenantContext } from '../../db/contexte.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { DB_EXCLUSION_VIOLATION, DB_OPTION_REFUSED, dbErrorCode, dbSignalMessage } from '../../db/errors.ts'
import { insertReturning } from '../../db/returning.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import {
  NO_BOOKING_QUOTE,
  bookingQuoteColumns,
  frozenQuoteDisplay,
  toQuoteDisplay,
  type QuoteDisplay,
} from '../facturation/devis.ts'
import { quoteInTransaction } from '../facturation/devis-queries.ts'
import { lineFromBooking, type LineDraft } from '../facturation/propositions.ts'
import { proposalLines, proposals } from '../facturation/schema-devis.ts'
import { resources, type Resource } from '../ressources/schema.ts'
import { listBusyRanges } from './creneaux-occupes.ts'
import { EQUIPMENT_TYPE, optionRefusal, optionRefusalMessages, parseEquipmentIds } from './options.ts'
import { BookingConflictError } from './queries.ts'
import { bookings, type Booking } from './schema.ts'

/**
 * Matériel en option d'une réservation (ADR 062) : lectures et écritures.
 *
 * Une option est une ligne de `bookings` liée à la principale
 * (`parent_booking_id`) : le trigger anti-chevauchement la garde (décision 3)
 * et la base tient ses règles (`CA018`). Ce module dit quels appareils sont
 * libres — une annonce, jamais une autorisation —, écrit les options et
 * reporte leur prix au devis de la principale. Toute lecture filtre
 * `tenant_id` (décision 1).
 */

/** Option refusée : par la règle (`optionRefusal`) ou par la base (`CA018`). */
export class OptionRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OptionRefusedError'
  }
}

/** Le centre de la transaction en cours, espace client compris. */
function contextTenantId(): string {
  return tenantContext.getStore() ?? currentTenantId()
}

/** Un appareil proposé en option, et ce qu'il coûterait sur la période. */
export type EquipmentChoice = Pick<Resource, 'id' | 'code' | 'name' | 'description' | 'attributes'> & {
  /** Nul : la grille ne le chiffre pas sur cette période, l'accueil précisera. */
  quote: QuoteDisplay | null
}

/**
 * Appareils libres sur la période : en service, non archivés, sans
 * réservation vivante qui la chevauche (bornes `[)`). Depuis l'espace client,
 * ceux qui ne s'y réservent pas (`closed`) sont écartés, et les réservations
 * des autres ne se lisent que par leurs heures (`listBusyRanges`). Chaque
 * appareil est chiffré par `quote()`, le calcul qui le figera.
 */
export async function listFreeEquipmentInTransaction(
  tx: Transaction,
  request: { startsAt: Date; endsAt: Date; clientId: string | null; portal?: boolean },
): Promise<EquipmentChoice[]> {
  const devices = await tx
    .select({
      id: resources.id,
      code: resources.code,
      name: resources.name,
      description: resources.description,
      attributes: resources.attributes,
    })
    .from(resources)
    .where(
      and(
        eq(resources.tenantId, contextTenantId()),
        eq(resources.resourceType, EQUIPMENT_TYPE),
        eq(resources.status, 'active'),
        isNull(resources.deletedAt),
        request.portal ? ne(resources.clientBookingMode, 'closed') : undefined,
      ),
    )
    .orderBy(asc(resources.name), asc(resources.code))
  if (devices.length === 0) return []
  const busy = new Set(
    (await listBusyRanges(tx, request.startsAt, request.endsAt, devices.map((device) => device.id))).map(
      (range) => range.resourceId,
    ),
  )
  const free = devices.filter((device) => !busy.has(device.id))
  const choices: EquipmentChoice[] = []
  for (const device of free) {
    const result = await quoteInTransaction(tx, {
      resourceId: device.id,
      startsAt: request.startsAt,
      endsAt: request.endsAt,
      clientId: request.clientId,
    })
    choices.push({ ...device, quote: result.ok ? toQuoteDisplay(result.quote) : null })
  }
  return choices
}

/** Les appareils libres sur la période d'une réservation, pour le back-office. */
export function listFreeEquipment(request: { startsAt: Date; endsAt: Date; clientId: string | null }) {
  return withTenant(currentTenantId(), (tx) => listFreeEquipmentInTransaction(tx, request))
}

/** Une option, telle que la fiche de la réservation principale la montre. */
export type BookingOption = Pick<
  Booking,
  'id' | 'status' | 'startsAt' | 'endsAt' | 'resourceId' | 'parentBookingId' | 'cancellationReason'
> & {
  resource: Pick<Resource, 'id' | 'code' | 'name' | 'attributes'>
  quote: QuoteDisplay | undefined
}

/** Les options de réservations données, annulées comprises, par appareil. */
export async function listOptionsOf(parentIds: readonly string[]): Promise<BookingOption[]> {
  if (parentIds.length === 0) return []
  const tenantId = currentTenantId()
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({
        booking: bookings,
        resource: { id: resources.id, code: resources.code, name: resources.name, attributes: resources.attributes },
      })
      .from(bookings)
      .innerJoin(resources, and(eq(resources.tenantId, bookings.tenantId), eq(resources.id, bookings.resourceId)))
      .where(and(eq(bookings.tenantId, tenantId), inArray(bookings.parentBookingId, [...parentIds])))
      .orderBy(sql`${bookings.status} = 'cancelled'`, asc(resources.name)),
  )
  return rows.map(({ booking, resource }) => ({
    id: booking.id,
    status: booking.status,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    resourceId: booking.resourceId,
    parentBookingId: booking.parentBookingId,
    cancellationReason: booking.cancellationReason,
    resource,
    quote: frozenQuoteDisplay(booking),
  }))
}

/** Qui ajoute le matériel : l'équipe, ou une personne de l'entreprise depuis son espace. */
export type OptionAuthor = { channel: 'staff' } | { channel: 'client'; memberId: string }

/**
 * Écrit les options d'une réservation, dans la transaction de l'appelant :
 * chaque appareil prend la période, le client et l'objet de la principale, et
 * son devis figé (R11). Le statut suit la principale — la base ramène à
 * `pending` l'option d'une demande en attente ; depuis l'espace client, elle
 * le pose selon le réglage de l'appareil (ADR 036).
 */
export async function insertOptionsInTransaction(
  tx: Transaction,
  parent: Pick<Booking, 'id' | 'startsAt' | 'endsAt' | 'clientId' | 'title' | 'status'>,
  resourceIds: readonly string[],
  author: OptionAuthor,
): Promise<Booking[]> {
  const created: Booking[] = []
  for (const resourceId of parseEquipmentIds(resourceIds)) {
    const quote = await quoteInTransaction(tx, {
      resourceId,
      startsAt: parent.startsAt,
      endsAt: parent.endsAt,
      clientId: parent.clientId,
    })
    created.push(
      await insertReturning(tx, bookings, {
        resourceId,
        parentBookingId: parent.id,
        startsAt: parent.startsAt,
        endsAt: parent.endsAt,
        title: parent.title,
        clientId: parent.clientId,
        kind: 'booking',
        channel: author.channel,
        bookedByMemberId: author.channel === 'client' ? author.memberId : null,
        status: parent.status === 'confirmed' ? 'confirmed' : 'pending',
        ...(quote.ok ? bookingQuoteColumns(quote.quote, new Date()) : NO_BOOKING_QUOTE),
      }),
    )
  }
  return created
}

/** Lignes de devis des options vivantes d'une réservation : leur prix figé, tel quel. */
export async function optionLinesInTransaction(
  tx: Transaction,
  parentId: string,
  timeZone: string,
): Promise<LineDraft[]> {
  const rows = await tx
    .select({ booking: bookings, resource: { id: resources.id, name: resources.name } })
    .from(bookings)
    .innerJoin(resources, and(eq(resources.tenantId, bookings.tenantId), eq(resources.id, bookings.resourceId)))
    .where(
      and(
        eq(bookings.tenantId, contextTenantId()),
        eq(bookings.parentBookingId, parentId),
        ne(bookings.status, 'cancelled'),
      ),
    )
    .orderBy(asc(resources.name))
  return rows.flatMap(({ booking, resource }) => lineFromBooking({ ...booking, resource }, timeZone) ?? [])
}

/**
 * Ce que devient le devis de la principale quand son matériel change :
 * - `aucun-devis` : la réservation n'en a pas (encore) ;
 * - `a-jour` : il portait déjà ces lignes ;
 * - `mis-a-jour` : lignes ajoutées ou retirées, devis revalidé s'il l'était ;
 * - `transmis` : Dolibarr l'a déjà repris — il ne change plus, l'accueil
 *   l'annule et le refait (ADR 043).
 */
export type OptionLinesOutcome = 'aucun-devis' | 'a-jour' | 'mis-a-jour' | 'transmis'

/**
 * Reporte le matériel au devis de la réservation principale : une ligne par
 * option vivante et chiffrée (source `booking`, repère de l'appareil), la
 * ligne d'un appareil annulé retirée. Un devis prêt repasse brouillon le temps
 * de l'écriture, puis est revalidé au nom du membre de l'équipe : c'est lui
 * qui a changé le matériel. Seulement au centre : depuis l'espace client, le
 * devis naît avec ses lignes (`createPortalBooking`).
 */
export async function syncOptionLinesInTransaction(
  tx: Transaction,
  parent: Pick<Booking, 'id' | 'resourceId'>,
  staffId: string | null,
  timeZone: string,
): Promise<OptionLinesOutcome> {
  const tenantId = contextTenantId()
  const [proposal] = await tx
    .select({ id: proposals.id, status: proposals.status })
    .from(proposals)
    .where(and(eq(proposals.tenantId, tenantId), eq(proposals.bookingId, parent.id), ne(proposals.status, 'cancelled')))
    .for('update')
  if (!proposal) return 'aucun-devis'
  if (proposal.status !== 'draft' && proposal.status !== 'ready') return 'transmis'

  const wanted = await optionLinesInTransaction(tx, parent.id, timeZone)
  const lines = await tx
    .select({ id: proposalLines.id, resourceId: proposalLines.resourceId, position: proposalLines.position, source: proposalLines.source, deletedAt: proposalLines.deletedAt })
    .from(proposalLines)
    .where(and(eq(proposalLines.tenantId, tenantId), eq(proposalLines.proposalId, proposal.id)))
  const live = lines.filter((line) => !line.deletedAt)
  // Les lignes d'options : celles d'une réservation, hors la principale.
  const optionLines = live.filter((line) => line.source === 'booking' && line.resourceId !== parent.resourceId)
  const wantedResources = new Set(wanted.map((line) => line.resourceId))
  const present = new Set(optionLines.map((line) => line.resourceId))
  const toRetire = optionLines.filter((line) => !wantedResources.has(line.resourceId))
  const toAdd = wanted.filter((line) => !present.has(line.resourceId))
  if (toRetire.length === 0 && toAdd.length === 0) return 'a-jour'

  const wasReady = proposal.status === 'ready'
  const byId = and(eq(proposals.tenantId, tenantId), eq(proposals.id, proposal.id))
  if (wasReady) await tx.update(proposals).set({ status: 'draft' }).where(byId)
  if (toRetire.length > 0) {
    await tx
      .update(proposalLines)
      .set({ deletedAt: maintenant() })
      .where(and(eq(proposalLines.tenantId, tenantId), inArray(proposalLines.id, toRetire.map((line) => line.id))))
  }
  let position = Math.max(0, ...lines.map((line) => line.position))
  if (toAdd.length > 0) {
    await tx.insert(proposalLines).values(
      toAdd.map((line) => ({
        proposalId: proposal.id,
        position: ++position,
        source: line.source,
        label: line.label,
        description: line.description,
        unit: line.unit,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        discountBp: line.discountBp,
        discountAmountCents: line.discountAmountCents,
        vatRateBp: line.vatRateBp,
        resourceId: line.resourceId,
        serviceId: line.serviceId,
        ratePlanItemId: line.ratePlanItemId,
      })),
    )
  }
  if (wasReady) await tx.update(proposals).set({ status: 'ready', validatedByStaffId: staffId }).where(byId)
  return 'mis-a-jour'
}

/** Réservations qui occupent déjà les appareils demandés sur la période : pour nommer le conflit. */
async function equipmentConflicts(resourceIds: readonly string[], period: { startsAt: Date; endsAt: Date }) {
  if (resourceIds.length === 0) return []
  const tenantId = currentTenantId()
  return withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, tenantId),
          inArray(bookings.resourceId, [...resourceIds]),
          ne(bookings.status, 'cancelled'),
          lt(bookings.startsAt, period.endsAt),
          gt(bookings.endsAt, period.startsAt),
        ),
      )
      .orderBy(asc(bookings.startsAt)),
  )
}

export type AddOptionsOutcome = { added: Booking[]; proposal: OptionLinesOutcome }

/**
 * « Ajouter du matériel » au back-office : les appareils choisis deviennent
 * des options de la réservation, dans une seule transaction avec leur ligne
 * au devis. Tout ou rien : un appareil pris entre-temps fait tout refuser.
 *
 * @throws OptionRefusedError si la réservation ne reçoit pas de matériel, ou
 * si la base refuse l'option (`CA018`).
 * @throws BookingConflictError si un appareil est déjà pris sur la période
 * (`CA000`, décision 3) ou non restitué (ADR 063).
 */
export async function addOptionsToBooking(
  parentId: string,
  resourceIds: readonly string[],
  staffId: string | null,
  timeZone: string,
): Promise<AddOptionsOutcome> {
  const ids = parseEquipmentIds(resourceIds)
  if (ids.length === 0) throw new OptionRefusedError('Cochez au moins un appareil.')
  const tenantId = currentTenantId()
  let period: { startsAt: Date; endsAt: Date } | undefined
  try {
    return await withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select({ booking: bookings, resourceType: resources.resourceType })
        .from(bookings)
        .innerJoin(resources, and(eq(resources.tenantId, bookings.tenantId), eq(resources.id, bookings.resourceId)))
        .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, parentId)))
        .for('update')
      if (!row) throw new OptionRefusedError('Réservation introuvable.')
      const parent = row.booking
      period = parent
      const refusal = optionRefusal({ ...parent, resource: { resourceType: row.resourceType } })
      if (refusal) throw new OptionRefusedError(optionRefusalMessages[refusal])
      const added = await insertOptionsInTransaction(tx, parent, ids, { channel: 'staff' })
      const proposal = await syncOptionLinesInTransaction(tx, parent, staffId, timeZone)
      return { added, proposal }
    })
  } catch (error) {
    const code = dbErrorCode(error)
    if (code === DB_OPTION_REFUSED) throw new OptionRefusedError(dbSignalMessage(error) ?? 'Matériel refusé.')
    if (code !== DB_EXCLUSION_VIOLATION || !period) throw error
    const conflicts = await equipmentConflicts(ids, period)
    throw new BookingConflictError(conflicts, conflicts.length === 0 ? dbSignalMessage(error) : undefined)
  }
}

/**
 * Le devis suit l'annulation d'une option seule, au back-office : sa ligne
 * est retirée du devis de la principale. À appeler après l'annulation, dans
 * une transaction à part : l'annulation est acquise même si le devis est
 * déjà transmis.
 */
export async function syncOptionLinesAfterCancel(
  optionId: string,
  staffId: string | null,
  timeZone: string,
): Promise<OptionLinesOutcome> {
  const tenantId = currentTenantId()
  return withTenant(tenantId, async (tx) => {
    const [option] = await tx
      .select({ parentBookingId: bookings.parentBookingId })
      .from(bookings)
      .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, optionId)))
    if (!option?.parentBookingId) return 'aucun-devis'
    const [parent] = await tx
      .select({ id: bookings.id, resourceId: bookings.resourceId, status: bookings.status })
      .from(bookings)
      .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, option.parentBookingId)))
    // Principale annulée : son devis l'est aussi (`bookings_cancel_proposal`).
    if (!parent || parent.status === 'cancelled') return 'aucun-devis'
    return syncOptionLinesInTransaction(tx, parent, staffId, timeZone)
  })
}
