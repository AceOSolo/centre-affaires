import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  bookingInvoiceLine,
  computeRun,
  contractInvoiceLines,
  contractKey,
  expectedPaymentFor,
  mailActInvoiceLines,
  previewAmounts,
  subscriptionInvoiceLines,
  vatCategoryFor,
  type BillingActService,
  type BillingActSubscription,
  type BillingBooking,
  type BillingContract,
  type BillingMailItem,
  type BillingSubscription,
  type InvoiceLineDraft,
  type RunSettings,
} from './lot.ts'
import { contractSchedule } from '../contrats/echeancier.ts'
import { lineNetAmountCents, vatAmountCents } from './montants.ts'
import { runWindows } from './periodes.ts'

/**
 * Lot de facturation (R13, R14, R15, ADR 024 à 026, ADR 029) : ce que chaque
 * source donne comme lignes de facture, ce qui reste à facturer, les actes
 * inclus, le regroupement par client, la TVA par taux.
 */
const octobre: RunSettings = {
  windows: runWindows('2026-10', 'in_advance'),
  timing: 'in_advance',
  prorataRule: 'calendar_days',
  currency: 'EUR',
}

const contrat = (overrides: Partial<BillingContract> = {}): BillingContract => ({
  id: 'k1',
  clientId: 'c1',
  reference: 'CT-2026-0001',
  label: 'Bureau privatif',
  billingPeriod: 'monthly',
  currency: 'EUR',
  vatRateBp: 2000,
  versions: [{ amendmentId: null, amendmentNumber: null, startsOn: '2026-01-01', endsOn: null, amountCents: 90_000 }],
  lines: [],
  segments: [{ startsOn: '2026-01-01', endsOn: null, resourceId: 'r1' }],
  ...overrides,
})

const net = (line: InvoiceLineDraft) => lineNetAmountCents(line)

describe('loyer d’un contrat sans ligne', () => {
  it('facture le mois du lot au montant du contrat, avec sa ressource', () => {
    const { lines, warnings } = contractInvoiceLines(contrat(), new Map(), octobre)
    assert.deepEqual(warnings, [])
    assert.equal(lines.length, 1)
    const [loyer] = lines
    assert.equal(loyer.kind, 'rent')
    assert.equal(loyer.description, 'Bureau privatif — contrat CT-2026-0001')
    assert.deepEqual([loyer.periodStart, loyer.periodEnd], ['2026-10-01', '2026-10-31'])
    assert.equal(loyer.unitPriceCents, 90_000)
    assert.equal(loyer.prorataNumerator, null)
    assert.equal(loyer.contractId, 'k1')
    assert.equal(loyer.contractLineId, null)
    assert.equal(loyer.resourceId, 'r1')
    assert.equal(net(loyer), 90_000)
  })

  it('proratise le premier mois partiel, sans arrondir avant la base', () => {
    const { lines } = contractInvoiceLines(
      contrat({
        versions: [{ amendmentId: null, amendmentNumber: null, startsOn: '2026-10-10', endsOn: null, amountCents: 90_000 }],
      }),
      new Map(),
      octobre,
    )
    assert.deepEqual([lines[0].prorataNumerator, lines[0].prorataDenominator], [22, 31])
    assert.equal(net(lines[0]), 63_871)
  })

  it('ne refacture pas un mois déjà facturé, et ne facture que le reste d’un mois entamé', () => {
    const toutOctobre = new Map([[contractKey('k1', null), [{ start: '2026-10-01', end: '2026-10-31' }]]])
    assert.deepEqual(contractInvoiceLines(contrat(), toutOctobre, octobre).lines, [])

    const debut = new Map([[contractKey('k1', null), [{ start: '2026-10-01', end: '2026-10-15' }]]])
    const [reste] = contractInvoiceLines(contrat(), debut, octobre).lines
    assert.deepEqual([reste.periodStart, reste.periodEnd], ['2026-10-16', '2026-10-31'])
    assert.deepEqual([reste.prorataNumerator, reste.prorataDenominator], [16, 31])
  })

  it('coupe le mois à la date d’effet d’un avenant, chaque morceau à son prix', () => {
    const { lines } = contractInvoiceLines(
      contrat({
        versions: [
          { amendmentId: null, amendmentNumber: null, startsOn: '2026-01-01', endsOn: '2026-10-14', amountCents: 90_000 },
          { amendmentId: 'a1', amendmentNumber: 1, startsOn: '2026-10-15', endsOn: null, amountCents: 99_000 },
        ],
      }),
      new Map(),
      octobre,
    )
    assert.deepEqual(
      lines.map((line) => [line.description, line.periodStart, line.unitPriceCents, line.prorataNumerator]),
      [
        ['Bureau privatif — contrat CT-2026-0001', '2026-10-01', 90_000, 14],
        ['Bureau privatif — contrat CT-2026-0001, avenant n° 1', '2026-10-15', 99_000, 17],
      ],
    )
  })

  it('tombe au centime de l’échéancier du contrat, quelle que soit la règle de prorata', () => {
    const versions = [
      { amendmentId: null, amendmentNumber: null, startsOn: '2026-01-01', endsOn: '2026-10-14', amountCents: 90_000 },
      { amendmentId: 'a1', amendmentNumber: 1, startsOn: '2026-10-15', endsOn: null, amountCents: 99_000 },
    ]
    for (const prorataRule of ['calendar_days', 'thirty_day_month', 'none'] as const) {
      const { lines } = contractInvoiceLines(contrat({ versions }), new Map(), { ...octobre, prorataRule })
      const [octobreEcheancier] = contractSchedule(
        { startsOn: '2026-10-01', billingPeriod: 'monthly', amountCents: 90_000 },
        versions.map((version) => ({ ...version, startsOn: version.startsOn < '2026-10-01' ? '2026-10-01' : version.startsOn })),
        '2026-10-31',
        prorataRule,
      )
      assert.equal(
        lines.reduce((total, line) => total + net(line), 0),
        octobreEcheancier.amountCents,
        prorataRule,
      )
    }
  })

  it('sans prorata, facture la période au prix de son premier jour : l’avenant compte au mois suivant', () => {
    const versions = [
      { amendmentId: null, amendmentNumber: null, startsOn: '2026-01-01', endsOn: '2026-10-14', amountCents: 90_000 },
      { amendmentId: 'a1', amendmentNumber: 1, startsOn: '2026-10-15', endsOn: null, amountCents: 99_000 },
    ]
    const sansProrata = { ...octobre, prorataRule: 'none' as const }
    const octobreLignes = contractInvoiceLines(contrat({ versions }), new Map(), sansProrata).lines
    assert.deepEqual(
      octobreLignes.map((line) => [line.unitPriceCents, line.prorataNumerator]),
      [[90_000, null]],
    )
    const novembre = contractInvoiceLines(contrat({ versions }), new Map(), {
      ...sansProrata,
      windows: runWindows('2026-11', 'in_advance'),
    }).lines
    assert.deepEqual(
      novembre.map((line) => line.unitPriceCents),
      [99_000],
    )
  })

  it('renvoie un contrat dans une autre devise à la main', () => {
    const { lines, warnings } = contractInvoiceLines(contrat({ currency: 'CHF' }), new Map(), octobre)
    assert.deepEqual(lines, [])
    assert.match(warnings[0].message, /CHF/)
  })
})

describe('contrat à lignes (ADR 025)', () => {
  const ligne = (overrides: Partial<BillingContract['lines'][number]>): BillingContract['lines'][number] => ({
    id: 'l1',
    amendmentId: null,
    description: 'Bureau 3',
    quantity: 1,
    unit: 'month',
    unitPriceCents: 60_000,
    discountBp: null,
    discountAmountCents: null,
    vatRateBp: 2000,
    isRecurring: true,
    serviceId: null,
    resourceId: 'r3',
    position: 0,
    ...overrides,
  })
  const aLignes = contrat({
    versions: [{ amendmentId: null, amendmentNumber: null, startsOn: '2026-10-10', endsOn: null, amountCents: 65_000 }],
    lines: [
      ligne({}),
      ligne({ id: 'l2', description: 'Standard', unitPriceCents: 5_000, serviceId: 's1', resourceId: null, position: 1 }),
      ligne({ id: 'l3', description: 'Frais de dossier', unit: 'unit', unitPriceCents: 15_000, isRecurring: false, resourceId: null, position: 2 }),
    ],
  })

  it('facture ligne à ligne : loyer, forfait de service, frais ponctuels au premier jour', () => {
    const { lines } = contractInvoiceLines(aLignes, new Map(), octobre)
    assert.deepEqual(
      lines.map((line) => [line.kind, line.contractLineId, line.periodStart, line.periodEnd, line.prorataNumerator]),
      [
        ['rent', 'l1', '2026-10-10', '2026-10-31', 22],
        ['package', 'l2', '2026-10-10', '2026-10-31', 22],
        ['rent', 'l3', '2026-10-10', '2026-10-10', null],
      ],
    )
    assert.equal(lines[1].serviceId, 's1')
  })

  it('ne refacture pas des frais ponctuels déjà facturés', () => {
    const billed = new Map([[contractKey('k1', 'l3'), [{ start: '2026-10-10', end: '2026-10-10' }]]])
    const { lines } = contractInvoiceLines(aLignes, billed, octobre)
    assert.deepEqual(
      lines.map((line) => line.contractLineId),
      ['l1', 'l2'],
    )
  })

  it('ne facture les frais ponctuels qu’avec le premier morceau de leur version', () => {
    const { lines } = contractInvoiceLines(aLignes, new Map(), { ...octobre, windows: runWindows('2026-11', 'in_advance') })
    assert.deepEqual(
      lines.map((line) => line.contractLineId),
      ['l1', 'l2'],
    )
  })

  it('signale une version qui n’a que des lignes ponctuelles et un loyer', () => {
    const { lines, warnings } = contractInvoiceLines(
      contrat({ lines: [ligne({ id: 'l3', isRecurring: false })] }),
      new Map([[contractKey('k1', 'l3'), [{ start: '2026-01-01', end: '2026-01-01' }]]]),
      octobre,
    )
    assert.deepEqual(lines, [])
    assert.match(warnings[0].message, /lignes ponctuelles/)
  })
})

describe('forfaits souscrits (ADR 024)', () => {
  const standard = (overrides: Partial<BillingSubscription> = {}): BillingSubscription => ({
    id: 'sub1',
    clientId: 'c1',
    contractId: null,
    serviceId: 's1',
    serviceName: 'Standard téléphonique',
    quantity: 2,
    unit: 'month',
    unitPriceCents: 5_000,
    discountBp: 1_000,
    discountAmountCents: null,
    vatRateBp: 2000,
    currency: 'EUR',
    startsOn: '2026-10-10',
    endsOn: null,
    ...overrides,
  })

  it('facture le mois au prix figé, au prorata des jours souscrits', () => {
    const [line] = subscriptionInvoiceLines(standard(), new Map(), octobre).lines
    assert.equal(line.kind, 'package')
    assert.equal(line.subscribedServiceId, 'sub1')
    assert.equal(line.serviceId, 's1')
    assert.deepEqual([line.prorataNumerator, line.prorataDenominator], [22, 31])
    // 2 × 50 € moins 10 %, sur 22/31 : 90 € × 22/31 = 63,870… €.
    assert.equal(net(line), 6_387)
  })

  it('ne refacture pas un mois déjà facturé', () => {
    const billed = new Map([['sub1', [{ start: '2026-10-10', end: '2026-10-31' }]]])
    assert.deepEqual(subscriptionInvoiceLines(standard(), billed, octobre).lines, [])
  })

  it('facture une fois un forfait à la prestation, dans le lot de son premier jour', () => {
    const campagne = standard({ unit: 'unit', startsOn: '2026-10-05', endsOn: '2026-10-05' })
    const [line] = subscriptionInvoiceLines(campagne, new Map(), octobre).lines
    assert.deepEqual([line.periodStart, line.periodEnd, line.prorataNumerator], ['2026-10-05', '2026-10-05', null])
    assert.deepEqual(
      subscriptionInvoiceLines(campagne, new Map(), { ...octobre, windows: runWindows('2026-11', 'in_advance') }).lines,
      [],
    )
  })

  it('signale une unité que le lot ne facture pas', () => {
    const { lines, warnings } = subscriptionInvoiceLines(standard({ unit: 'day' }), new Map(), octobre)
    assert.deepEqual(lines, [])
    assert.equal(warnings.length, 1)
  })
})

describe('réservations, au prix figé (R11)', () => {
  const reservation = (overrides: Partial<BillingBooking> = {}): BillingBooking => ({
    id: 'b1',
    clientId: 'c1',
    resourceId: 'r9',
    resourceName: 'Salle Europe',
    day: '2026-09-10',
    startTime: '10:00',
    endTime: '12:00',
    quote: {
      unit: 'hour',
      quantity: 2,
      unitPriceCents: 2_500,
      discountBp: null,
      discountAmountCents: null,
      vatRateBp: 2000,
      currency: 'EUR',
    },
    held: false,
    ...overrides,
  })

  it('reprend le devis de la réservation, jamais le prix du jour', () => {
    const { line } = bookingInvoiceLine(reservation(), octobre)
    assert.ok(line)
    assert.equal(line.kind, 'booking')
    assert.equal(line.bookingId, 'b1')
    assert.equal(line.resourceId, 'r9')
    assert.equal(line.description, 'Réservation Salle Europe — 10/09/2026, 10:00–12:00')
    assert.equal(net(line), 5_000)
  })

  it('ne refacture pas une réservation déjà facturée', () => {
    assert.deepEqual(bookingInvoiceLine(reservation({ held: true }), octobre), {})
  })

  it('signale une réservation sans prix figé', () => {
    const { line, warning } = bookingInvoiceLine(reservation({ quote: null }), octobre)
    assert.equal(line, undefined)
    assert.match(warning?.message ?? '', /sans prix figé/)
  })
})

describe('actes du courrier (R14, ADR 024)', () => {
  const ouverture: BillingActService = {
    id: 'svc',
    name: 'Ouverture et numérisation',
    unitPriceCents: 300,
    vatRateBp: 2000,
    currency: 'EUR',
  }
  const abonnement = (overrides: Partial<BillingActSubscription> = {}): BillingActSubscription => ({
    id: 'sub',
    clientId: 'c1',
    includedQuantity: 2,
    unitPriceCents: 250,
    discountBp: null,
    discountAmountCents: null,
    vatRateBp: 2000,
    currency: 'EUR',
    startsOn: '2026-01-01',
    endsOn: null,
    ...overrides,
  })
  const pli = (id: string, day: string, clientId = 'c1', held = false): BillingMailItem => ({
    id,
    clientId,
    openedAt: new Date(`${day}T09:00:00Z`),
    day,
    held,
  })

  it('facture à 0 € les premiers actes inclus, mention « inclus », puis au prix de la souscription', () => {
    const { byClient } = mailActInvoiceLines(
      // Dans le désordre : le rang suit l'ordre d'ouverture.
      [pli('p3', '2026-09-05'), pli('p1', '2026-09-03'), pli('p2', '2026-09-04')],
      ouverture,
      [abonnement()],
      octobre,
    )
    const lines = byClient.get('c1') ?? []
    assert.deepEqual(
      lines.map((line) => [line.mailItemId, line.unitPriceCents, line.subscribedServiceId]),
      [
        ['p1', 0, 'sub'],
        ['p2', 0, 'sub'],
        ['p3', 250, 'sub'],
      ],
    )
    assert.match(lines[0].description, /inclus/)
    assert.doesNotMatch(lines[2].description, /inclus/)
    assert.ok(lines.every((line) => line.kind === 'act' && line.serviceId === 'svc' && line.quantity === 1))
  })

  it('compte le rang sur tous les plis de la période, déjà facturés compris', () => {
    const { byClient } = mailActInvoiceLines(
      [pli('p1', '2026-09-03', 'c1', true), pli('p2', '2026-09-04', 'c1', true), pli('p3', '2026-09-05')],
      ouverture,
      [abonnement()],
      octobre,
    )
    assert.deepEqual(
      (byClient.get('c1') ?? []).map((line) => [line.mailItemId, line.unitPriceCents]),
      [['p3', 250]],
    )
  })

  it('facture au prix du catalogue un client sans souscription', () => {
    const { byClient } = mailActInvoiceLines([pli('p9', '2026-09-20', 'c2')], ouverture, [abonnement()], octobre)
    const [line] = byClient.get('c2') ?? []
    assert.equal(line.unitPriceCents, 300)
    assert.equal(line.subscribedServiceId, null)
  })

  it('suit la souscription en vigueur le jour de l’ouverture', () => {
    const { byClient } = mailActInvoiceLines(
      [pli('p1', '2026-09-03'), pli('p2', '2026-09-20')],
      ouverture,
      [abonnement({ includedQuantity: 0, endsOn: '2026-09-15' })],
      octobre,
    )
    assert.deepEqual(
      (byClient.get('c1') ?? []).map((line) => line.unitPriceCents),
      [250, 300],
    )
  })

  it('applique la remise de la souscription, une remise en montant au plus égale au prix', () => {
    const { byClient } = mailActInvoiceLines(
      [pli('p1', '2026-09-03')],
      ouverture,
      [abonnement({ includedQuantity: null, discountAmountCents: 1_000 })],
      octobre,
    )
    const [line] = byClient.get('c1') ?? []
    assert.equal(line.discountAmountCents, 250)
    assert.equal(net(line), 0)
  })

  it('ne valorise rien sans service au catalogue, et le dit client par client', () => {
    const { byClient, warnings } = mailActInvoiceLines(
      [pli('p1', '2026-09-03'), pli('p2', '2026-09-04'), pli('p3', '2026-09-05', 'c2', true)],
      null,
      [],
      octobre,
    )
    assert.equal(byClient.size, 0)
    assert.deepEqual(warnings.map((warning) => warning.clientId), ['c1'])
    assert.match(warnings[0].message, /2 plis ouverts non valorisés/)
  })
})

describe('le lot : une facture par client (R15)', () => {
  it('réunit, par client et dans l’ordre de la facture, contrats, forfaits, réservations et actes', () => {
    const runs = computeRun(
      {
        contracts: [contrat({ id: 'k2', clientId: 'c2', reference: 'CT-B' }), contrat({ reference: 'CT-A' })],
        contractBilled: new Map(),
        subscriptions: [
          {
            id: 'sub1',
            clientId: 'c1',
            contractId: null,
            serviceId: 's1',
            serviceName: 'Standard',
            quantity: 1,
            unit: 'month',
            unitPriceCents: 5_000,
            discountBp: null,
            discountAmountCents: null,
            vatRateBp: 2000,
            currency: 'EUR',
            startsOn: '2026-01-01',
            endsOn: null,
          },
        ],
        subscriptionBilled: new Map(),
        bookings: [
          {
            id: 'b1',
            clientId: 'c1',
            resourceId: 'r9',
            resourceName: 'Salle',
            day: '2026-09-10',
            startTime: '10:00',
            endTime: '11:00',
            quote: { unit: 'hour', quantity: 1, unitPriceCents: 2_500, discountBp: null, discountAmountCents: null, vatRateBp: 2000, currency: 'EUR' },
            held: false,
          },
        ],
        mailItems: [{ id: 'p1', clientId: 'c1', openedAt: new Date('2026-09-03T09:00:00Z'), day: '2026-09-03', held: false }],
        actService: { id: 'svc', name: 'Ouverture', unitPriceCents: 300, vatRateBp: 2000, currency: 'EUR' },
        actSubscriptions: [],
      },
      octobre,
    )
    const c1 = runs.find((run) => run.clientId === 'c1')
    const c2 = runs.find((run) => run.clientId === 'c2')
    assert.deepEqual(
      c1?.lines.map((line) => line.kind),
      ['rent', 'package', 'booking', 'act'],
    )
    assert.deepEqual(
      c2?.lines.map((line) => line.description),
      ['Bureau privatif — contrat CT-B'],
    )
  })
})

describe('mode de paiement attendu (ADR 027)', () => {
  it('prélève le client qui a un mandat actif', () => {
    assert.deepEqual(expectedPaymentFor('transfer', 'm1'), { method: 'direct_debit', sepaMandateId: 'm1' })
  })

  it('sinon le mode du centre, et le virement si ce mode est un prélèvement sans mandat', () => {
    assert.deepEqual(expectedPaymentFor('transfer', null), { method: 'transfer', sepaMandateId: null })
    assert.deepEqual(expectedPaymentFor('other', null), { method: 'other', sepaMandateId: null })
    assert.deepEqual(expectedPaymentFor('direct_debit', null), { method: 'transfer', sepaMandateId: null })
  })
})

describe('TVA par taux, pas ligne à ligne (ADR 026)', () => {
  const libre = (unitPriceCents: number, vatRateBp = 2000): InvoiceLineDraft => ({
    kind: 'other',
    description: 'Prestation',
    periodStart: null,
    periodEnd: null,
    quantity: 1,
    unit: 'unit',
    unitPriceCents,
    discountBp: null,
    discountAmountCents: null,
    prorataNumerator: null,
    prorataDenominator: null,
    vatRateBp,
    vatCategory: vatCategoryFor(vatRateBp),
    contractId: null,
    contractLineId: null,
    bookingId: null,
    subscribedServiceId: null,
    mailItemId: null,
    serviceId: null,
    resourceId: null,
  })

  it('calcule la TVA sur la somme des bases : trois lignes de 0,33 € font 0,20 €, pas 0,21 €', () => {
    const lines = [libre(33), libre(33), libre(33)]
    // Ligne à ligne : 0,066 € arrondi à 0,07 €, trois fois.
    assert.equal(lines.reduce((sum, line) => sum + vatAmountCents(net(line), line.vatRateBp), 0), 21)
    const amounts = previewAmounts(lines)
    assert.equal(amounts.totalTaxCents, 20)
    assert.equal(amounts.totalInclTaxCents, 119)
    // Les TVA des lignes tombent sur celle du taux : l'écart va à une seule ligne.
    assert.equal([...amounts.lineVatCents.values()].reduce((sum, vat) => sum + vat, 0), 20)
  })

  it('ventile par taux, une base par taux', () => {
    const amounts = previewAmounts([libre(10_000), libre(1_500, 1_000), libre(2_000), libre(5_000, 0)])
    assert.deepEqual(
      amounts.breakdown.map((row) => [row.vatCategory, row.vatRateBp, row.taxableAmountCents, row.vatAmountCents]),
      [
        ['S', 2000, 12_000, 2_400],
        ['S', 1000, 1_500, 150],
        ['E', 0, 5_000, 0],
      ],
    )
    assert.equal(amounts.totalExclTaxCents, 18_500)
    assert.equal(amounts.totalTaxCents, 2_550)
  })

  it('classe un taux nul en exonération, un taux positif au taux normal', () => {
    assert.equal(vatCategoryFor(0), 'E')
    assert.equal(vatCategoryFor(550), 'S')
  })
})
