import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  FEC_COLUMNS,
  FecExportError,
  auxiliaryAccounts,
  buildFecLines,
  deriveAccountingCode,
  fecAmount,
  fecDate,
  fecDocument,
  fecFileName,
  fecTotals,
  formatRate,
  type FecChart,
  type FecInvoice,
  type FecLine,
  type FecPayment,
} from './fec.ts'

/**
 * Export comptable au format FEC (R16, ADR 027, ADR 030) : écritures des
 * ventes et de la banque, comptes du plan du centre, équilibre débit =
 * crédit, mise en forme des dix-huit colonnes.
 */
const journals = { sales: { code: 'VE', label: 'Ventes' }, bank: { code: 'BQ', label: 'Banque' } }

const chart: FecChart = {
  customers: { number: '411000', label: 'Clients' },
  bank: { number: '512000', label: 'Banque' },
  revenue: {
    rent: { number: '706100', label: 'Loyers et domiciliation' },
    booking: { number: '706200', label: 'Réservations' },
    package: { number: '706300', label: 'Forfaits' },
    act: { number: '706400', label: 'Actes' },
    discount: { number: '709000', label: 'Remises accordées' },
    other: { number: '706000', label: 'Prestations diverses' },
  },
  vat: new Map([
    [2000, { number: '445711', label: 'TVA collectée 20 %' }],
    [1000, { number: '445712', label: 'TVA collectée 10 %' }],
    [550, { number: '445713', label: 'TVA collectée 5,5 %' }],
  ]),
}

const DURAND = { id: 'c1', name: 'Atelier Durand', accountingCode: null }
const PETIT = { id: 'c2', name: 'Boulangerie Petit', accountingCode: 'PETIT' }

/** Loyer 900 €, ouverture d'un pli 3 €, remise de 10 € : 893 € HT, 178,60 € de TVA. */
const facture: FecInvoice = {
  id: 'i1',
  kind: 'invoice',
  number: 'FA-2026-0001',
  issueDate: '2026-09-30',
  currency: 'EUR',
  totalInclTaxCents: 107_160,
  client: DURAND,
  lines: [
    { kind: 'rent', netAmountCents: 90_000, vatAmountCents: 18_000, vatRateBp: 2000, vatCategory: 'S' },
    { kind: 'act', netAmountCents: 300, vatAmountCents: 60, vatRateBp: 2000, vatCategory: 'S' },
    { kind: 'discount', netAmountCents: -1_000, vatAmountCents: -200, vatRateBp: 2000, vatCategory: 'S' },
  ],
}

/** Deux taux sur une facture : 50 € à 20 %, 15 € à 10 %, une ligne exonérée. */
const factureDeuxTaux: FecInvoice = {
  id: 'i2',
  kind: 'invoice',
  number: 'FA-2026-0002',
  issueDate: '2026-09-15',
  currency: 'EUR',
  totalInclTaxCents: 6_000 + 1_650 + 500,
  client: PETIT,
  lines: [
    { kind: 'booking', netAmountCents: 5_000, vatAmountCents: 1_000, vatRateBp: 2000, vatCategory: 'S' },
    { kind: 'other', netAmountCents: 1_500, vatAmountCents: 150, vatRateBp: 1000, vatCategory: 'S' },
    { kind: 'other', netAmountCents: 500, vatAmountCents: 0, vatRateBp: 0, vatCategory: 'E' },
  ],
}

const avoir: FecInvoice = {
  id: 'i3',
  kind: 'credit_note',
  number: 'AV-2026-0001',
  issueDate: '2026-09-30',
  currency: 'EUR',
  totalInclTaxCents: 12_000,
  client: PETIT,
  lines: [{ kind: 'booking', netAmountCents: 10_000, vatAmountCents: 2_000, vatRateBp: 2000, vatCategory: 'S' }],
}

const paiement = (values: Partial<FecPayment> = {}): FecPayment => ({
  id: 'p1',
  paidOn: '2026-09-30',
  amountCents: 107_160,
  currency: 'EUR',
  method: 'transfer',
  invoiceNumber: 'FA-2026-0001',
  client: DURAND,
  ...values,
})

const summary = (lines: FecLine[]) =>
  lines.map((line) => [line.journalCode, line.entryNumber, line.accountNumber, line.auxNumber, line.debitCents, line.creditCents])

describe('écritures des ventes', () => {
  it('débite le client TTC, crédite les ventes par nature et la TVA ; une remise passe au débit', () => {
    const lines = buildFecLines({ journals, chart, invoices: [facture], payments: [] })
    assert.deepEqual(summary(lines), [
      ['VE', 'FA-2026-0001', '411000', 'ATELIERDURAND', 107_160, 0],
      ['VE', 'FA-2026-0001', '706100', '', 0, 90_000],
      ['VE', 'FA-2026-0001', '706400', '', 0, 300],
      ['VE', 'FA-2026-0001', '709000', '', 1_000, 0],
      ['VE', 'FA-2026-0001', '445711', '', 0, 17_860],
    ])
    const { debitCents, creditCents } = fecTotals(lines)
    assert.equal(debitCents, creditCents)
    assert.equal(lines[0].auxLabel, 'Atelier Durand')
    assert.equal(lines[0].label, 'Facture FA-2026-0001 Atelier Durand')
  })

  it('ventile la TVA par taux, sans écriture pour une ligne exonérée', () => {
    const lines = buildFecLines({ journals, chart, invoices: [factureDeuxTaux], payments: [] })
    assert.deepEqual(summary(lines), [
      ['VE', 'FA-2026-0002', '411000', 'PETIT', 8_150, 0],
      ['VE', 'FA-2026-0002', '706200', '', 0, 5_000],
      ['VE', 'FA-2026-0002', '706000', '', 0, 2_000],
      ['VE', 'FA-2026-0002', '445711', '', 0, 1_000],
      ['VE', 'FA-2026-0002', '445712', '', 0, 150],
    ])
  })

  it('passe un avoir à l’inverse : client au crédit, ventes et TVA au débit', () => {
    const lines = buildFecLines({ journals, chart, invoices: [avoir], payments: [] })
    assert.deepEqual(summary(lines), [
      ['VE', 'AV-2026-0001', '411000', 'PETIT', 0, 12_000],
      ['VE', 'AV-2026-0001', '706200', '', 10_000, 0],
      ['VE', 'AV-2026-0001', '445711', '', 2_000, 0],
    ])
    assert.equal(lines[0].label, 'Avoir AV-2026-0001 Boulangerie Petit')
  })
})

describe('écritures de banque', () => {
  it('débite la banque et crédite le client ; un remboursement à l’inverse', () => {
    const lines = buildFecLines({
      journals,
      chart,
      invoices: [],
      payments: [
        paiement(),
        paiement({ id: 'p2', amountCents: -500, method: 'other' }),
        paiement({ id: 'p3', paidOn: '2026-10-01', amountCents: 2_000, method: 'direct_debit' }),
      ],
    })
    assert.deepEqual(summary(lines), [
      ['BQ', 'BQ-20260930-001', '512000', '', 107_160, 0],
      ['BQ', 'BQ-20260930-001', '411000', 'ATELIERDURAND', 0, 107_160],
      ['BQ', 'BQ-20260930-002', '512000', '', 0, 500],
      ['BQ', 'BQ-20260930-002', '411000', 'ATELIERDURAND', 500, 0],
      ['BQ', 'BQ-20261001-001', '512000', '', 2_000, 0],
      ['BQ', 'BQ-20261001-001', '411000', 'ATELIERDURAND', 0, 2_000],
    ])
    assert.equal(lines[0].pieceRef, 'FA-2026-0001')
    assert.equal(lines[2].label, 'Remboursement FA-2026-0001 Atelier Durand (autre mode)')
    assert.equal(lines[4].label, 'Règlement FA-2026-0001 Atelier Durand (prélèvement)')
  })
})

describe('fichier complet', () => {
  const lines = buildFecLines({
    journals,
    chart,
    invoices: [facture, factureDeuxTaux, avoir],
    payments: [paiement(), paiement({ id: 'p2', paidOn: '2026-09-15', amountCents: 8_150, client: PETIT, invoiceNumber: 'FA-2026-0002' })],
  })

  it('équilibre le débit et le crédit, au total et par écriture', () => {
    const { debitCents, creditCents } = fecTotals(lines)
    assert.equal(debitCents, creditCents)
    assert.ok(debitCents > 0)
    const byEntry = new Map<string, FecLine[]>()
    for (const line of lines) byEntry.set(line.entryNumber, [...(byEntry.get(line.entryNumber) ?? []), line])
    for (const [entry, entryLines] of byEntry) {
      const totals = fecTotals(entryLines)
      assert.equal(totals.debitCents, totals.creditCents, entry)
    }
  })

  it('classe par date, les ventes avant la banque le même jour', () => {
    const order = [...new Set(lines.map((line) => `${line.entryDate} ${line.entryNumber}`))]
    assert.deepEqual(order, [
      '2026-09-15 FA-2026-0002',
      '2026-09-15 BQ-20260915-001',
      '2026-09-30 AV-2026-0001',
      '2026-09-30 FA-2026-0001',
      '2026-09-30 BQ-20260930-001',
    ])
  })

  it('écrit les dix-huit colonnes séparées par des tabulations, virgule décimale, dates AAAAMMJJ', () => {
    const text = fecDocument(lines)
    assert.ok(text.endsWith('\r\n'))
    const rows = text.slice(0, -2).split('\r\n')
    assert.equal(rows[0], FEC_COLUMNS.join('\t'))
    assert.equal(rows.length, lines.length + 1)
    for (const row of rows) assert.equal(row.split('\t').length, 18)
    const first = rows[1].split('\t')
    assert.deepEqual(first, [
      'VE',
      'Ventes',
      'FA-2026-0002',
      '20260915',
      '411000',
      'Clients',
      'PETIT',
      'Boulangerie Petit',
      'FA-2026-0002',
      '20260915',
      'Facture FA-2026-0002 Boulangerie Petit',
      '81,50',
      '0,00',
      '',
      '',
      '20260915',
      '',
      '',
    ])
  })

  it('est déterministe : deux générations donnent le même fichier', () => {
    const again = buildFecLines({
      journals,
      chart,
      invoices: [avoir, factureDeuxTaux, facture],
      payments: [paiement({ id: 'p2', paidOn: '2026-09-15', amountCents: 8_150, client: PETIT, invoiceNumber: 'FA-2026-0002' }), paiement()],
    })
    assert.equal(fecDocument(again), fecDocument(lines))
  })
})

describe('refus de l’export', () => {
  const problemsOf = (run: () => unknown): string[] => {
    try {
      run()
    } catch (error) {
      assert.ok(error instanceof FecExportError)
      return error.problems
    }
    assert.fail('export accepté')
  }

  it('refuse un taux de TVA sans compte plutôt que d’improviser', () => {
    const problems = problemsOf(() =>
      buildFecLines({
        journals,
        chart: { ...chart, vat: new Map([[2000, { number: '445711', label: 'TVA 20 %' }]]) },
        invoices: [factureDeuxTaux],
        payments: [],
      }),
    )
    assert.deepEqual(problems, ['compte de TVA collectée absent pour le taux de 10 %'])
  })

  it('refuse un paiement sans compte de banque, une devise autre que l’euro', () => {
    const problems = problemsOf(() =>
      buildFecLines({
        journals,
        chart: { ...chart, bank: null },
        invoices: [{ ...facture, currency: 'CHF' }],
        payments: [paiement()],
      }),
    )
    assert.deepEqual(problems, [
      'compte de banque absent du plan de comptes',
      'FA-2026-0001 : devise CHF, l’export ne traite que l’euro',
    ])
  })

  it('refuse une facture dont le total ne correspond pas à ses lignes', () => {
    const problems = problemsOf(() =>
      buildFecLines({ journals, chart, invoices: [{ ...facture, totalInclTaxCents: 107_161 }], payments: [] }),
    )
    assert.deepEqual(problems, ['FA-2026-0001 : le total TTC ne correspond pas à ses lignes'])
  })

  it('refuse deux clients sur un même compte auxiliaire', () => {
    const problems = problemsOf(() =>
      auxiliaryAccounts([DURAND, { id: 'c9', name: 'Atelier  Durand', accountingCode: null }, PETIT]),
    )
    assert.deepEqual(problems, [
      'le compte auxiliaire ATELIERDURAND désignerait plusieurs clients (Atelier Durand, Atelier  Durand) : donnez-leur un compte distinct',
    ])
  })
})

describe('mise en forme', () => {
  it('dérive un compte auxiliaire de la raison sociale', () => {
    assert.equal(deriveAccountingCode('Société Générale d’Électricité'), 'SOCIETEGENERALEDE')
    assert.equal(deriveAccountingCode('3D Print & Co'), '3DPRINTCO')
    assert.equal(deriveAccountingCode('—'), 'CLIENT')
  })

  it('écrit un taux à la française', () => {
    assert.equal(formatRate(2000), '20')
    assert.equal(formatRate(1000), '10')
    assert.equal(formatRate(550), '5,5')
    assert.equal(formatRate(210), '2,1')
    assert.equal(formatRate(55), '0,55')
  })

  it('écrit montants, dates et nom de fichier', () => {
    assert.equal(fecAmount(0), '0,00')
    assert.equal(fecAmount(5), '0,05')
    assert.equal(fecAmount(123_456_789), '1234567,89')
    assert.throws(() => fecAmount(-1), RangeError)
    assert.equal(fecDate('2026-10-05'), '20261005')
    assert.equal(fecFileName('2026-09-01', '2026-09-30'), 'ecritures-2026-09-01-au-2026-09-30.txt')
  })
})
