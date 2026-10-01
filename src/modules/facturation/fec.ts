import type { PaymentMethod } from '../../db/tenants.ts'
import type { InvoiceKind, InvoiceLineKind, VatCategory } from './schema-factures.ts'

/**
 * Export comptable au format du fichier des écritures comptables (FEC,
 * art. A47 A-1 du livre des procédures fiscales), R16, ADR 027 et ADR 028.
 *
 * Deux journaux :
 *
 * - **ventes** (`VE`) : par facture émise, débit du client TTC, crédit des
 *   ventes HT par nature de ligne, crédit de la TVA collectée par taux ; un
 *   avoir à l'inverse ;
 * - **banque** (`BQ`) : par paiement non annulé, débit de la banque, crédit du
 *   client ; un remboursement à l'inverse.
 *
 * Un montant négatif change de colonne : une remise (`discount`) vient au
 * débit du compte de remises. Les colonnes `Debit` et `Credit` ne portent
 * jamais de signe moins.
 *
 * Module pur : la construction, l'équilibre débit = crédit et la mise en forme
 * s'éprouvent sans base (`fec.test.ts`). Le fichier est déterministe — aucune
 * date courante n'y entre — pour que son empreinte (`accounting_exports`) dise
 * plus tard s'il a changé.
 */

/** Les dix-huit colonnes, dans l'ordre réglementaire. */
export const FEC_COLUMNS = [
  'JournalCode',
  'JournalLib',
  'EcritureNum',
  'EcritureDate',
  'CompteNum',
  'CompteLib',
  'CompAuxNum',
  'CompAuxLib',
  'PieceRef',
  'PieceDate',
  'EcritureLib',
  'Debit',
  'Credit',
  'EcritureLet',
  'DateLet',
  'ValidDate',
  'Montantdevise',
  'Idevise',
] as const

export type FecAccount = { number: string; label: string }

/** Plan de comptes du centre (`accounting_accounts`), par rôle. */
export type FecChart = {
  customers: FecAccount | null
  bank: FecAccount | null
  revenue: Partial<Record<InvoiceLineKind, FecAccount>>
  /** TVA collectée, par taux en points de base. */
  vat: ReadonlyMap<number, FecAccount>
}

export type FecJournal = { code: string; label: string }

export type FecClient = { id: string; name: string; accountingCode: string | null }

export type FecInvoice = {
  id: string
  kind: InvoiceKind
  number: string
  issueDate: string
  currency: string
  totalInclTaxCents: number
  client: FecClient
  lines: {
    kind: InvoiceLineKind
    netAmountCents: number
    vatAmountCents: number
    vatRateBp: number
    vatCategory: VatCategory
  }[]
}

export type FecPayment = {
  id: string
  paidOn: string
  amountCents: number
  currency: string
  method: PaymentMethod
  invoiceNumber: string
  client: FecClient
}

/** Une ligne d'écriture, montants en centimes : la mise en forme vient après. */
export type FecLine = {
  journalCode: string
  journalLabel: string
  entryNumber: string
  entryDate: string
  accountNumber: string
  accountLabel: string
  auxNumber: string
  auxLabel: string
  pieceRef: string
  pieceDate: string
  label: string
  debitCents: number
  creditCents: number
}

/** Export impossible : la liste dit quoi régler, dans le plan de comptes ou les fiches. */
export class FecExportError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(`Export comptable impossible : ${problems.join(' ; ')}`)
    this.name = 'FecExportError'
    this.problems = problems
  }
}

/** Ordre des comptes de vente dans une écriture. */
const LINE_KIND_ORDER: InvoiceLineKind[] = ['rent', 'booking', 'package', 'act', 'other', 'discount']
const MAX_AUX_CODE = 17

/**
 * Compte auxiliaire proposé pour un client qui n'en a pas : sa raison
 * sociale, sans accent ni ponctuation, en majuscules, 17 caractères au plus
 * (« Atelier Durand » donne `ATELIERDURAND`). Le code saisi sur la fiche
 * (`clients.accounting_code`) l'emporte toujours.
 */
export function deriveAccountingCode(name: string): string {
  const code = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, MAX_AUX_CODE)
  return code || 'CLIENT'
}

/**
 * Compte auxiliaire de chaque client de l'export. Deux clients sur un même
 * compte mêleraient leurs écritures chez l'expert-comptable : refusé, avec
 * leurs noms, plutôt que deviné.
 */
export function auxiliaryAccounts(clients: readonly FecClient[]): Map<string, string> {
  const byClient = new Map<string, string>()
  const byCode = new Map<string, Map<string, string>>()
  for (const client of clients) {
    if (byClient.has(client.id)) continue
    const code = client.accountingCode ?? deriveAccountingCode(client.name)
    byClient.set(client.id, code)
    const holders = byCode.get(code) ?? new Map<string, string>()
    holders.set(client.id, client.name)
    byCode.set(code, holders)
  }
  const problems = [...byCode.entries()]
    .filter(([, holders]) => holders.size > 1)
    .map(
      ([code, holders]) =>
        `le compte auxiliaire ${code} désignerait plusieurs clients (${[...holders.values()].join(', ')}) : donnez-leur un compte distinct`,
    )
  if (problems.length > 0) throw new FecExportError(problems)
  return byClient
}

/** « 1234,56 » : virgule décimale, sans séparateur de milliers ni signe. */
export function fecAmount(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError(`Montant invalide : ${cents}`)
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`
}

/** « 20261005 » : date `AAAAMMJJ`. */
export function fecDate(isoDate: string): string {
  return isoDate.replace(/-/g, '')
}

/** Une zone de texte : ni tabulation ni saut de ligne, qui casseraient le fichier. */
export function fecText(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').trim()
}

const paymentMethodWords: Record<PaymentMethod, string> = {
  transfer: 'virement',
  direct_debit: 'prélèvement',
  other: 'autre mode',
}

/** Un montant signé, porté au débit s'il est positif et `debitWhenPositive`, sinon au crédit. */
function sided(amountCents: number, debitWhenPositive: boolean): { debitCents: number; creditCents: number } {
  const debit = debitWhenPositive ? amountCents > 0 : amountCents < 0
  const magnitude = Math.abs(amountCents)
  return debit ? { debitCents: magnitude, creditCents: 0 } : { debitCents: 0, creditCents: magnitude }
}

/**
 * Écritures des factures et paiements donnés, triées par date d'écriture puis
 * par journal (ventes d'abord) puis par numéro. Lève `FecExportError` avec la
 * liste de tout ce qui manque : compte absent du plan, devise autre que
 * l'euro, facture incohérente.
 */
export function buildFecLines({
  journals,
  chart,
  invoices,
  payments,
}: {
  journals: { sales: FecJournal; bank: FecJournal }
  chart: FecChart
  invoices: readonly FecInvoice[]
  payments: readonly FecPayment[]
}): FecLine[] {
  const problems: string[] = []
  if (!chart.customers) problems.push('compte collectif clients absent du plan de comptes')
  if (payments.length > 0 && !chart.bank) problems.push('compte de banque absent du plan de comptes')

  const missingKinds = new Set<InvoiceLineKind>()
  const missingRates = new Set<number>()
  for (const invoice of invoices) {
    if (invoice.currency !== 'EUR') {
      problems.push(`${invoice.number} : devise ${invoice.currency}, l’export ne traite que l’euro`)
    }
    for (const line of invoice.lines) {
      if (!chart.revenue[line.kind]) missingKinds.add(line.kind)
      if (line.vatAmountCents !== 0 && !chart.vat.has(line.vatRateBp)) missingRates.add(line.vatRateBp)
    }
  }
  for (const kind of missingKinds) problems.push(`compte de ventes absent pour les lignes « ${kind} »`)
  for (const rate of [...missingRates].sort((a, b) => b - a)) {
    problems.push(`compte de TVA collectée absent pour le taux de ${formatRate(rate)} %`)
  }
  for (const payment of payments) {
    if (payment.currency !== 'EUR') {
      problems.push(`paiement de ${payment.invoiceNumber} : devise ${payment.currency}, l’export ne traite que l’euro`)
    }
  }
  if (problems.length > 0) throw new FecExportError(problems)

  const auxiliary = auxiliaryAccounts([
    ...invoices.map((invoice) => invoice.client),
    ...payments.map((payment) => payment.client),
  ])
  const customers = chart.customers as FecAccount
  type Entry = { date: string; journalRank: number; number: string; lines: FecLine[] }
  const entries: Entry[] = []

  for (const invoice of invoices) {
    const isCredit = invoice.kind === 'credit_note'
    const journal = journals.sales
    const base = {
      journalCode: journal.code,
      journalLabel: journal.label,
      entryNumber: invoice.number,
      entryDate: invoice.issueDate,
      pieceRef: invoice.number,
      pieceDate: invoice.issueDate,
      label: fecText(`${isCredit ? 'Avoir' : 'Facture'} ${invoice.number} ${invoice.client.name}`),
    }
    const lines: FecLine[] = []

    const netByKind = new Map<InvoiceLineKind, number>()
    const vatByRate = new Map<number, number>()
    for (const line of invoice.lines) {
      netByKind.set(line.kind, (netByKind.get(line.kind) ?? 0) + line.netAmountCents)
      if (line.vatAmountCents !== 0) {
        vatByRate.set(line.vatRateBp, (vatByRate.get(line.vatRateBp) ?? 0) + line.vatAmountCents)
      }
    }
    const totalFromLines =
      [...netByKind.values()].reduce((total, value) => total + value, 0) +
      [...vatByRate.values()].reduce((total, value) => total + value, 0)
    if (totalFromLines !== invoice.totalInclTaxCents) {
      problems.push(`${invoice.number} : le total TTC ne correspond pas à ses lignes`)
      continue
    }

    // Une facture : le client au débit, ventes et TVA au crédit. Un avoir : l'inverse.
    if (invoice.totalInclTaxCents !== 0) {
      lines.push({
        ...base,
        accountNumber: customers.number,
        accountLabel: customers.label,
        auxNumber: auxiliary.get(invoice.client.id) as string,
        auxLabel: fecText(invoice.client.name),
        ...sided(invoice.totalInclTaxCents, !isCredit),
      })
    }
    for (const kind of LINE_KIND_ORDER) {
      const net = netByKind.get(kind)
      if (!net) continue
      const account = chart.revenue[kind] as FecAccount
      lines.push({
        ...base,
        accountNumber: account.number,
        accountLabel: account.label,
        auxNumber: '',
        auxLabel: '',
        ...sided(net, isCredit),
      })
    }
    for (const rate of [...vatByRate.keys()].sort((a, b) => b - a)) {
      const vat = vatByRate.get(rate) as number
      const account = chart.vat.get(rate) as FecAccount
      lines.push({
        ...base,
        accountNumber: account.number,
        accountLabel: account.label,
        auxNumber: '',
        auxLabel: '',
        ...sided(vat, isCredit),
      })
    }
    if (lines.length > 0) entries.push({ date: invoice.issueDate, journalRank: 0, number: invoice.number, lines })
  }

  // Paiements : numérotés par jour de valeur, dans l'ordre de la liste reçue.
  const perDay = new Map<string, number>()
  for (const payment of payments) {
    const journal = journals.bank
    const sequence = (perDay.get(payment.paidOn) ?? 0) + 1
    perDay.set(payment.paidOn, sequence)
    const isRefund = payment.amountCents < 0
    const base = {
      journalCode: journal.code,
      journalLabel: journal.label,
      entryNumber: `${journal.code}-${fecDate(payment.paidOn)}-${String(sequence).padStart(3, '0')}`,
      entryDate: payment.paidOn,
      pieceRef: payment.invoiceNumber,
      pieceDate: payment.paidOn,
      label: fecText(
        `${isRefund ? 'Remboursement' : 'Règlement'} ${payment.invoiceNumber} ${payment.client.name} (${paymentMethodWords[payment.method]})`,
      ),
    }
    const bank = chart.bank as FecAccount
    entries.push({
      date: payment.paidOn,
      journalRank: 1,
      number: base.entryNumber,
      lines: [
        {
          ...base,
          accountNumber: bank.number,
          accountLabel: bank.label,
          auxNumber: '',
          auxLabel: '',
          ...sided(payment.amountCents, true),
        },
        {
          ...base,
          accountNumber: customers.number,
          accountLabel: customers.label,
          auxNumber: auxiliary.get(payment.client.id) as string,
          auxLabel: fecText(payment.client.name),
          ...sided(payment.amountCents, false),
        },
      ],
    })
  }

  for (const entry of entries) {
    const { debitCents, creditCents } = fecTotals(entry.lines)
    if (debitCents !== creditCents) problems.push(`écriture ${entry.number} déséquilibrée`)
  }
  if (problems.length > 0) throw new FecExportError(problems)

  entries.sort(
    (a, b) =>
      (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
      a.journalRank - b.journalRank ||
      (a.number < b.number ? -1 : a.number > b.number ? 1 : 0),
  )
  return entries.flatMap((entry) => entry.lines)
}

/** Taux en points de base, écrit à la française : 2000 → « 20 », 550 → « 5,5 », 210 → « 2,1 ». */
export function formatRate(rateBp: number): string {
  const whole = Math.floor(rateBp / 100)
  const fraction = rateBp % 100
  return fraction === 0 ? String(whole) : `${whole},${String(fraction).padStart(2, '0').replace(/0$/, '')}`
}

/** Totaux du fichier, en centimes : égaux, sinon le fichier ne part pas. */
export function fecTotals(lines: readonly FecLine[]): { debitCents: number; creditCents: number } {
  return lines.reduce(
    (totals, line) => ({
      debitCents: totals.debitCents + line.debitCents,
      creditCents: totals.creditCents + line.creditCents,
    }),
    { debitCents: 0, creditCents: 0 },
  )
}

/**
 * Le fichier : en-tête des dix-huit colonnes, une ligne par ligne d'écriture,
 * séparateur tabulation, fins de ligne CRLF, UTF-8 sans BOM. `ValidDate` est
 * la date de l'écriture ; le lettrage et la devise restent vides (tout est en
 * euros, la devise de tenue des comptes).
 */
export function fecDocument(lines: readonly FecLine[]): string {
  const rows = [FEC_COLUMNS.join('\t')]
  for (const line of lines) {
    rows.push(
      [
        fecText(line.journalCode),
        fecText(line.journalLabel),
        fecText(line.entryNumber),
        fecDate(line.entryDate),
        fecText(line.accountNumber),
        fecText(line.accountLabel),
        fecText(line.auxNumber),
        fecText(line.auxLabel),
        fecText(line.pieceRef),
        fecDate(line.pieceDate),
        fecText(line.label),
        fecAmount(line.debitCents),
        fecAmount(line.creditCents),
        '',
        '',
        fecDate(line.entryDate),
        '',
        '',
      ].join('\t'),
    )
  }
  return `${rows.join('\r\n')}\r\n`
}

/** `ecritures-2026-09-01-au-2026-09-30.txt`. */
export function fecFileName(periodStart: string, periodEnd: string): string {
  return `ecritures-${periodStart}-au-${periodEnd}.txt`
}
