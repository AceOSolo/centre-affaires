import { createHash } from 'node:crypto'

import { and, asc, between, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'

import { PG_CHECK_VIOLATION, PG_UNIQUE_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenants } from '../../db/tenants.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { clients } from '../clients/schema.ts'
import {
  buildFecLines,
  deriveAccountingCode,
  fecDocument,
  fecFileName,
  type FecChart,
  type FecInvoice,
  type FecPayment,
} from './fec.ts'
import {
  accountingAccounts,
  accountingExports,
  invoiceLines,
  invoices,
  payments,
  type AccountingAccount,
  type AccountingExport,
  type InvoiceLineKind,
} from './schema-factures.ts'

/**
 * Export comptable (R16, ADR 027, ADR 030) : plan de comptes du centre,
 * génération du fichier au format FEC, journal des exports et empreinte.
 *
 * Le fichier n'est pas stocké : il se reconstruit depuis les factures et les
 * paiements de sa période. Son empreinte SHA-256, inscrite au journal à la
 * génération, dit au téléchargement s'il est toujours celui qui a été
 * produit — un paiement annulé depuis, un compte corrigé, et ce n'est plus le
 * cas : il faut générer un nouvel export.
 */

export const journalLabels = { sales: 'Ventes', bank: 'Banque' } as const

/** Plan de comptes du centre, dans l'ordre de lecture : clients, banque, ventes, TVA. */
export async function listAccountingAccounts(): Promise<AccountingAccount[]> {
  return withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(accountingAccounts)
      .orderBy(
        sql`case ${accountingAccounts.purpose} when 'customers' then 0 when 'bank' then 1 when 'revenue' then 2 else 3 end`,
        asc(accountingAccounts.lineKind),
        desc(accountingAccounts.vatRateBp),
      ),
  )
}

/** Saisie refusée d'un compte : format du numéro, libellé vide. */
export class AccountingAccountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccountingAccountError'
  }
}

const ACCOUNT_NUMBER = /^[0-9A-Z]{3,20}$/

/** Corrige un compte en place : c'est un paramétrage, sans historique (ADR 027). */
export async function updateAccountingAccount(
  id: string,
  input: { accountNumber: string; label: string },
): Promise<boolean> {
  const accountNumber = input.accountNumber.replace(/\s/g, '').toUpperCase()
  const label = input.label.trim()
  if (!ACCOUNT_NUMBER.test(accountNumber)) {
    throw new AccountingAccountError('Numéro de compte : 3 à 20 chiffres ou lettres majuscules, sans espace.')
  }
  if (!label) throw new AccountingAccountError('Le libellé du compte est obligatoire.')
  if (!isUuid(id)) return false
  const updated = await withTenant(currentTenantId(), (tx) =>
    tx
      .update(accountingAccounts)
      .set({ accountNumber, label })
      .where(eq(accountingAccounts.id, id))
      .returning({ id: accountingAccounts.id }),
  )
  return updated.length > 0
}

function chartOf(accounts: readonly AccountingAccount[]): FecChart {
  const chart: FecChart = { customers: null, bank: null, revenue: {}, vat: new Map() }
  const vat = new Map<number, { number: string; label: string }>()
  for (const account of accounts) {
    const target = { number: account.accountNumber, label: account.label }
    if (account.purpose === 'customers') chart.customers = target
    else if (account.purpose === 'bank') chart.bank = target
    else if (account.purpose === 'revenue' && account.lineKind) chart.revenue[account.lineKind] = target
    else if (account.purpose === 'vat_collected' && account.vatRateBp !== null) vat.set(account.vatRateBp, target)
  }
  return { ...chart, vat }
}

/**
 * Nom de l'acheteur figé à l'émission (toute pièce émise a son instantané,
 * contrainte `invoices_issued_complete`). Les libellés du fichier le lisent,
 * jamais `clients.name` : renommer ou anonymiser une fiche (ADR 040) ne
 * réécrit pas le livre d'une période passée.
 */
const buyerNameAtIssue = sql<string>`${invoices.buyerSnapshot}->>'name'`

/** Factures et avoirs émis dans la période, paiements non annulés datés de la période. */
async function loadFecSource(tx: Transaction, periodStart: string, periodEnd: string) {
  const [tenant] = await tx
    .select({ sales: tenants.accountingSalesJournal, bank: tenants.accountingBankJournal })
    .from(tenants)
    .where(eq(tenants.id, currentTenantId()))
  const accounts = await tx.select().from(accountingAccounts)

  const invoiceRows = await tx
    .select({
      id: invoices.id,
      kind: invoices.kind,
      number: invoices.number,
      issueDate: invoices.issueDate,
      currency: invoices.currency,
      totalInclTaxCents: invoices.totalInclTaxCents,
      buyerName: buyerNameAtIssue,
      clientId: clients.id,
      clientName: clients.name,
      accountingCode: clients.accountingCode,
    })
    .from(invoices)
    .innerJoin(clients, eq(clients.id, invoices.clientId))
    .where(
      and(
        ne(invoices.status, 'draft'),
        isNull(invoices.deletedAt),
        between(invoices.issueDate, periodStart, periodEnd),
      ),
    )
    .orderBy(asc(invoices.issueDate), asc(invoices.number))
  const lines = invoiceRows.length
    ? await tx
        .select({
          invoiceId: invoiceLines.invoiceId,
          kind: invoiceLines.kind,
          netAmountCents: invoiceLines.netAmountCents,
          vatAmountCents: invoiceLines.vatAmountCents,
          vatRateBp: invoiceLines.vatRateBp,
          vatCategory: invoiceLines.vatCategory,
        })
        .from(invoiceLines)
        .where(
          and(
            inArray(
              invoiceLines.invoiceId,
              invoiceRows.map((row) => row.id),
            ),
            isNull(invoiceLines.deletedAt),
          ),
        )
    : []

  const fecInvoices: FecInvoice[] = invoiceRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    number: row.number as string,
    issueDate: row.issueDate as string,
    currency: row.currency,
    totalInclTaxCents: row.totalInclTaxCents,
    client: { id: row.clientId, name: row.clientName, accountingCode: row.accountingCode },
    buyerName: row.buyerName,
    lines: lines
      .filter((line) => line.invoiceId === row.id)
      .map((line) => ({
        kind: line.kind,
        netAmountCents: line.netAmountCents ?? 0,
        vatAmountCents: line.vatAmountCents,
        vatRateBp: line.vatRateBp,
        vatCategory: line.vatCategory,
      })),
  }))

  const paymentRows = await tx
    .select({
      id: payments.id,
      paidOn: payments.paidOn,
      amountCents: payments.amountCents,
      currency: payments.currency,
      method: payments.method,
      invoiceNumber: invoices.number,
      buyerName: buyerNameAtIssue,
      clientId: clients.id,
      clientName: clients.name,
      accountingCode: clients.accountingCode,
    })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .innerJoin(clients, eq(clients.id, invoices.clientId))
    .where(and(isNull(payments.cancelledAt), between(payments.paidOn, periodStart, periodEnd)))
    .orderBy(asc(payments.paidOn), asc(payments.createdAt), asc(payments.id))
  const fecPayments: FecPayment[] = paymentRows.map((row) => ({
    id: row.id,
    paidOn: row.paidOn,
    amountCents: row.amountCents,
    currency: row.currency,
    method: row.method,
    invoiceNumber: row.invoiceNumber as string,
    client: { id: row.clientId, name: row.clientName, accountingCode: row.accountingCode },
    buyerName: row.buyerName,
  }))

  return {
    journals: {
      sales: { code: tenant.sales, label: journalLabels.sales },
      bank: { code: tenant.bank, label: journalLabels.bank },
    },
    chart: chartOf(accounts),
    invoices: fecInvoices,
    payments: fecPayments,
  }
}

/** Le fichier d'une période, son nom, son empreinte et son nombre d'écritures. */
async function buildFile(tx: Transaction, periodStart: string, periodEnd: string) {
  const source = await loadFecSource(tx, periodStart, periodEnd)
  const lines = buildFecLines(source)
  const content = fecDocument(lines)
  return {
    content,
    fileName: fecFileName(periodStart, periodEnd),
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    entryCount: lines.length,
    invoiceCount: source.invoices.length,
    paymentCount: source.payments.length,
  }
}

/** Période vide : rien à exporter. */
export class EmptyExportError extends Error {
  constructor() {
    super('Aucune facture émise ni aucun paiement sur cette période : il n’y a rien à exporter.')
    this.name = 'EmptyExportError'
  }
}

/**
 * Génère l'export d'une période et l'inscrit au journal, avec son empreinte.
 * Lève `FecExportError` (compte manquant, compte auxiliaire partagé…) ou
 * `EmptyExportError`.
 */
export async function generateAccountingExport({
  periodStart,
  periodEnd,
  generatedBy,
}: {
  periodStart: string
  periodEnd: string
  generatedBy: string
}): Promise<AccountingExport> {
  return withTenant(currentTenantId(), async (tx) => {
    const file = await buildFile(tx, periodStart, periodEnd)
    if (file.entryCount === 0) throw new EmptyExportError()
    const [created] = await tx
      .insert(accountingExports)
      .values({
        format: 'fec',
        periodStart,
        periodEnd,
        fileName: file.fileName,
        fileSha256: file.sha256,
        entryCount: file.entryCount,
        generatedBy,
      })
      .returning()
    return created
  })
}

export type AccountingExportRow = AccountingExport & { generatedByName: string }

/** Journal des exports, le plus récent d'abord. */
export async function listAccountingExports(limit = 50): Promise<AccountingExportRow[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        export: accountingExports,
        generatedByName: sql<string>`coalesce(${staffMembers.fullName}, ${staffMembers.email})`,
      })
      .from(accountingExports)
      .innerJoin(staffMembers, eq(staffMembers.id, accountingExports.generatedBy))
      .orderBy(desc(accountingExports.createdAt))
      .limit(limit),
  )
  return rows.map((row) => ({ ...row.export, generatedByName: row.generatedByName }))
}

/**
 * Le fichier d'un export du journal, reconstruit et comparé à son empreinte.
 * `changed` : les données de la période ont bougé depuis (paiement annulé,
 * compte corrigé) — le fichier remis à l'expert-comptable n'est plus celui-ci.
 */
export async function rebuildAccountingExport(
  id: string,
): Promise<
  | { status: 'ok'; fileName: string; content: string; sha256: string }
  | { status: 'changed'; recorded: AccountingExport }
  | undefined
> {
  if (!isUuid(id)) return undefined
  return withTenant(currentTenantId(), async (tx) => {
    const [recorded] = await tx.select().from(accountingExports).where(eq(accountingExports.id, id)).limit(1)
    if (!recorded) return undefined
    const file = await buildFile(tx, recorded.periodStart, recorded.periodEnd)
    if (file.sha256 !== recorded.fileSha256) return { status: 'changed', recorded }
    return { status: 'ok', fileName: recorded.fileName, content: file.content, sha256: file.sha256 }
  })
}

/** Un client facturé, son compte auxiliaire et celui que l'export lui donnerait. */
export type ClientAccountingCode = {
  id: string
  name: string
  accountingCode: string | null
  proposedCode: string
}

/** Clients vivants qui ont au moins une facture émise : ceux que l'export nomme. */
export async function listInvoicedClientCodes(): Promise<ClientAccountingCode[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ id: clients.id, name: clients.name, accountingCode: clients.accountingCode })
      .from(clients)
      .where(
        and(
          isNull(clients.deletedAt),
          sql`exists (select 1 from invoices as i where i.tenant_id = ${clients.tenantId} and i.client_id = ${clients.id} and i.status <> 'draft')`,
        ),
      )
      .orderBy(asc(clients.name)),
  )
  return rows.map((row) => ({ ...row, proposedCode: row.accountingCode ?? deriveAccountingCode(row.name) }))
}

const ACCOUNTING_CODE = /^[0-9A-Z]{1,17}$/

/**
 * Fixe les comptes auxiliaires saisis (vide : rien de fixé, l'export dérive
 * le code de la raison sociale). Rend une erreur par client refusé — format,
 * ou code déjà pris par un autre client — et n'écrit rien dans ce cas.
 */
export async function saveClientAccountingCodes(
  codes: ReadonlyMap<string, string | null>,
): Promise<Record<string, string>> {
  const errors: Record<string, string> = {}
  const seen = new Map<string, string>()
  for (const [clientId, code] of codes) {
    if (!isUuid(clientId)) continue
    if (code === null) continue
    if (!ACCOUNTING_CODE.test(code)) {
      errors[clientId] = '1 à 17 chiffres ou lettres majuscules, sans espace ni accent.'
    } else if (seen.has(code)) {
      errors[clientId] = `Le compte ${code} est déjà donné à un autre client de la liste.`
    }
    seen.set(code, clientId)
  }
  if (Object.keys(errors).length > 0) return errors

  try {
    await withTenant(currentTenantId(), async (tx) => {
      // D'abord libérer, puis poser : deux clients qui échangent leurs codes
      // ne se heurtent pas à l'index unique.
      const ids = [...codes.keys()].filter(isUuid)
      if (ids.length === 0) return
      await tx.update(clients).set({ accountingCode: null }).where(inArray(clients.id, ids))
      for (const [clientId, code] of codes) {
        if (code !== null && isUuid(clientId)) {
          await tx.update(clients).set({ accountingCode: code }).where(eq(clients.id, clientId))
        }
      }
    })
  } catch (error) {
    const sqlState = pgErrorCode(error)
    if (sqlState === PG_UNIQUE_VIOLATION || sqlState === PG_CHECK_VIOLATION) {
      return { '': 'Un de ces comptes est déjà donné à un autre client : choisissez-en un autre.' }
    }
    throw error
  }
  return {}
}

/** Libellé d'une nature de ligne dans le plan de comptes. */
export const lineKindAccountLabels: Record<InvoiceLineKind, string> = {
  rent: 'Ventes : loyers et domiciliation',
  booking: 'Ventes : réservations',
  package: 'Ventes : forfaits',
  act: 'Ventes : actes',
  discount: 'Remises accordées',
  other: 'Ventes : prestations diverses',
}
