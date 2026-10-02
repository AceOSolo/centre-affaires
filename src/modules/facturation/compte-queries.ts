import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { isUuid } from '../../lib/uuid.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import { clients, type Client } from '../clients/schema.ts'
import { invoiceLines, invoices, type Invoice, type InvoiceLine } from './schema-factures.ts'

/**
 * Factures et avoirs vus depuis l'espace client (R17, ADR 019, ADR 026).
 *
 * Jamais un brouillon, jamais la facture d'une autre entreprise. Trois
 * verrous : le filtre sur `client_id`, le filtre `status <> 'draft'` (un
 * brouillon abandonné compris), et la portée client de la transaction : la
 * politique `invoices_client_scope` (migration 0031) écarte d'elle-même les
 * brouillons et les autres clients, même pour une requête sans filtre.
 */

export type ClientInvoiceRow = Pick<
  Invoice,
  | 'id'
  | 'kind'
  | 'number'
  | 'status'
  | 'clientId'
  | 'periodStart'
  | 'periodEnd'
  | 'issueDate'
  | 'dueDate'
  | 'currency'
  | 'totalExclTaxCents'
  | 'totalInclTaxCents'
  | 'paidCents'
  | 'creditedCents'
  | 'expectedPaymentMethod'
  | 'mandateReference'
> & {
  clientName: string
  /** Pour un avoir : le numéro de la facture qu'il corrige. */
  creditedInvoiceNumber: string | null
}

/** Au-delà, la page le dit : l'historique du compte reprend tout, année par année. */
export const CLIENT_INVOICE_LIMIT = 500

/** Factures et avoirs émis des entreprises du compte, du plus récent au plus ancien. */
export async function listInvoicesForAccounts(
  accounts: readonly ClientAccount[],
): Promise<ClientInvoiceRow[]> {
  if (accounts.length === 0) return []
  const clientIds = accounts.map((account) => account.clientId)
  const original = alias(invoices, 'original')

  return inClientSpace(accounts, (tx) =>
    tx
      .select({
        id: invoices.id,
        kind: invoices.kind,
        number: invoices.number,
        status: invoices.status,
        clientId: invoices.clientId,
        periodStart: invoices.periodStart,
        periodEnd: invoices.periodEnd,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        currency: invoices.currency,
        totalExclTaxCents: invoices.totalExclTaxCents,
        totalInclTaxCents: invoices.totalInclTaxCents,
        paidCents: invoices.paidCents,
        creditedCents: invoices.creditedCents,
        expectedPaymentMethod: invoices.expectedPaymentMethod,
        mandateReference: invoices.mandateReference,
        clientName: clients.name,
        creditedInvoiceNumber: original.number,
      })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .leftJoin(original, eq(original.id, invoices.creditedInvoiceId))
      .where(
        and(
          inArray(invoices.clientId, clientIds),
          ne(invoices.status, 'draft'),
          isNull(invoices.deletedAt),
        ),
      )
      .orderBy(desc(invoices.issueDate), desc(invoices.number))
      .limit(CLIENT_INVOICE_LIMIT),
  )
}

export type ClientInvoiceDetail = {
  invoice: Invoice
  client: Client
  lines: InvoiceLine[]
  /** Pour un avoir : la facture qu'il corrige. */
  original: Pick<Invoice, 'number' | 'issueDate'> | null
}

/**
 * Une facture ou un avoir émis d'une entreprise du compte, avec ses lignes,
 * pour la vue imprimable. `undefined` pour un brouillon, une facture d'une
 * autre entreprise ou un identifiant inconnu : même réponse dans tous les cas,
 * pour ne rien révéler de ce qui n'est pas au client.
 */
export async function findInvoiceForAccounts(
  id: string,
  accounts: readonly ClientAccount[],
): Promise<ClientInvoiceDetail | undefined> {
  if (accounts.length === 0 || !isUuid(id)) return undefined
  const clientIds = accounts.map((account) => account.clientId)

  return inClientSpace(accounts, async (tx) => {
    const [head] = await tx
      .select({ invoice: invoices, client: clients })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .where(
        and(
          eq(invoices.id, id),
          inArray(invoices.clientId, clientIds),
          ne(invoices.status, 'draft'),
          isNull(invoices.deletedAt),
        ),
      )
      .limit(1)
    if (!head) return undefined
    const { invoice, client } = head

    const lines = await tx
      .select()
      .from(invoiceLines)
      .where(and(eq(invoiceLines.invoiceId, invoice.id), isNull(invoiceLines.deletedAt)))
      .orderBy(asc(invoiceLines.position), asc(invoiceLines.id))
    const [original] = invoice.creditedInvoiceId
      ? await tx
          .select({ number: invoices.number, issueDate: invoices.issueDate })
          .from(invoices)
          .where(eq(invoices.id, invoice.creditedInvoiceId))
          .limit(1)
      : []

    return { invoice, client, lines, original: original ?? null }
  })
}
