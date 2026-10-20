import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { DB_PROPOSAL_REFUSED } from '../../db/errors.ts'
import { insertReturning } from '../../db/returning.ts'
import { staffMembers } from '../../db/staff.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clients } from '../clients/schema.ts'
import { dbRefusalMessage } from '../contrats/erreurs.ts'
import type { Answers } from '../reservations/questionnaires.ts'
import { bookings, type BookingChannel, type BookingStatus } from '../reservations/schema.ts'
import { resources, type ResourceType } from '../ressources/schema.ts'
import {
  lineFromBooking,
  validatesOnCreation,
  type LineDraft,
  type ProposalForDolibarr,
} from './propositions.ts'
import { services } from './schema.ts'
import {
  proposalLines,
  proposals,
  type Proposal,
  type ProposalLine,
  type ProposalProduct,
  type ProposalStatus,
} from './schema-devis.ts'

/**
 * Devis transmis à Dolibarr (ADR 043) : lectures et écritures.
 *
 * La base tient les règles (`src/db/regles/52-devis.sql`, `CA016`) ; ce
 * module les traduit en messages (`ProposalRefusedError`). Toute lecture
 * filtre `tenant_id` (décision 1).
 */

/** Refus d'une règle du devis par la base, avec le message à afficher. */
export class ProposalRefusedError extends Error {}

function refusal(error: unknown): never {
  const message = dbRefusalMessage(error, [DB_PROPOSAL_REFUSED])
  if (message) throw new ProposalRefusedError(message)
  throw error
}

export type NewProposalInput = {
  product: ProposalProduct
  channel: BookingChannel
  clientId?: string | null
  requesterName?: string | null
  requesterEmail?: string | null
  requesterPhone?: string | null
  requesterCompany?: string | null
  bookingId?: string | null
  answers: Answers
  message?: string | null
  staffNote?: string | null
  currency?: string
  lines: readonly LineDraft[]
  /**
   * Validation à la création : par défaut, la règle du produit
   * (`validatesOnCreation`). L'accueil qui crée un devis le relit avant de
   * valider : il passe `false`.
   */
  validate?: boolean
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function lineValues(proposalId: string, line: LineDraft, position: number) {
  return {
    proposalId,
    position,
    source: line.source,
    label: line.label.trim(),
    description: blankToNull(line.description),
    unit: line.unit,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    discountBp: line.discountBp,
    discountAmountCents: line.discountAmountCents,
    vatRateBp: line.vatRateBp,
    resourceId: line.resourceId,
    serviceId: line.serviceId,
    ratePlanItemId: line.ratePlanItemId,
  }
}

/**
 * Crée un devis et ses lignes dans la transaction de l'appelant : la demande
 * (ou la réservation) et son devis s'écrivent ensemble, ou pas du tout.
 *
 * Le numéro vient de `next_document_number('proposal')`, sans trou ni
 * doublon. Le devis naît brouillon (la base l'exige), puis passe « prêt »
 * dans la même transaction si son produit le permet et qu'il est chiffré.
 */
export async function createProposalInTransaction(tx: Transaction, input: NewProposalInput): Promise<Proposal> {
  const [rows] = (await tx.execute(sql`select next_document_number('proposal') as number`)) as unknown as [
    { number: string }[],
  ]
  const proposal = await insertReturning(tx, proposals, {
    number: rows[0].number,
    product: input.product,
    channel: input.channel,
    clientId: input.clientId ?? null,
    requesterName: blankToNull(input.requesterName),
    requesterEmail: blankToNull(input.requesterEmail)?.toLowerCase() ?? null,
    requesterPhone: blankToNull(input.requesterPhone),
    requesterCompany: blankToNull(input.requesterCompany),
    bookingId: input.bookingId ?? null,
    answers: input.answers,
    message: blankToNull(input.message),
    staffNote: blankToNull(input.staffNote),
    currency: input.currency ?? 'EUR',
  })
  if (input.lines.length > 0) {
    await tx.insert(proposalLines).values(input.lines.map((line, index) => lineValues(proposal.id, line, index + 1)))
  }
  const validate = input.validate ?? validatesOnCreation(input.product, input.lines.length)
  if (!validate) return proposal
  await tx
    .update(proposals)
    .set({ status: 'ready' })
    .where(and(eq(proposals.tenantId, proposal.tenantId), eq(proposals.id, proposal.id)))
  const [ready] = await tx.select().from(proposals).where(eq(proposals.id, proposal.id))
  return ready
}

/** La ligne d'une réservation, lue dans la transaction : son prix figé, ou rien. */
export async function bookingLineInTransaction(
  tx: Transaction,
  bookingId: string,
  timeZone: string,
): Promise<LineDraft | undefined> {
  const [row] = await tx
    .select({ booking: bookings, resource: { id: resources.id, name: resources.name } })
    .from(bookings)
    .innerJoin(resources, and(eq(resources.tenantId, bookings.tenantId), eq(resources.id, bookings.resourceId)))
    .where(and(eq(bookings.tenantId, currentTenantId()), eq(bookings.id, bookingId)))
  if (!row) return undefined
  return lineFromBooking({ ...row.booking, resource: row.resource }, timeZone)
}

/**
 * Le devis d'une réservation : le vivant (non annulé, un seul par réservation,
 * `proposals_tenant_booking_live_key`), sinon le dernier annulé — la fiche
 * propose alors de le refaire (ADR 043).
 */
export async function findProposalForBooking(bookingId: string): Promise<Pick<Proposal, 'id' | 'number' | 'status'> | undefined> {
  const tenantId = currentTenantId()
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select({ id: proposals.id, number: proposals.number, status: proposals.status })
      .from(proposals)
      .where(and(eq(proposals.tenantId, tenantId), eq(proposals.bookingId, bookingId)))
      .orderBy(sql`${proposals.status} = 'cancelled'`, desc(proposals.createdAt), desc(proposals.id))
      .limit(1),
  )
  return row
}

// --- Liste et fiche ---------------------------------------------------------

export type ProposalListItem = Pick<
  Proposal,
  'id' | 'number' | 'product' | 'status' | 'channel' | 'requesterName' | 'requesterCompany' | 'requesterEmail' | 'createdAt' | 'currency' | 'bookingId'
> & {
  clientName: string | null
  bookingStartsAt: Date | null
  /** État de la réservation liée : un devis de camion attend avec sa demande. */
  bookingStatus: BookingStatus | null
  resourceName: string | null
  /** Type de la ressource réservée, pour ranger le devis par produit (ADR 048). */
  resourceType: ResourceType | null
  netCents: number
  lineCount: number
}

/**
 * Devis du centre, les plus récents d'abord ; `statuses` vide : tous ;
 * `product` : ceux d'un seul produit (le rayon Domiciliation, ADR 046).
 */
export async function listProposals(
  filters: { statuses?: readonly ProposalStatus[]; product?: ProposalProduct; clientId?: string; limit?: number } = {},
): Promise<ProposalListItem[]> {
  const tenantId = currentTenantId()
  return withTenant(tenantId, async (tx) => {
    const totals = tx
      .select({
        proposalId: proposalLines.proposalId,
        netCents: sql<number>`cast(coalesce(sum(${proposalLines.amountCents}), 0) as signed)`.as('net_cents'),
        lineCount: sql<number>`count(*)`.as('line_count'),
      })
      .from(proposalLines)
      .where(and(eq(proposalLines.tenantId, tenantId), isNull(proposalLines.deletedAt)))
      .groupBy(proposalLines.proposalId)
      .as('totals')
    const rows = await tx
      .select({
        proposal: {
          id: proposals.id,
          number: proposals.number,
          product: proposals.product,
          status: proposals.status,
          channel: proposals.channel,
          requesterName: proposals.requesterName,
          requesterCompany: proposals.requesterCompany,
          requesterEmail: proposals.requesterEmail,
          createdAt: proposals.createdAt,
          currency: proposals.currency,
          bookingId: proposals.bookingId,
        },
        clientName: clients.name,
        bookingStartsAt: bookings.startsAt,
        bookingStatus: bookings.status,
        resourceName: resources.name,
        resourceType: resources.resourceType,
        netCents: totals.netCents,
        lineCount: totals.lineCount,
      })
      .from(proposals)
      .leftJoin(clients, and(eq(clients.tenantId, proposals.tenantId), eq(clients.id, proposals.clientId)))
      .leftJoin(bookings, and(eq(bookings.tenantId, proposals.tenantId), eq(bookings.id, proposals.bookingId)))
      .leftJoin(resources, and(eq(resources.tenantId, bookings.tenantId), eq(resources.id, bookings.resourceId)))
      .leftJoin(totals, eq(totals.proposalId, proposals.id))
      .where(
        and(
          eq(proposals.tenantId, tenantId),
          filters.statuses?.length ? inArray(proposals.status, [...filters.statuses]) : undefined,
          filters.product ? eq(proposals.product, filters.product) : undefined,
          filters.clientId ? eq(proposals.clientId, filters.clientId) : undefined,
        ),
      )
      .orderBy(desc(proposals.createdAt))
      .limit(filters.limit ?? 200)
    return rows.map((row) => ({
      ...row.proposal,
      clientName: row.clientName,
      bookingStartsAt: row.bookingStartsAt,
      bookingStatus: row.bookingStatus,
      resourceName: row.resourceName,
      resourceType: row.resourceType,
      netCents: Number(row.netCents ?? 0),
      lineCount: Number(row.lineCount ?? 0),
    }))
  })
}

export type ProposalDetail = Proposal & {
  client: Pick<typeof clients.$inferSelect, 'id' | 'name' | 'siret' | 'email' | 'phone'> | null
  booking: Pick<typeof bookings.$inferSelect, 'id' | 'startsAt' | 'endsAt' | 'status' | 'quotedAt'> & { resourceName: string } | null
  validatedByName: string | null
  lines: ProposalLine[]
}

export async function findProposal(id: string): Promise<ProposalDetail | undefined> {
  const tenantId = currentTenantId()
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        proposal: proposals,
        client: { id: clients.id, name: clients.name, siret: clients.siret, email: clients.email, phone: clients.phone },
        booking: { id: bookings.id, startsAt: bookings.startsAt, endsAt: bookings.endsAt, status: bookings.status, quotedAt: bookings.quotedAt },
        resourceName: resources.name,
        validatedByName: sql<string | null>`coalesce(${staffMembers.fullName}, ${staffMembers.email})`,
      })
      .from(proposals)
      .leftJoin(clients, and(eq(clients.tenantId, proposals.tenantId), eq(clients.id, proposals.clientId)))
      .leftJoin(bookings, and(eq(bookings.tenantId, proposals.tenantId), eq(bookings.id, proposals.bookingId)))
      .leftJoin(resources, and(eq(resources.tenantId, bookings.tenantId), eq(resources.id, bookings.resourceId)))
      .leftJoin(staffMembers, eq(staffMembers.id, proposals.validatedByStaffId))
      .where(and(eq(proposals.tenantId, tenantId), eq(proposals.id, id)))
    if (!row) return undefined
    const lines = await tx
      .select()
      .from(proposalLines)
      .where(and(eq(proposalLines.tenantId, tenantId), eq(proposalLines.proposalId, id), isNull(proposalLines.deletedAt)))
      .orderBy(asc(proposalLines.position))
    return {
      ...row.proposal,
      client: row.client?.id ? row.client : null,
      booking: row.booking?.id ? { ...row.booking, resourceName: row.resourceName ?? '' } : null,
      validatedByName: row.validatedByName,
      lines,
    }
  })
}

// --- Écritures de l'accueil -------------------------------------------------

async function nextPosition(tx: Transaction, tenantId: string, proposalId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${proposalLines.position})` })
    .from(proposalLines)
    .where(and(eq(proposalLines.tenantId, tenantId), eq(proposalLines.proposalId, proposalId)))
  return Number(row?.max ?? 0) + 1
}

export async function addProposalLine(proposalId: string, line: LineDraft): Promise<void> {
  const tenantId = currentTenantId()
  try {
    await withTenant(tenantId, async (tx) => {
      await tx.insert(proposalLines).values(lineValues(proposalId, line, await nextPosition(tx, tenantId, proposalId)))
    })
  } catch (error) {
    refusal(error)
  }
}

export async function updateProposalLine(
  proposalId: string,
  lineId: string,
  line: Pick<LineDraft, 'label' | 'description' | 'unit' | 'quantity' | 'unitPriceCents' | 'discountBp' | 'discountAmountCents' | 'vatRateBp'>,
): Promise<void> {
  const tenantId = currentTenantId()
  try {
    await withTenant(tenantId, (tx) =>
      tx
        .update(proposalLines)
        .set({
          label: line.label.trim(),
          description: blankToNull(line.description),
          unit: line.unit,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          discountBp: line.discountBp,
          discountAmountCents: line.discountAmountCents,
          vatRateBp: line.vatRateBp,
        })
        .where(
          and(
            eq(proposalLines.tenantId, tenantId),
            eq(proposalLines.proposalId, proposalId),
            eq(proposalLines.id, lineId),
            isNull(proposalLines.deletedAt),
          ),
        ),
    )
  } catch (error) {
    refusal(error)
  }
}

export async function removeProposalLine(proposalId: string, lineId: string): Promise<void> {
  const tenantId = currentTenantId()
  try {
    await withTenant(tenantId, (tx) =>
      tx
        .update(proposalLines)
        .set({ deletedAt: sql`CURRENT_TIMESTAMP(3)` })
        .where(
          and(
            eq(proposalLines.tenantId, tenantId),
            eq(proposalLines.proposalId, proposalId),
            eq(proposalLines.id, lineId),
            isNull(proposalLines.deletedAt),
          ),
        ),
    )
  } catch (error) {
    refusal(error)
  }
}

export async function updateProposalNote(proposalId: string, staffNote: string): Promise<void> {
  const tenantId = currentTenantId()
  try {
    await withTenant(tenantId, (tx) =>
      tx
        .update(proposals)
        .set({ staffNote: blankToNull(staffNote) })
        .where(and(eq(proposals.tenantId, tenantId), eq(proposals.id, proposalId))),
    )
  } catch (error) {
    refusal(error)
  }
}

async function setStatus(
  proposalId: string,
  from: readonly ProposalStatus[],
  values: Partial<Pick<Proposal, 'status' | 'validatedByStaffId' | 'cancellationReason' | 'dolibarrId' | 'dolibarrRef'>>,
): Promise<boolean> {
  const tenantId = currentTenantId()
  try {
    return await withTenant(tenantId, async (tx) => {
      const [result] = (await tx
        .update(proposals)
        .set(values)
        .where(and(eq(proposals.tenantId, tenantId), eq(proposals.id, proposalId), inArray(proposals.status, [...from])))) as unknown as [
        { affectedRows: number },
      ]
      return result.affectedRows > 0
    })
  } catch (error) {
    refusal(error)
  }
}

/** L'accueil valide le devis : il part vers Dolibarr. Faux si le devis n'était plus un brouillon. */
export function validateProposal(proposalId: string, staffId: string): Promise<boolean> {
  return setStatus(proposalId, ['draft'], { status: 'ready', validatedByStaffId: staffId })
}

/** Un devis prêt, pas encore repris par Dolibarr, revient en brouillon. */
export function reopenProposal(proposalId: string): Promise<boolean> {
  return setStatus(proposalId, ['ready'], { status: 'draft' })
}

export function cancelProposal(proposalId: string, reason: string): Promise<boolean> {
  return setStatus(proposalId, ['draft', 'ready', 'sent'], { status: 'cancelled', cancellationReason: blankToNull(reason) })
}

// --- Dolibarr ---------------------------------------------------------------

/**
 * Devis à l'état donné, au format de `toDolibarrProposal` : les devis prêts
 * à reprendre, ou ceux qui ont changé depuis une date (annulations).
 */
export async function listProposalsForDolibarr(filters: {
  status: ProposalStatus
  since?: Date
  limit?: number
}): Promise<ProposalForDolibarr[]> {
  const tenantId = currentTenantId()
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ proposal: proposals, client: clients, booking: bookings, resourceName: resources.name })
      .from(proposals)
      .leftJoin(clients, and(eq(clients.tenantId, proposals.tenantId), eq(clients.id, proposals.clientId)))
      .leftJoin(bookings, and(eq(bookings.tenantId, proposals.tenantId), eq(bookings.id, proposals.bookingId)))
      .leftJoin(resources, and(eq(resources.tenantId, bookings.tenantId), eq(resources.id, bookings.resourceId)))
      .where(
        and(
          eq(proposals.tenantId, tenantId),
          eq(proposals.status, filters.status),
          filters.since ? gte(proposals.updatedAt, filters.since) : undefined,
        ),
      )
      .orderBy(asc(proposals.updatedAt))
      .limit(Math.min(filters.limit ?? 100, 500))
    if (rows.length === 0) return []
    const lines = await tx
      .select()
      .from(proposalLines)
      .where(
        and(
          eq(proposalLines.tenantId, tenantId),
          inArray(proposalLines.proposalId, rows.map((row) => row.proposal.id)),
          isNull(proposalLines.deletedAt),
        ),
      )
      .orderBy(asc(proposalLines.position))
    return rows.map(({ proposal, client, booking, resourceName }) => ({
      ...proposal,
      answers: proposal.answers as Answers,
      client: client
        ? {
            id: client.id,
            name: client.name,
            siret: client.siret,
            vatNumber: client.vatNumber,
            email: client.email,
            phone: client.phone,
            addressLine1: client.addressLine1,
            addressLine2: client.addressLine2,
            postalCode: client.postalCode,
            city: client.city,
            country: client.country,
          }
        : null,
      booking: booking ? { id: booking.id, startsAt: booking.startsAt, endsAt: booking.endsAt, resourceName: resourceName ?? '' } : null,
      lines: lines
        .filter((line) => line.proposalId === proposal.id)
        .map((line) => ({ ...line, amountCents: line.amountCents ?? 0 })),
    }))
  })
}

export type DolibarrUpdateResult = 'ok' | 'introuvable' | 'refuse'

/**
 * Dolibarr a repris le devis : il passe « transmis », avec la référence
 * Dolibarr. Rejouer la même transmission est sans effet (`ok`) : un appel
 * répété après une coupure réseau ne doit pas échouer.
 */
export async function markProposalSent(
  proposalId: string,
  dolibarr: { id: string; ref: string | null },
): Promise<{ result: DolibarrUpdateResult; message?: string }> {
  const tenantId = currentTenantId()
  try {
    return await withTenant(tenantId, async (tx) => {
      const [current] = await tx
        .select({ status: proposals.status, dolibarrId: proposals.dolibarrId })
        .from(proposals)
        .where(and(eq(proposals.tenantId, tenantId), eq(proposals.id, proposalId)))
        .for('update')
      if (!current) return { result: 'introuvable' as const }
      if (current.status !== 'ready') {
        if (current.dolibarrId === dolibarr.id) return { result: 'ok' as const }
        return { result: 'refuse' as const, message: `Ce devis n’est pas prêt (état : ${current.status}).` }
      }
      await tx
        .update(proposals)
        .set({ status: 'sent', dolibarrId: dolibarr.id, dolibarrRef: dolibarr.ref })
        .where(and(eq(proposals.tenantId, tenantId), eq(proposals.id, proposalId)))
      return { result: 'ok' as const }
    })
  } catch (error) {
    const message = dbRefusalMessage(error, [DB_PROPOSAL_REFUSED])
    if (message) return { result: 'refuse', message }
    throw error
  }
}

/** Dolibarr rapporte l'issue : signé ou refusé. Rejouer la même issue est sans effet. */
export async function recordProposalOutcome(
  proposalId: string,
  outcome: 'accepted' | 'refused',
): Promise<{ result: DolibarrUpdateResult; message?: string }> {
  const tenantId = currentTenantId()
  try {
    return await withTenant(tenantId, async (tx) => {
      const [current] = await tx
        .select({ status: proposals.status })
        .from(proposals)
        .where(and(eq(proposals.tenantId, tenantId), eq(proposals.id, proposalId)))
        .for('update')
      if (!current) return { result: 'introuvable' as const }
      if (current.status === outcome) return { result: 'ok' as const }
      if (current.status !== 'sent') {
        return { result: 'refuse' as const, message: `Seul un devis transmis reçoit une issue (état : ${current.status}).` }
      }
      await tx
        .update(proposals)
        .set({ status: outcome })
        .where(and(eq(proposals.tenantId, tenantId), eq(proposals.id, proposalId)))
      return { result: 'ok' as const }
    })
  } catch (error) {
    const message = dbRefusalMessage(error, [DB_PROPOSAL_REFUSED])
    if (message) return { result: 'refuse', message }
    throw error
  }
}

// --- Catalogue pour l'accueil ----------------------------------------------

/** Services vivants et proposés, pour ajouter une ligne au devis. */
export async function listServicesForProposal(): Promise<Pick<typeof services.$inferSelect, 'id' | 'name' | 'unit' | 'unitPriceCents' | 'vatRateBp' | 'description'>[]> {
  const tenantId = currentTenantId()
  return withTenant(tenantId, (tx) =>
    tx
      .select({
        id: services.id,
        name: services.name,
        unit: services.unit,
        unitPriceCents: services.unitPriceCents,
        vatRateBp: services.vatRateBp,
        description: services.description,
      })
      .from(services)
      .where(and(eq(services.tenantId, tenantId), isNull(services.deletedAt), eq(services.isActive, true)))
      .orderBy(asc(services.name)),
  )
}

export async function findServiceForProposal(serviceId: string) {
  const all = await listServicesForProposal()
  return all.find((service) => service.id === serviceId)
}
