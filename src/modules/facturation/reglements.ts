import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { PG_PAYMENT_REFUSED, pgErrorCode } from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenants, type Tenant } from '../../db/tenants.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { clientContacts, clients } from '../clients/schema.ts'
import { guardMessage } from './erreurs-base.ts'
import { amountDueCents } from './montants.ts'
import { checkPaymentAmount, daysOverdue, dunningLevel, type DunningLevel, type PaymentInput } from './paiements-regles.ts'
import {
  invoiceLines,
  invoices,
  payments,
  sepaMandates,
  type Invoice,
  type InvoiceLine,
  type Payment,
  type SepaMandateStatus,
} from './schema-factures.ts'

/**
 * Règlements des factures (R16, ADR 027, ADR 028) : pointage et annulation
 * des paiements, factures échues à relancer, fiche de règlement d'une
 * facture.
 *
 * Le statut et `paid_cents` sont tenus par la base après chaque écriture
 * (`invoice_settle`) : ce module n'écrit que des paiements.
 */


export type PaymentRow = Payment & { recordedByName: string; cancelledByName: string | null }

/** Une facture, son client, ses lignes et ses paiements : la fiche de règlement. */
export type InvoiceSettlement = {
  invoice: Invoice
  client: { id: string; name: string; email: string | null; country: string }
  lines: InvoiceLine[]
  payments: PaymentRow[]
  /** Pour un avoir : la facture corrigée. */
  precedingInvoice: { id: string; number: string | null; issueDate: string | null } | null
  mandate: { reference: string; status: SepaMandateStatus; ibanLast4: string } | null
}

export async function findInvoiceSettlement(id: string): Promise<InvoiceSettlement | undefined> {
  if (!isUuid(id)) return undefined
  return withTenant(currentTenantId(), async (tx) => {
    const [row] = await tx
      .select({
        invoice: invoices,
        client: { id: clients.id, name: clients.name, email: clients.email, country: clients.country },
      })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .where(eq(invoices.id, id))
      .limit(1)
    if (!row) return undefined

    const recorder = alias(staffMembers, 'recorder')
    const canceller = alias(staffMembers, 'canceller')
    // Une transaction n'a qu'une connexion : les lectures se suivent.
    const lines = await tx
      .select()
      .from(invoiceLines)
      .where(and(eq(invoiceLines.invoiceId, id), isNull(invoiceLines.deletedAt)))
      .orderBy(asc(invoiceLines.position), asc(invoiceLines.id))
    const paymentRows = await tx
      .select({
        payment: payments,
        recordedByName: sql<string>`coalesce(${recorder.fullName}, ${recorder.email})`,
        cancelledByName: sql<string | null>`coalesce(${canceller.fullName}, ${canceller.email})`,
      })
      .from(payments)
      .innerJoin(recorder, eq(recorder.id, payments.recordedBy))
      .leftJoin(canceller, eq(canceller.id, payments.cancelledBy))
      .where(eq(payments.invoiceId, id))
      .orderBy(asc(payments.paidOn), asc(payments.createdAt))
    const preceding = row.invoice.creditedInvoiceId
      ? await tx
          .select({ id: invoices.id, number: invoices.number, issueDate: invoices.issueDate })
          .from(invoices)
          .where(eq(invoices.id, row.invoice.creditedInvoiceId))
          .limit(1)
      : []
    const mandate = row.invoice.sepaMandateId
      ? await tx
          .select({
            reference: sepaMandates.reference,
            status: sepaMandates.status,
            ibanLast4: sepaMandates.ibanLast4,
          })
          .from(sepaMandates)
          .where(eq(sepaMandates.id, row.invoice.sepaMandateId))
          .limit(1)
      : []
    return {
      invoice: row.invoice,
      client: row.client,
      lines,
      payments: paymentRows.map((payment) => ({
        ...payment.payment,
        recordedByName: payment.recordedByName,
        cancelledByName: payment.cancelledByName,
      })),
      precedingInvoice: preceding[0] ?? null,
      mandate: mandate[0] ?? null,
    }
  })
}

/** Paiement refusé : la facture ne se paie pas (brouillon, avoir), ou la base a dit non. */
export class PaymentRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentRefusedError'
  }
}

/** Montant refusé face à la facture : trop-perçu non assumé, remboursement excessif. */
export class PaymentAmountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentAmountError'
  }
}

/**
 * Pointe un paiement reçu (ou un remboursement, en négatif) sur une facture
 * émise. La facture est verrouillée le temps de contrôler le montant face au
 * reste dû et d'écrire : deux pointages simultanés ne voient pas le même
 * reste. Un prélèvement reprend le mandat de la facture.
 */
export async function recordPayment(
  invoiceId: string,
  input: PaymentInput,
  recordedBy: string,
): Promise<Payment> {
  try {
    return await withTenant(currentTenantId(), async (tx) => {
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .for('no key update')
      if (!invoice || invoice.deletedAt) throw new PaymentRefusedError('Facture introuvable.')
      if (invoice.kind !== 'invoice') {
        throw new PaymentRefusedError(
          'Un avoir ne se paie pas : un remboursement se pointe sur la facture, en montant négatif.',
        )
      }
      if (invoice.status === 'draft') {
        throw new PaymentRefusedError('Un brouillon ne se paie pas : émettez d’abord la facture.')
      }
      const amountMessage = checkPaymentAmount({
        amountCents: input.amountCents,
        amountDueCents: amountDueCents(invoice),
        paidCents: invoice.paidCents,
        currency: invoice.currency,
        overpaymentConfirmed: input.overpaymentConfirmed,
      })
      if (amountMessage) throw new PaymentAmountError(amountMessage)

      const [created] = await tx
        .insert(payments)
        .values({
          invoiceId,
          amountCents: input.amountCents,
          currency: invoice.currency,
          paidOn: input.paidOn,
          method: input.method,
          reference: input.reference,
          notes: input.notes,
          sepaMandateId: input.method === 'direct_debit' ? invoice.sepaMandateId : null,
          recordedBy,
        })
        .returning()
      return created
    })
  } catch (error) {
    if (pgErrorCode(error) === PG_PAYMENT_REFUSED) {
      throw new PaymentRefusedError(guardMessage(error) ?? 'Paiement refusé.')
    }
    throw error
  }
}

/**
 * Annule un pointage : la ligne reste, avec qui l'a annulée, quand et
 * pourquoi (ADR 027). Rend `false` si le paiement était déjà annulé ou
 * n'appartient pas à cette facture.
 */
export async function cancelPayment({
  invoiceId,
  paymentId,
  reason,
  cancelledBy,
}: {
  invoiceId: string
  paymentId: string
  reason: string
  cancelledBy: string
}): Promise<boolean> {
  if (!isUuid(invoiceId) || !isUuid(paymentId)) return false
  const cancelled = await withTenant(currentTenantId(), (tx) =>
    tx
      .update(payments)
      .set({ cancelledAt: sql`now()`, cancelledBy, cancellationReason: reason })
      .where(
        and(eq(payments.id, paymentId), eq(payments.invoiceId, invoiceId), isNull(payments.cancelledAt)),
      )
      .returning({ id: payments.id }),
  )
  return cancelled.length > 0
}

/** Une facture émise qui attend un règlement. */
export type OpenInvoice = {
  id: string
  number: string
  clientId: string
  clientName: string
  issueDate: string
  dueDate: string
  currency: string
  totalInclTaxCents: number
  amountDueCents: number
  status: Invoice['status']
  expectedPaymentMethod: Invoice['expectedPaymentMethod']
  daysOverdue: number
  level: DunningLevel
}

const openInvoiceColumns = {
  id: invoices.id,
  number: invoices.number,
  clientId: invoices.clientId,
  clientName: clients.name,
  issueDate: invoices.issueDate,
  dueDate: invoices.dueDate,
  currency: invoices.currency,
  totalInclTaxCents: invoices.totalInclTaxCents,
  paidCents: invoices.paidCents,
  creditedCents: invoices.creditedCents,
  status: invoices.status,
  expectedPaymentMethod: invoices.expectedPaymentMethod,
}

/** Reste dû strictement positif, calculé par la base comme `amountDueCents`. */
const stillDue = sql`${invoices.totalInclTaxCents} - ${invoices.creditedCents} - ${invoices.paidCents} > 0`

/**
 * Factures émises qui restent à régler, échues (`overdue`) ou non, la plus
 * ancienne échéance d'abord. Un avoir n'est jamais « à régler ».
 */
export async function listOpenInvoices({
  today,
  overdue,
  limit = 200,
}: {
  today: string
  overdue: boolean
  limit?: number
}): Promise<OpenInvoice[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select(openInvoiceColumns)
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .where(
        and(
          eq(invoices.kind, 'invoice'),
          inArray(invoices.status, ['issued', 'partially_paid']),
          isNull(invoices.deletedAt),
          isNotNull(invoices.dueDate),
          overdue ? lt(invoices.dueDate, today) : gte(invoices.dueDate, today),
          stillDue,
        ),
      )
      .orderBy(asc(invoices.dueDate), asc(invoices.number))
      .limit(limit),
  )
  return rows.map((row) => ({
    id: row.id,
    number: row.number as string,
    clientId: row.clientId,
    clientName: row.clientName,
    issueDate: row.issueDate as string,
    dueDate: row.dueDate as string,
    currency: row.currency,
    totalInclTaxCents: row.totalInclTaxCents,
    amountDueCents: amountDueCents(row),
    status: row.status,
    expectedPaymentMethod: row.expectedPaymentMethod,
    daysOverdue: daysOverdue(row.dueDate as string, today),
    level: dunningLevel(row.dueDate as string, today),
  }))
}

export type RecentPayment = Payment & { invoiceNumber: string; clientName: string }

/** Derniers pointages, annulés compris : la trace d'une erreur compte autant que le pointage. */
export async function listRecentPayments(limit = 20): Promise<RecentPayment[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ payment: payments, invoiceNumber: invoices.number, clientName: clients.name })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .orderBy(desc(payments.createdAt))
      .limit(limit),
  )
  return rows.map((row) => ({ ...row.payment, invoiceNumber: row.invoiceNumber ?? '', clientName: row.clientName }))
}

/** Numéro de facture saisi vers son identifiant, pour ouvrir sa fiche de règlement. */
export async function findInvoiceIdByNumber(number: string): Promise<string | undefined> {
  const normalized = number.trim().toUpperCase()
  if (!/^[A-Z]{2}-\d{4}-\d{1,9}$/.test(normalized)) return undefined
  const [row] = await withTenant(currentTenantId(), (tx) =>
    tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.number, normalized)).limit(1),
  )
  return row?.id
}

/** Ce qu'il faut pour écrire une relance : la facture, le centre, les destinataires. */
export type ReminderContext = {
  invoice: Invoice
  client: { id: string; name: string; email: string | null }
  tenant: Pick<
    Tenant,
    'name' | 'legalName' | 'bankIban' | 'bankBic' | 'latePaymentPenaltyText' | 'recoveryIndemnityCents' | 'timezone'
  >
  /** Contacts « destinataire des factures », sinon l'adresse de la fiche. */
  recipients: string[]
}

export async function findReminderContexts(invoiceIds: readonly string[]): Promise<ReminderContext[]> {
  const ids = invoiceIds.filter(isUuid)
  if (ids.length === 0) return []
  return withTenant(currentTenantId(), async (tx) => {
    const [tenant] = await tx
      .select({
        name: tenants.name,
        legalName: tenants.legalName,
        bankIban: tenants.bankIban,
        bankBic: tenants.bankBic,
        latePaymentPenaltyText: tenants.latePaymentPenaltyText,
        recoveryIndemnityCents: tenants.recoveryIndemnityCents,
        timezone: tenants.timezone,
      })
      .from(tenants)
      .where(eq(tenants.id, currentTenantId()))
    const rows = await tx
      .select({ invoice: invoices, client: { id: clients.id, name: clients.name, email: clients.email } })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .where(and(inArray(invoices.id, ids), eq(invoices.kind, 'invoice'), gt(invoices.totalInclTaxCents, 0)))
      .orderBy(asc(invoices.dueDate), asc(invoices.number))
    if (rows.length === 0) return []
    const contacts = await tx
      .select({ clientId: clientContacts.clientId, email: clientContacts.email })
      .from(clientContacts)
      .where(
        and(
          inArray(clientContacts.clientId, [...new Set(rows.map((row) => row.client.id))]),
          eq(clientContacts.isBilling, true),
          isNull(clientContacts.deletedAt),
          isNotNull(clientContacts.email),
        ),
      )
    return rows.map((row) => {
      const billing = contacts
        .filter((contact) => contact.clientId === row.client.id && contact.email)
        .map((contact) => contact.email as string)
      return {
        invoice: row.invoice,
        client: row.client,
        tenant,
        recipients: billing.length > 0 ? billing : row.client.email ? [row.client.email] : [],
      }
    })
  })
}
