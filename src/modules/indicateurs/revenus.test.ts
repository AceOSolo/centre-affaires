import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  billingSummary,
  monthlyBilling,
  outstanding,
  remainingDueCents,
  revenueBreakdown,
  revenueByType,
  type CreditedLineRef,
  type IssuedDocument,
  type ReceivedPayment,
  type RevenueLine,
} from './revenus.ts'

const BUREAU = 'r-bureau'
const SALLE = 'r-salle'
const OUVERTURE = 's-ouverture'
const STANDARD = 's-standard'

const ligne = (id: string, overrides: Partial<RevenueLine> = {}): RevenueLine => ({
  id,
  documentKind: 'invoice',
  currency: 'EUR',
  kind: 'other',
  quantity: 1,
  netAmountCents: 0,
  resourceId: null,
  serviceId: null,
  creditedLineId: null,
  ...overrides,
})

/**
 * Factures et avoirs d'octobre : un loyer de bureau, une réservation de salle,
 * trois ouvertures de courrier (une incluse dans la souscription), un forfait,
 * une remise, une réservation facturée en francs suisses ; puis un avoir
 * partiel sur le loyer, un avoir sur une ouverture facturée en septembre et un
 * geste commercial sans ligne créditée.
 */
const lignes: RevenueLine[] = [
  ligne('L1', { kind: 'rent', resourceId: BUREAU, netAmountCents: 90_000 }),
  ligne('L2', { kind: 'booking', resourceId: SALLE, quantity: 2, netAmountCents: 5_000 }),
  ligne('L3', { kind: 'act', serviceId: OUVERTURE, netAmountCents: 0 }),
  ligne('L4', { kind: 'act', serviceId: OUVERTURE, netAmountCents: 300 }),
  ligne('L5', { kind: 'act', serviceId: OUVERTURE, netAmountCents: 300 }),
  ligne('L6', { kind: 'package', serviceId: STANDARD, netAmountCents: 5_000 }),
  ligne('L7', { kind: 'discount', netAmountCents: -1_000 }),
  ligne('L8', { kind: 'booking', resourceId: SALLE, currency: 'CHF', netAmountCents: 7_000 }),
  // Avoir saisi en ligne libre, sans ressource : il hérite de la ligne créditée.
  ligne('C1', { documentKind: 'credit_note', kind: 'other', creditedLineId: 'L1', netAmountCents: 30_000 }),
  ligne('C2', { documentKind: 'credit_note', kind: 'act', creditedLineId: 'L-septembre', netAmountCents: 300 }),
  ligne('C3', { documentKind: 'credit_note', kind: 'other', netAmountCents: 500 }),
]

/** La ligne de septembre créditée en octobre, absente des lignes de la période. */
const creditees = new Map<string, CreditedLineRef>([
  ['L-septembre', { kind: 'act', resourceId: null, serviceId: OUVERTURE }],
])

describe('revenu des lignes émises', () => {
  const revenu = revenueBreakdown(lignes, 'EUR', creditees)

  it('déduit les avoirs du facturé, au centime', () => {
    assert.deepEqual(revenu.total, { invoicedCents: 99_600, creditedCents: 30_800, netCents: 68_800 })
  })

  it('rattache chaque ligne à sa ressource, l’avoir à celle de la ligne qu’il crédite', () => {
    assert.deepEqual(revenu.byResource.get(BUREAU), {
      invoicedCents: 90_000,
      creditedCents: 30_000,
      netCents: 60_000,
    })
    assert.deepEqual(revenu.byResource.get(SALLE), { invoicedCents: 5_000, creditedCents: 0, netCents: 5_000 })
    assert.deepEqual(revenu.withoutResource, { invoicedCents: 4_600, creditedCents: 800, netCents: 3_800 })
  })

  it('compte les actes par service, inclus et crédités compris', () => {
    assert.deepEqual(revenu.byService.get(OUVERTURE), {
      invoicedCents: 600,
      creditedCents: 300,
      netCents: 300,
      // Trois actes facturés, dont un inclus à 0 €, moins un crédité.
      acts: 2,
      includedActs: 1,
    })
    assert.deepEqual(revenu.byService.get(STANDARD), {
      invoicedCents: 5_000,
      creditedCents: 0,
      netCents: 5_000,
      acts: 0,
      includedActs: 0,
    })
  })

  it('ventile par nature, l’avoir suivant la nature de ce qu’il corrige', () => {
    assert.deepEqual(revenu.byKind.get('rent'), { invoicedCents: 90_000, creditedCents: 30_000, netCents: 60_000 })
    assert.deepEqual(revenu.byKind.get('act'), { invoicedCents: 600, creditedCents: 300, netCents: 300 })
    assert.deepEqual(revenu.byKind.get('discount'), { invoicedCents: -1_000, creditedCents: 0, netCents: -1_000 })
    assert.deepEqual(revenu.byKind.get('other'), { invoicedCents: 0, creditedCents: 500, netCents: -500 })
    const somme = [...revenu.byKind.values()].reduce((total, amounts) => total + amounts.netCents, 0)
    assert.equal(somme, revenu.total.netCents)
  })

  it('écarte une autre devise sans la convertir, et le dit', () => {
    assert.equal(revenu.otherCurrencyLines, 1)
    assert.equal(revenueBreakdown(lignes, 'CHF').total.netCents, 7_000)
  })

  it('regroupe par type de ressource, une ressource inconnue restant à part', () => {
    const types = new Map([
      [BUREAU, 'bureau'],
      [SALLE, 'salle'],
    ])
    const byResource = new Map(revenu.byResource)
    byResource.set('r-inconnue', { invoicedCents: 1_000, creditedCents: 0, netCents: 1_000 })
    const { byType, unknown } = revenueByType(byResource, (id) => types.get(id))
    assert.equal(byType.get('bureau')?.netCents, 60_000)
    assert.equal(byType.get('salle')?.netCents, 5_000)
    assert.equal(unknown.netCents, 1_000)
  })
})

const document = (overrides: Partial<IssuedDocument>): IssuedDocument => ({
  kind: 'invoice',
  currency: 'EUR',
  issueDate: '2026-10-01',
  dueDate: '2026-10-31',
  totalExclTaxCents: 0,
  totalInclTaxCents: 0,
  paidCents: 0,
  creditedCents: 0,
  ...overrides,
})

const documents: IssuedDocument[] = [
  // Payée à moitié, échéance à venir.
  document({ issueDate: '2026-10-05', dueDate: '2026-11-04', totalExclTaxCents: 10_000, totalInclTaxCents: 12_000, paidCents: 5_000 }),
  // Échue, en partie créditée.
  document({ issueDate: '2026-10-01', dueDate: '2026-10-10', totalExclTaxCents: 20_000, totalInclTaxCents: 24_000, creditedCents: 2_400 }),
  // L'avoir correspondant.
  document({ kind: 'credit_note', issueDate: '2026-10-07', dueDate: '2026-10-07', totalExclTaxCents: 2_000, totalInclTaxCents: 2_400 }),
  // Émise en septembre : hors période, mais dans l'encours.
  document({ issueDate: '2026-09-20', dueDate: '2026-10-20', totalExclTaxCents: 50_000, totalInclTaxCents: 60_000 }),
  // En francs suisses.
  document({ currency: 'CHF', issueDate: '2026-10-03', totalExclTaxCents: 9_000, totalInclTaxCents: 10_800 }),
  // Trop-perçu : rien n'est dû, et le surplus ne vient pas en déduction.
  document({ issueDate: '2026-10-02', dueDate: '2026-11-01', totalExclTaxCents: 1_000, totalInclTaxCents: 1_200, paidCents: 1_500 }),
]

const paiements: ReceivedPayment[] = [
  { currency: 'EUR', paidOn: '2026-10-06', amountCents: 5_000 },
  // Un remboursement se déduit de l'encaissé.
  { currency: 'EUR', paidOn: '2026-10-08', amountCents: -300 },
  { currency: 'EUR', paidOn: '2026-09-30', amountCents: 1_000 },
  { currency: 'CHF', paidOn: '2026-10-09', amountCents: 2_000 },
]

describe('facturé, encaissé, restant dû', () => {
  const OCTOBRE = { from: '2026-10-01', to: '2026-10-31' }

  it('additionne les factures émises sur la période, avoirs déduits', () => {
    const summary = billingSummary({
      documents,
      payments: paiements,
      currency: 'EUR',
      period: OCTOBRE,
      today: '2026-10-14',
    })
    assert.deepEqual(summary, {
      invoicedExclTaxCents: 29_000,
      invoicedInclTaxCents: 34_800,
      creditNotesExclTaxCents: 2_000,
      invoiceCount: 3,
      creditNoteCount: 1,
      collectedCents: 4_700,
      dueCents: 28_600,
      overdueCents: 21_600,
      otherCurrencyCount: 2,
    })
  })

  it('ne rend jamais un reste dû négatif, ni pour un avoir', () => {
    assert.equal(remainingDueCents(documents[5]), 0)
    assert.equal(remainingDueCents(documents[2]), 0)
    assert.equal(remainingDueCents(documents[1]), 21_600)
  })

  it('donne l’encours de toutes les périodes, et ce qui est échu', () => {
    assert.deepEqual(outstanding(documents, 'EUR', '2026-10-14'), {
      dueCents: 88_600,
      overdueCents: 21_600,
      invoiceCount: 3,
    })
    // Le 21 octobre, la facture de septembre est échue à son tour.
    assert.equal(outstanding(documents, 'EUR', '2026-10-21').overdueCents, 81_600)
  })

  it('suit le facturé et l’encaissé mois par mois', () => {
    assert.deepEqual(
      monthlyBilling({ documents, payments: paiements, currency: 'EUR', months: ['2026-09', '2026-10'] }),
      [
        { month: '2026-09', invoicedExclTaxCents: 50_000, invoicedInclTaxCents: 60_000, collectedCents: 1_000 },
        { month: '2026-10', invoicedExclTaxCents: 29_000, invoicedInclTaxCents: 34_800, collectedCents: 4_700 },
      ],
    )
  })
})
