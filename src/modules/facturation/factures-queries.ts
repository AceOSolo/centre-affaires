import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { staffMembers } from '../../db/staff.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clients, type Client } from '../clients/schema.ts'
import { InvoiceRefusedError, isInvoiceRefusal } from './factures-erreurs.ts'
import { monthRange } from './periodes.ts'
import {
  invoiceLines,
  invoiceRuns,
  invoices,
  payments,
  sepaMandates,
  type Invoice,
  type InvoiceKind,
  type InvoiceLine,
  type InvoiceStatus,
  type Payment,
  type VatCategory,
} from './schema-factures.ts'
import type { PaymentMethod } from '../../db/tenants.ts'

/**
 * Factures et avoirs, côté base (R13, R15, ADR 026) : la liste, la fiche, la
 * modification d'un brouillon, l'émission et les avoirs.
 *
 * La base tient les règles — un brouillon seul se modifie, l'émission passe
 * par `issue_invoice()`, une correction par un avoir — et dit ce qui manque.
 * Ce module les appelle et rend ses refus lisibles (`InvoiceRefusedError`).
 */

/** Exécute une écriture et rend un refus de la base en erreur métier. */
async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (isInvoiceRefusal(error)) throw InvoiceRefusedError.from(error)
    throw error
  }
}

/* -------------------------------------------------------------------------- */
/* Lecture                                                                    */
/* -------------------------------------------------------------------------- */

export type InvoiceFilters = {
  status?: InvoiceStatus
  kind?: InvoiceKind
  clientId?: string
  /** Mois ISO : les factures dont la période touche ce mois. */
  month?: string
}

export type InvoiceListRow = Invoice & { clientName: string }

/** Au-delà, la liste demande un filtre : elle n'est pas un export. */
export const INVOICE_LIST_LIMIT = 300

/**
 * Factures et avoirs du centre, brouillons abandonnés exclus. Les brouillons
 * d'abord — c'est le travail en cours —, puis les plus récents.
 */
export async function listInvoices(filters: InvoiceFilters = {}): Promise<InvoiceListRow[]> {
  const month = filters.month ? monthRange(filters.month) : undefined
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ invoice: invoices, clientName: clients.name })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .where(
        and(
          isNull(invoices.deletedAt),
          filters.status ? eq(invoices.status, filters.status) : undefined,
          filters.kind ? eq(invoices.kind, filters.kind) : undefined,
          filters.clientId ? eq(invoices.clientId, filters.clientId) : undefined,
          month ? lte(invoices.periodStart, month.end) : undefined,
          month ? gte(invoices.periodEnd, month.start) : undefined,
        ),
      )
      .orderBy(
        desc(sql`${invoices.status} = 'draft'`),
        sql`${invoices.issueDate} desc nulls first`,
        desc(invoices.number),
        asc(clients.name),
        desc(invoices.createdAt),
      )
      .limit(INVOICE_LIST_LIMIT),
  )
  return rows.map(({ invoice, clientName }) => ({ ...invoice, clientName }))
}

export type InvoiceLineRow = InvoiceLine & {
  /** Pour une ligne d'avoir : la désignation de la ligne créditée. */
  creditedLineDescription: string | null
}

export type PaymentRow = Payment & { recordedByName: string }

export type InvoiceDetail = {
  invoice: Invoice
  client: Client
  lines: InvoiceLineRow[]
  payments: PaymentRow[]
  /** Avoirs établis sur cette facture, brouillons compris. */
  creditNotes: Invoice[]
  /** Pour un avoir : la facture qu'il corrige. */
  original: Invoice | null
  run: { id: string; periodStart: string; periodEnd: string } | null
  issuedByName: string | null
  /** Mandat actif du client, pour proposer le prélèvement. */
  activeMandate: { id: string; reference: string; ibanLast4: string } | null
}

/** Désignation de la ligne qu'une ligne d'avoir crédite. */
const creditedLineDescription = sql<string | null>`(
  select credited.description from invoice_lines as credited
   where credited.tenant_id = invoice_lines.tenant_id and credited.id = invoice_lines.credited_line_id)`

async function loadInvoice(tx: Transaction, id: string): Promise<InvoiceDetail | undefined> {
  const [head] = await tx
    .select({
      invoice: invoices,
      client: clients,
      issuedByName: sql<string | null>`coalesce(${staffMembers.fullName}, ${staffMembers.email})`,
    })
    .from(invoices)
    .innerJoin(clients, eq(clients.id, invoices.clientId))
    .leftJoin(staffMembers, eq(staffMembers.id, invoices.issuedBy))
    .where(eq(invoices.id, id))
    .limit(1)
  if (!head) return undefined
  const { invoice } = head

  const [lineRows, paymentRows, creditNotes, original, run, mandate] = await Promise.all([
    tx
      .select({ line: invoiceLines, creditedLineDescription })
      .from(invoiceLines)
      .where(and(eq(invoiceLines.invoiceId, id), isNull(invoiceLines.deletedAt)))
      .orderBy(asc(invoiceLines.position), asc(invoiceLines.id)),
    tx
      .select({
        payment: payments,
        recordedByName: sql<string>`coalesce(${staffMembers.fullName}, ${staffMembers.email})`,
      })
      .from(payments)
      .innerJoin(staffMembers, eq(staffMembers.id, payments.recordedBy))
      .where(eq(payments.invoiceId, id))
      .orderBy(asc(payments.paidOn), asc(payments.createdAt)),
    tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.creditedInvoiceId, id), isNull(invoices.deletedAt)))
      .orderBy(asc(invoices.createdAt)),
    invoice.creditedInvoiceId
      ? tx.select().from(invoices).where(eq(invoices.id, invoice.creditedInvoiceId)).limit(1)
      : Promise.resolve([]),
    invoice.invoiceRunId
      ? tx
          .select({ id: invoiceRuns.id, periodStart: invoiceRuns.periodStart, periodEnd: invoiceRuns.periodEnd })
          .from(invoiceRuns)
          .where(eq(invoiceRuns.id, invoice.invoiceRunId))
          .limit(1)
      : Promise.resolve([]),
    tx
      .select({ id: sepaMandates.id, reference: sepaMandates.reference, ibanLast4: sepaMandates.ibanLast4 })
      .from(sepaMandates)
      .where(
        and(
          eq(sepaMandates.clientId, invoice.clientId),
          eq(sepaMandates.status, 'active'),
          isNull(sepaMandates.deletedAt),
        ),
      )
      .limit(1),
  ])

  return {
    invoice,
    client: head.client,
    lines: lineRows.map(({ line, creditedLineDescription }) => ({ ...line, creditedLineDescription })),
    payments: paymentRows.map(({ payment, recordedByName }) => ({ ...payment, recordedByName })),
    creditNotes,
    original: original[0] ?? null,
    run: run[0] ?? null,
    issuedByName: head.issuedByName,
    activeMandate: mandate[0] ?? null,
  }
}

export async function findInvoice(id: string): Promise<InvoiceDetail | undefined> {
  return withTenant(currentTenantId(), (tx) => loadInvoice(tx, id))
}

/** Une ligne et sa facture, pour l'écran de modification d'une ligne. */
export async function findInvoiceLine(
  invoiceId: string,
  lineId: string,
): Promise<{ invoice: Invoice; line: InvoiceLineRow } | undefined> {
  const [row] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ invoice: invoices, line: invoiceLines, creditedLineDescription })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(
        and(eq(invoiceLines.id, lineId), eq(invoiceLines.invoiceId, invoiceId), isNull(invoiceLines.deletedAt)),
      )
      .limit(1),
  )
  return row
    ? { invoice: row.invoice, line: { ...row.line, creditedLineDescription: row.creditedLineDescription } }
    : undefined
}

/* -------------------------------------------------------------------------- */
/* Brouillons                                                                 */
/* -------------------------------------------------------------------------- */

/** Le brouillon, verrouillé pour la transaction ; une erreur s'il ne l'est plus. */
async function lockDraft(tx: Transaction, id: string): Promise<Invoice> {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).for('no key update').limit(1)
  if (!invoice) throw new InvoiceRefusedError('Facture introuvable.')
  if (invoice.deletedAt) throw new InvoiceRefusedError('Ce brouillon a été abandonné : il ne se modifie plus.')
  if (invoice.status !== 'draft') {
    throw new InvoiceRefusedError(
      `La facture ${invoice.number} est émise : elle ne se modifie plus. Toute correction passe par un avoir.`,
    )
  }
  return invoice
}

export type DraftInvoiceInput = {
  periodStart: string
  periodEnd: string
  /** Nul : le délai du centre, lu à l'émission. */
  paymentTermsDays: number | null
  expectedPaymentMethod: PaymentMethod
  buyerReference: string | null
  notes: string | null
}

/** Le client n'a pas de mandat actif : le prélèvement n'est pas possible. */
export class NoActiveMandateError extends Error {
  constructor() {
    super('Ce client n’a pas de mandat de prélèvement actif : choisissez un autre mode de paiement.')
    this.name = 'NoActiveMandateError'
  }
}

/**
 * Conditions d'un brouillon : période, délai, mode de paiement, référence de
 * l'acheteur, mentions. En prélèvement, le mandat est celui, actif, du client.
 * Un avoir ne se paie pas : son mode de paiement ne change pas.
 */
export async function updateDraftInvoice(id: string, input: DraftInvoiceInput): Promise<void> {
  await refusing(() =>
    withTenant(currentTenantId(), async (tx) => {
      const invoice = await lockDraft(tx, id)
      let payment: { expectedPaymentMethod: PaymentMethod; sepaMandateId: string | null } = {
        expectedPaymentMethod: invoice.expectedPaymentMethod,
        sepaMandateId: invoice.sepaMandateId,
      }
      if (invoice.kind === 'invoice') {
        if (input.expectedPaymentMethod === 'direct_debit') {
          const [mandate] = await tx
            .select({ id: sepaMandates.id })
            .from(sepaMandates)
            .where(
              and(
                eq(sepaMandates.clientId, invoice.clientId),
                eq(sepaMandates.status, 'active'),
                isNull(sepaMandates.deletedAt),
              ),
            )
            .limit(1)
          if (!mandate) throw new NoActiveMandateError()
          payment = { expectedPaymentMethod: 'direct_debit', sepaMandateId: mandate.id }
        } else {
          payment = { expectedPaymentMethod: input.expectedPaymentMethod, sepaMandateId: null }
        }
      }
      await tx
        .update(invoices)
        .set({
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          paymentTermsDays: invoice.kind === 'invoice' ? input.paymentTermsDays : null,
          ...payment,
          buyerReference: input.buyerReference,
          notes: input.notes,
        })
        .where(eq(invoices.id, id))
    }),
  )
}

export type ManualLineInput = {
  /** Ligne libre ou remise (geste commercial). */
  kind: 'other' | 'discount'
  description: string
  quantity: number
  /** Prix unitaire HT saisi, positif ; une remise est enregistrée en négatif. */
  unitPriceCents: number
  vatRateBp: number
  vatCategory: VatCategory
  vatExemptionReason: string | null
  periodStart: string | null
  periodEnd: string | null
}

/** Ajoute une ligne libre ou une remise en fin de brouillon (facture ou avoir). */
export async function addManualLine(invoiceId: string, input: ManualLineInput): Promise<void> {
  await refusing(() =>
    withTenant(currentTenantId(), async (tx) => {
      await lockDraft(tx, invoiceId)
      const [{ next }] = await tx
        .select({ next: sql<number>`coalesce(max(${invoiceLines.position}), -1) + 1` })
        .from(invoiceLines)
        .where(and(eq(invoiceLines.invoiceId, invoiceId), isNull(invoiceLines.deletedAt)))
      await tx.insert(invoiceLines).values({
        invoiceId,
        position: Number(next),
        kind: input.kind,
        description: input.description,
        quantity: input.quantity,
        unit: 'unit',
        unitPriceCents: input.kind === 'discount' ? -Math.abs(input.unitPriceCents) : input.unitPriceCents,
        vatRateBp: input.vatRateBp,
        vatCategory: input.vatCategory,
        vatExemptionReason: input.vatExemptionReason,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      })
    }),
  )
}

export type LineEditInput = {
  description: string
  quantity: number
  /** Prix unitaire HT, en valeur absolue ; seulement pour une ligne qui le permet. */
  unitPriceCents?: number
  /** Motif d'exonération, pour une ligne sans TVA. */
  vatExemptionReason?: string | null
}

/**
 * Le prix se modifie sur une ligne saisie à la main (libre, remise) et sur une
 * ligne d'avoir — un avoir partiel réduit un montant. Une ligne tirée d'une
 * source (loyer, réservation, forfait, acte) garde le prix de sa source : on
 * la retire, on ne la réécrit pas.
 */
export function linePriceEditable(invoice: Pick<Invoice, 'kind'>, line: Pick<InvoiceLine, 'kind'>): boolean {
  return invoice.kind === 'credit_note' || line.kind === 'other' || line.kind === 'discount'
}

/** Désignation et quantité d'une ligne de brouillon ; son prix quand il se modifie. */
export async function updateDraftLine(invoiceId: string, lineId: string, input: LineEditInput): Promise<void> {
  await refusing(() =>
    withTenant(currentTenantId(), async (tx) => {
      const invoice = await lockDraft(tx, invoiceId)
      const [line] = await tx
        .select()
        .from(invoiceLines)
        .where(and(eq(invoiceLines.id, lineId), eq(invoiceLines.invoiceId, invoiceId), isNull(invoiceLines.deletedAt)))
        .limit(1)
      if (!line) throw new InvoiceRefusedError('Ligne introuvable dans ce brouillon.')
      const negative = line.kind === 'discount' || line.unitPriceCents < 0
      await tx
        .update(invoiceLines)
        .set({
          description: input.description,
          quantity: input.quantity,
          ...(input.unitPriceCents !== undefined && linePriceEditable(invoice, line)
            ? { unitPriceCents: negative ? -Math.abs(input.unitPriceCents) : Math.abs(input.unitPriceCents) }
            : {}),
          ...(line.vatCategory !== 'S' && input.vatExemptionReason !== undefined
            ? { vatExemptionReason: input.vatExemptionReason }
            : {}),
        })
        .where(eq(invoiceLines.id, lineId))
    }),
  )
}

/** Retire une ligne d'un brouillon : sa source redevient facturable. */
export async function removeDraftLine(invoiceId: string, lineId: string): Promise<void> {
  await refusing(() =>
    withTenant(currentTenantId(), async (tx) => {
      await lockDraft(tx, invoiceId)
      await tx
        .update(invoiceLines)
        .set({ deletedAt: sql`now()` })
        .where(and(eq(invoiceLines.id, lineId), eq(invoiceLines.invoiceId, invoiceId), isNull(invoiceLines.deletedAt)))
    }),
  )
}

/** Abandonne un brouillon : ses lignes sont retirées avec lui et libèrent leurs sources. */
export async function abandonDraft(id: string): Promise<void> {
  await refusing(() =>
    withTenant(currentTenantId(), async (tx) => {
      await lockDraft(tx, id)
      await tx.update(invoices).set({ deletedAt: sql`now()` }).where(eq(invoices.id, id))
    }),
  )
}

/* -------------------------------------------------------------------------- */
/* Émission et avoirs                                                         */
/* -------------------------------------------------------------------------- */

async function issueIn(tx: Transaction, id: string, staffMemberId: string): Promise<string> {
  const [row] = await tx.execute<{ number: string }>(
    sql`select issue_invoice(${id}::uuid, ${staffMemberId}::uuid) as number`,
  )
  return row.number
}

/**
 * Émet un brouillon : numéro sans trou, date du jour du centre, échéance,
 * vendeur, acheteur et mentions figés — tout par `issue_invoice()`, dans une
 * transaction courte, sans appel extérieur (ADR 021, 026). Rend le numéro.
 * Un refus (mention manquante, facture vide) dit ce qu'il faut compléter.
 */
export async function issueInvoice(id: string, staffMemberId: string): Promise<string> {
  return refusing(() => withTenant(currentTenantId(), (tx) => issueIn(tx, id, staffMemberId)))
}

export type BulkIssueResult = {
  issued: { id: string; number: string }[]
  refused: { id: string; clientName: string; message: string }[]
}

/**
 * Émet plusieurs brouillons, chacun dans sa transaction : un refus n'empêche
 * pas les autres. Les numéros suivent l'ordre de la liste.
 */
export async function issueInvoices(ids: readonly string[], staffMemberId: string): Promise<BulkIssueResult> {
  const result: BulkIssueResult = { issued: [], refused: [] }
  for (const id of ids) {
    try {
      result.issued.push({ id, number: await issueInvoice(id, staffMemberId) })
    } catch (error) {
      if (!(error instanceof InvoiceRefusedError)) throw error
      const [client] = await withTenant(currentTenantId(), (tx) =>
        tx
          .select({ name: clients.name })
          .from(invoices)
          .innerJoin(clients, eq(clients.id, invoices.clientId))
          .where(eq(invoices.id, id))
          .limit(1),
      )
      result.refused.push({ id, clientName: client?.name ?? 'Facture introuvable', message: error.message })
    }
  }
  return result
}

/**
 * Prépare un avoir sur une facture émise (`draft_credit_note`) : il reprend ce
 * qui reste à créditer, ligne à ligne, et se réduit ensuite pour un avoir
 * partiel. Un brouillon d'avoir déjà ouvert sur la facture est repris plutôt
 * que doublé. Rend l'identifiant du brouillon.
 */
export async function prepareCreditNote(invoiceId: string, reason: string): Promise<string> {
  return refusing(() =>
    withTenant(currentTenantId(), async (tx) => {
      const [open] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            eq(invoices.creditedInvoiceId, invoiceId),
            eq(invoices.status, 'draft'),
            isNull(invoices.deletedAt),
          ),
        )
        .limit(1)
      if (open) return open.id
      const [row] = await tx.execute<{ id: string }>(
        sql`select draft_credit_note(${invoiceId}::uuid, ${reason}) as id`,
      )
      return row.id
    }),
  )
}

/**
 * Annule une facture par un avoir total : le brouillon d'avoir et son
 * émission dans une même transaction. Les lignes entièrement créditées
 * libèrent leurs sources, qui redeviennent facturables (ADR 026).
 */
export async function creditInFull(
  invoiceId: string,
  reason: string,
  staffMemberId: string,
): Promise<{ id: string; number: string }> {
  return refusing(() =>
    withTenant(currentTenantId(), async (tx) => {
      const [open] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            eq(invoices.creditedInvoiceId, invoiceId),
            eq(invoices.status, 'draft'),
            isNull(invoices.deletedAt),
          ),
        )
        .limit(1)
      if (open) {
        throw new InvoiceRefusedError(
          'Un brouillon d’avoir est déjà ouvert sur cette facture : émettez-le ou abandonnez-le d’abord.',
        )
      }
      const [row] = await tx.execute<{ id: string }>(
        sql`select draft_credit_note(${invoiceId}::uuid, ${reason}) as id`,
      )
      const number = await issueIn(tx, row.id, staffMemberId)
      return { id: row.id, number }
    }),
  )
}
