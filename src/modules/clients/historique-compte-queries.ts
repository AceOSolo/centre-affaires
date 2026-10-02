import { and, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm'
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core'

import { wallClockToUtc } from '../../lib/dates.ts'
import { contractAmendments, contractDocuments, contracts } from '../contrats/schema.ts'
import { mailItems, mailRequests } from '../courrier/schema.ts'
import { inspections } from '../etats-des-lieux/schema.ts'
import { invoices } from '../facturation/schema-factures.ts'
import { bookings } from '../reservations/schema.ts'
import { resources } from '../ressources/schema.ts'
import { inClientSpace, type ClientAccount } from './comptes.ts'
import type {
  AccountHistorySources,
  HistoryBookingRow,
  HistoryCategory,
  HistoryContractDocumentRow,
  HistoryInspectionRow,
  HistoryInvoiceRow,
  HistoryMailRequestRow,
} from './historique-compte.ts'
import { clientMembers, clients } from './schema.ts'

/**
 * Lecture de l'historique du compte (R24), sous la portée client (ADR 019) :
 * les entreprises du compte, et elles seules, filtrées en plus par
 * `client_id`. Aucune ligne n'est écartée parce qu'elle a été annulée ou
 * refusée : c'est précisément ce que l'historique retrace.
 *
 * L'historique se lit par année du centre : chaque année reste accessible,
 * rien n'est caché derrière une limite. La limite par rubrique ne protège que
 * d'un volume anormal, et la page le dit si elle est atteinte.
 */

/** Au-delà, la page le signale : une année n'en compte normalement pas autant. */
export const HISTORY_SOURCE_LIMIT = 500

/** Bornes `[)` d'une année civile du centre, en instants. */
function yearRange(year: number, timeZone: string): { from: Date; to: Date } {
  return {
    from: wallClockToUtc(`${year}-01-01T00:00`, timeZone),
    to: wallClockToUtc(`${year + 1}-01-01T00:00`, timeZone),
  }
}

const memberName = (member: { fullName: AnyPgColumn; email: AnyPgColumn }) =>
  sql<string | null>`coalesce(${member.fullName}, ${member.email})`

export async function loadAccountHistory(
  accounts: readonly ClientAccount[],
  options: { year: number; timeZone: string; category?: HistoryCategory },
): Promise<{ sources: AccountHistorySources; truncated: boolean }> {
  const empty: AccountHistorySources = {
    bookings: [],
    mailRequests: [],
    contractDocuments: [],
    invoices: [],
    inspections: [],
  }
  if (accounts.length === 0) return { sources: empty, truncated: false }
  const clientIds = accounts.map((account) => account.clientId)
  const { from, to } = yearRange(options.year, options.timeZone)
  const wants = (category: HistoryCategory) => !options.category || options.category === category

  return inClientSpace(accounts, async (tx) => {
    let bookingRows: HistoryBookingRow[] = []
    if (wants('reservations')) {
      const bookedBy = alias(clientMembers, 'booked_by')
      const cancelledBy = alias(clientMembers, 'cancelled_by')
      bookingRows = await tx
        .select({
          id: bookings.id,
          clientId: clients.id,
          clientName: clients.name,
          resourceName: resources.name,
          title: bookings.title,
          status: bookings.status,
          channel: bookings.channel,
          createdAt: bookings.createdAt,
          startsAt: bookings.startsAt,
          endsAt: bookings.endsAt,
          bookedByName: memberName(bookedBy),
          cancelledAt: bookings.cancelledAt,
          cancellationReason: bookings.cancellationReason,
          cancelledByMemberName: memberName(cancelledBy),
          cancelledByStaff: sql<boolean>`${bookings.cancelledByStaffId} is not null`,
        })
        .from(bookings)
        .innerJoin(clients, eq(clients.id, bookings.clientId))
        .innerJoin(resources, eq(resources.id, bookings.resourceId))
        .leftJoin(bookedBy, eq(bookedBy.id, bookings.bookedByMemberId))
        .leftJoin(cancelledBy, eq(cancelledBy.id, bookings.cancelledByMemberId))
        .where(
          and(
            inArray(bookings.clientId, clientIds),
            // Les occupations de contrat portent aussi le client : le contrat
            // les dit déjà (ADR 018).
            eq(bookings.kind, 'booking'),
            gte(bookings.createdAt, from),
            lt(bookings.createdAt, to),
          ),
        )
        .orderBy(desc(bookings.createdAt))
        .limit(HISTORY_SOURCE_LIMIT + 1)
    }

    let mailRequestRows: HistoryMailRequestRow[] = []
    if (wants('courrier')) {
      const requestedBy = alias(clientMembers, 'requested_by')
      const cancelledBy = alias(clientMembers, 'request_cancelled_by')
      mailRequestRows = await tx
        .select({
          id: mailRequests.id,
          clientId: clients.id,
          clientName: clients.name,
          kind: mailRequests.kind,
          status: mailRequests.status,
          mailKind: mailItems.kind,
          // Un pli retiré n'était peut-être pas à l'entreprise : son expéditeur
          // ne remonte plus.
          sender: sql<string | null>`case when ${mailItems.deletedAt} is null then ${mailItems.sender} end`,
          mailItemRemoved: sql<boolean>`${mailItems.deletedAt} is not null`,
          receivedAt: mailItems.receivedAt,
          requestedAt: mailRequests.requestedAt,
          requestedByMemberName: memberName(requestedBy),
          startedAt: mailRequests.startedAt,
          completedAt: mailRequests.completedAt,
          refusedAt: mailRequests.refusedAt,
          refusalReason: mailRequests.refusalReason,
          cancelledAt: mailRequests.cancelledAt,
          cancelledByMemberName: memberName(cancelledBy),
          cancelledByStaff: sql<boolean>`${mailRequests.cancelledByStaffId} is not null`,
          forwardTrackingNumber: mailRequests.forwardTrackingNumber,
        })
        .from(mailRequests)
        .innerJoin(mailItems, eq(mailItems.id, mailRequests.mailItemId))
        .innerJoin(clients, eq(clients.id, mailRequests.clientId))
        .leftJoin(requestedBy, eq(requestedBy.id, mailRequests.requestedByMemberId))
        .leftJoin(cancelledBy, eq(cancelledBy.id, mailRequests.cancelledByMemberId))
        .where(
          and(
            inArray(mailRequests.clientId, clientIds),
            gte(mailRequests.requestedAt, from),
            lt(mailRequests.requestedAt, to),
          ),
        )
        .orderBy(desc(mailRequests.requestedAt))
        .limit(HISTORY_SOURCE_LIMIT + 1)
    }

    let documentRows: HistoryContractDocumentRow[] = []
    if (wants('contrats')) {
      documentRows = await tx
        .select({
          contractId: contracts.id,
          clientId: clients.id,
          clientName: clients.name,
          reference: contracts.reference,
          version: contractDocuments.version,
          amendmentNumber: contractAmendments.number,
          createdAt: contractDocuments.createdAt,
        })
        .from(contractDocuments)
        .innerJoin(contracts, eq(contracts.id, contractDocuments.contractId))
        .innerJoin(clients, eq(clients.id, contracts.clientId))
        .leftJoin(contractAmendments, eq(contractAmendments.id, contractDocuments.amendmentId))
        .where(
          and(
            inArray(contracts.clientId, clientIds),
            ne(contracts.status, 'draft'),
            isNull(contracts.deletedAt),
            gte(contractDocuments.createdAt, from),
            lt(contractDocuments.createdAt, to),
          ),
        )
        .orderBy(desc(contractDocuments.createdAt))
        .limit(HISTORY_SOURCE_LIMIT + 1)
    }

    let invoiceRows: HistoryInvoiceRow[] = []
    if (wants('factures')) {
      const issuedAt = sql<Date>`coalesce(${invoices.issuedAt}, ${invoices.createdAt})`.mapWith(
        invoices.issuedAt,
      )
      invoiceRows = await tx
        .select({
          id: invoices.id,
          kind: invoices.kind,
          number: invoices.number,
          status: invoices.status,
          clientId: invoices.clientId,
          clientName: clients.name,
          currency: invoices.currency,
          totalInclTaxCents: invoices.totalInclTaxCents,
          paidCents: invoices.paidCents,
          creditedCents: invoices.creditedCents,
          dueDate: invoices.dueDate,
          issuedAt,
        })
        .from(invoices)
        .innerJoin(clients, eq(clients.id, invoices.clientId))
        .where(
          and(
            inArray(invoices.clientId, clientIds),
            ne(invoices.status, 'draft'),
            isNull(invoices.deletedAt),
            sql`coalesce(${invoices.issuedAt}, ${invoices.createdAt}) >= ${from.toISOString()}::timestamptz`,
            sql`coalesce(${invoices.issuedAt}, ${invoices.createdAt}) < ${to.toISOString()}::timestamptz`,
          ),
        )
        .orderBy(desc(issuedAt))
        .limit(HISTORY_SOURCE_LIMIT + 1)
    }

    let inspectionRows: HistoryInspectionRow[] = []
    if (wants('etats-des-lieux')) {
      const signedBy = alias(clientMembers, 'signed_by')
      // Seuls les états clos sont montrés au client (ADR 039) ; la base le
      // garantit aussi sous la portée client. Datés à leur clôture : c'est
      // alors qu'ils entrent dans l'espace.
      const shownAt = sql<Date>`coalesce(${inspections.closedAt}, ${inspections.performedAt})`
      inspectionRows = await tx
        .select({
          id: inspections.id,
          clientId: clients.id,
          clientName: clients.name,
          kind: inspections.kind,
          resourceName: resources.name,
          performedAt: inspections.performedAt,
          closedAt: inspections.closedAt,
          signedAt: inspections.signedAt,
          signedByName: memberName(signedBy),
          hasRemarks: sql<boolean>`coalesce(btrim(${inspections.clientRemarks}), '') <> ''`,
        })
        .from(inspections)
        .innerJoin(clients, eq(clients.id, inspections.clientId))
        .innerJoin(resources, eq(resources.id, inspections.resourceId))
        .leftJoin(signedBy, eq(signedBy.id, inspections.signedByMemberId))
        .where(
          and(
            inArray(inspections.clientId, clientIds),
            eq(inspections.status, 'closed'),
            isNull(inspections.deletedAt),
            sql`${shownAt} >= ${from.toISOString()}::timestamptz`,
            sql`${shownAt} < ${to.toISOString()}::timestamptz`,
          ),
        )
        .orderBy(desc(shownAt))
        .limit(HISTORY_SOURCE_LIMIT + 1)
    }

    const truncated = [bookingRows, mailRequestRows, documentRows, invoiceRows, inspectionRows].some(
      (rows) => rows.length > HISTORY_SOURCE_LIMIT,
    )
    return {
      sources: {
        bookings: bookingRows.slice(0, HISTORY_SOURCE_LIMIT),
        mailRequests: mailRequestRows.slice(0, HISTORY_SOURCE_LIMIT),
        contractDocuments: documentRows.slice(0, HISTORY_SOURCE_LIMIT),
        invoices: invoiceRows.slice(0, HISTORY_SOURCE_LIMIT),
        inspections: inspectionRows.slice(0, HISTORY_SOURCE_LIMIT),
      },
      truncated,
    }
  })
}

/**
 * Premier instant de l'historique du compte, toutes rubriques confondues :
 * la page en tire la liste des années à parcourir. Nul quand rien n'a encore
 * été demandé ni émis.
 */
export async function findAccountHistoryStart(accounts: readonly ClientAccount[]): Promise<Date | null> {
  if (accounts.length === 0) return null
  const ids = sql.join(
    accounts.map((account) => sql`${account.clientId}::uuid`),
    sql`, `,
  )
  const [row] = await inClientSpace(accounts, (tx) =>
    tx.execute<{ first_at: string | null }>(sql`
      select least(
        (select min(b.created_at) from bookings as b
          where b.client_id in (${ids}) and b.kind = 'booking'),
        (select min(r.requested_at) from mail_requests as r
          where r.client_id in (${ids})),
        (select min(d.created_at) from contract_documents as d
           join contracts as k on k.id = d.contract_id
          where k.client_id in (${ids}) and k.status <> 'draft' and k.deleted_at is null),
        (select min(coalesce(i.issued_at, i.created_at)) from invoices as i
          where i.client_id in (${ids}) and i.status <> 'draft' and i.deleted_at is null),
        (select min(coalesce(e.closed_at, e.performed_at)) from inspections as e
          where e.client_id in (${ids}) and e.status = 'closed' and e.deleted_at is null)
      ) as first_at`),
  )
  // `execute` rend les instants en chaînes (ADR 019, pièges du schéma).
  return row?.first_at ? new Date(row.first_at) : null
}
