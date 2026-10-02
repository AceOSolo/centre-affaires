import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  bookingInvoiceLine,
  computeRun,
  contractInvoiceLines,
  contractKey,
  expectedPaymentFor,
  mailActInvoiceLines,
  mailRequestInvoiceLines,
  postageInvoiceLines,
  previewAmounts,
  subscriptionInvoiceLines,
  vatCategoryFor,
  type BillingActService,
  type BillingActSubscription,
  type BillingBooking,
  type BillingContract,
  type BillingMailItem,
  type BillingMailRequest,
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

  it('facture le loyer d’une version qui n’a que des lignes ponctuelles, à côté d’elles (ADR 032)', () => {
    const fraisSeuls = contrat({
      versions: [{ amendmentId: null, amendmentNumber: null, startsOn: '2026-10-10', endsOn: null, amountCents: 65_000 }],
      lines: [ligne({ id: 'l3', description: 'Frais de dossier', unit: 'unit', unitPriceCents: 15_000, isRecurring: false })],
    })
    const { lines, warnings } = contractInvoiceLines(fraisSeuls, new Map(), octobre)
    assert.deepEqual(warnings, [])
    assert.deepEqual(
      lines.map((line) => [line.kind, line.contractLineId, line.periodStart, line.periodEnd, line.unitPriceCents]),
      [
        ['rent', null, '2026-10-10', '2026-10-31', 65_000],
        ['rent', 'l3', '2026-10-10', '2026-10-10', 15_000],
      ],
    )
    // Le mois suivant, le loyer seul.
    const novembre = contractInvoiceLines(fraisSeuls, new Map(), { ...octobre, windows: runWindows('2026-11', 'in_advance') })
    assert.deepEqual(
      novembre.lines.map((line) => [line.contractLineId, line.periodStart]),
      [[null, '2026-11-01']],
    )
  })

  it('facture chaque ligne d’une même version pour son compte : celle qu’un avoir a libérée revient seule', () => {
    // l1 tient octobre ; l2 a été créditée (libérée) : elle seule est à refacturer.
    const billed = new Map([[contractKey('k1', 'l1'), [{ start: '2026-10-10', end: '2026-10-31' }]]])
    const { lines } = contractInvoiceLines(aLignes, billed, octobre)
    assert.deepEqual(
      lines.map((line) => line.contractLineId),
      ['l2', 'l3'],
    )
  })
})

describe('avenant signé après la facturation de sa période (ADR 032)', () => {
  const ligneDe = (id: string, amendmentId: string | null, unitPriceCents: number): BillingContract['lines'][number] => ({
    id,
    amendmentId,
    description: 'Bureau 3',
    quantity: 3,
    unit: 'month',
    unitPriceCents,
    discountBp: null,
    discountAmountCents: null,
    vatRateBp: 2000,
    isRecurring: true,
    serviceId: null,
    resourceId: 'r3',
    position: 0,
  })

  it('ne refacture pas le trimestre à échoir déjà facturé aux lignes de l’ancienne version', () => {
    // T1 facturé en janvier avec L0 (01/01–31/03) ; avenant à lignes au 01/03, signé en février.
    const trimestriel = contrat({
      billingPeriod: 'quarterly',
      versions: [
        { amendmentId: null, amendmentNumber: null, startsOn: '2026-01-01', endsOn: '2026-02-28', amountCents: 270_000 },
        { amendmentId: 'a1', amendmentNumber: 1, startsOn: '2026-03-01', endsOn: null, amountCents: 297_000 },
      ],
      lines: [ligneDe('L0', null, 90_000), ligneDe('L1', 'a1', 99_000)],
    })
    const billed = new Map([[contractKey('k1', 'L0'), [{ start: '2026-01-01', end: '2026-03-31' }]]])
    const mars = { ...octobre, windows: runWindows('2026-03', 'in_advance') }
    assert.deepEqual(contractInvoiceLines(trimestriel, billed, mars).lines, [])
    // Le trimestre suivant se facture à la nouvelle version.
    const avril = contractInvoiceLines(trimestriel, billed, { ...mars, windows: runWindows('2026-04', 'in_advance') }).lines
    assert.deepEqual(
      avril.map((line) => [line.contractLineId, line.periodStart, line.periodEnd, line.prorataNumerator]),
      [['L1', '2026-04-01', '2026-06-30', null]],
    )
  })

  it('ne refacture rien quand on rejoue le mois après un avenant pris en cours de mois', () => {
    const mensuel = contrat({
      versions: [
        { amendmentId: null, amendmentNumber: null, startsOn: '2026-01-01', endsOn: '2026-10-14', amountCents: 90_000 },
        { amendmentId: 'a1', amendmentNumber: 1, startsOn: '2026-10-15', endsOn: null, amountCents: 99_000 },
      ],
      lines: [ligneDe('L0', null, 30_000), ligneDe('L1', 'a1', 33_000)],
    })
    const octobreFacture = new Map([[contractKey('k1', 'L0'), [{ start: '2026-10-01', end: '2026-10-31' }]]])
    for (const prorataRule of ['calendar_days', 'thirty_day_month', 'none'] as const) {
      assert.deepEqual(contractInvoiceLines(mensuel, octobreFacture, { ...octobre, prorataRule }).lines, [], prorataRule)
    }
    // Seuls les jours qu'aucune version n'a facturés restent dus.
    const moitie = new Map([[contractKey('k1', 'L0'), [{ start: '2026-10-01', end: '2026-10-20' }]]])
    assert.deepEqual(
      contractInvoiceLines(mensuel, moitie, octobre).lines.map((line) => [line.contractLineId, line.periodStart, line.periodEnd]),
      [['L1', '2026-10-21', '2026-10-31']],
    )
  })

  it('ne refacture pas entre une version à montant et une version à lignes, dans les deux sens', () => {
    const versions = [
      { amendmentId: null, amendmentNumber: null, startsOn: '2026-01-01', endsOn: '2026-10-14', amountCents: 90_000 },
      { amendmentId: 'a1', amendmentNumber: 1, startsOn: '2026-10-15', endsOn: null, amountCents: 99_000 },
    ]
    // Version initiale à montant (loyer global), avenant à lignes.
    const versLignes = contrat({ versions, lines: [ligneDe('L1', 'a1', 33_000)] })
    const loyerGlobal = new Map([[contractKey('k1', null), [{ start: '2026-10-01', end: '2026-10-31' }]]])
    assert.deepEqual(contractInvoiceLines(versLignes, loyerGlobal, octobre).lines, [])
    // Version initiale à lignes, avenant à montant.
    const versMontant = contrat({ versions, lines: [ligneDe('L0', null, 30_000)] })
    const ligneInitiale = new Map([[contractKey('k1', 'L0'), [{ start: '2026-10-01', end: '2026-10-31' }]]])
    assert.deepEqual(contractInvoiceLines(versMontant, ligneInitiale, octobre).lines, [])
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

  describe('changement de conditions en cours de mois (ADR 032)', () => {
    // S1 du 01/01 au 14/10 à 100 €, S2 à partir du 15/10 à 120 € : la même chaîne.
    const s1 = standard({ id: 'S1', quantity: 1, discountBp: null, unitPriceCents: 10_000, startsOn: '2026-01-01', endsOn: '2026-10-14' })
    const s2 = standard({ id: 'S2', quantity: 1, discountBp: null, unitPriceCents: 12_000, startsOn: '2026-10-15', endsOn: null })
    const sources = (subscriptionBilled: Map<string, { start: string; end: string }[]> = new Map()) => ({
      contracts: [],
      contractBilled: new Map(),
      subscriptions: [s2, s1],
      subscriptionBilled,
      bookings: [],
      mailItems: [],
      actService: null,
      actSubscriptions: [],
    })
    const forfaits = (runs: ReturnType<typeof computeRun>) =>
      runs.flatMap((run) => run.lines).map((line) => [line.subscribedServiceId, line.periodStart, line.periodEnd, net(line)])
    const sansProrata = { ...octobre, prorataRule: 'none' as const }

    it('sans prorata, facture le mois une seule fois, au prix de la souscription de son premier jour', () => {
      assert.deepEqual(forfaits(computeRun(sources(), sansProrata)), [['S1', '2026-10-01', '2026-10-14', 10_000]])
      // La nouvelle souscription compte à partir du mois suivant.
      assert.deepEqual(
        forfaits(computeRun(sources(), { ...sansProrata, windows: runWindows('2026-11', 'in_advance') })),
        [['S2', '2026-11-01', '2026-11-30', 12_000]],
      )
      // Rejoué, le mois déjà facturé ne revient pas.
      const facture = new Map([['S1', [{ start: '2026-10-01', end: '2026-10-14' }]]])
      assert.deepEqual(forfaits(computeRun(sources(facture), sansProrata)), [])
    })

    it('à terme échu aussi', () => {
      const echu = { ...sansProrata, windows: runWindows('2026-11', 'in_arrears'), timing: 'in_arrears' as const }
      assert.deepEqual(forfaits(computeRun(sources(), echu)), [['S1', '2026-10-01', '2026-10-14', 10_000]])
    })

    it('au prorata, chaque souscription pour ses jours', () => {
      assert.deepEqual(forfaits(computeRun(sources(), octobre)), [
        ['S1', '2026-10-01', '2026-10-14', 4_516],
        ['S2', '2026-10-15', '2026-10-31', 6_581],
      ])
    })

    it('ne lie pas deux services différents', () => {
      const autre = { ...s2, id: 'S3', serviceId: 's2' }
      const runs = computeRun({ ...sources(), subscriptions: [s1, autre] }, sansProrata)
      assert.deepEqual(forfaits(runs), [
        ['S1', '2026-10-01', '2026-10-14', 10_000],
        ['S3', '2026-10-15', '2026-10-31', 12_000],
      ])
    })
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

describe('demandes de courrier faites (R21, ADR 037)', () => {
  const numerisation: BillingActService = {
    id: 'svc-scan',
    name: 'Numérisation d’un pli',
    unitPriceCents: 200,
    vatRateBp: 2000,
    currency: 'EUR',
  }
  const reexpedition: BillingActService = {
    id: 'svc-fwd',
    name: 'Réexpédition d’un pli',
    unitPriceCents: 500,
    vatRateBp: 2000,
    currency: 'EUR',
  }
  const forfait = (overrides: Partial<BillingActSubscription> = {}): BillingActSubscription => ({
    id: 'sub-scan',
    clientId: 'c1',
    includedQuantity: 1,
    unitPriceCents: 150,
    discountBp: null,
    discountAmountCents: null,
    vatRateBp: 2000,
    currency: 'EUR',
    startsOn: '2026-01-01',
    endsOn: null,
    ...overrides,
  })
  const demande = (
    id: string,
    kind: BillingMailRequest['kind'],
    day: string,
    overrides: Partial<BillingMailRequest> = {},
  ): BillingMailRequest => ({
    id,
    clientId: 'c1',
    kind,
    completedAt: new Date(`${day}T10:00:00Z`),
    day,
    held: false,
    ...overrides,
  })

  it('facture les numérisations faites : les inclus du forfait à 0 €, puis son prix, chacune par sa demande', () => {
    const { byClient, warnings } = mailRequestInvoiceLines(
      [demande('n2', 'scan', '2026-09-12'), demande('n1', 'scan', '2026-09-02'), demande('r1', 'forward', '2026-09-05')],
      'scan',
      numerisation,
      [forfait()],
      octobre,
    )
    assert.deepEqual(warnings, [])
    const lines = byClient.get('c1') ?? []
    assert.deepEqual(
      lines.map((line) => [line.mailRequestId, line.unitPriceCents, line.serviceId, line.mailItemId]),
      [
        ['n1', 0, 'svc-scan', null],
        ['n2', 150, 'svc-scan', null],
      ],
    )
    assert.equal(lines[0].description, 'Numérisation d’un pli — numérisation du 02/09/2026, inclus')
    assert.ok(lines.every((line) => line.kind === 'act' && line.quantity === 1 && line.subscribedServiceId === 'sub-scan'))
  })

  it('compte les inclus sur toutes les demandes de la période, et ne refacture pas une demande tenue', () => {
    const { byClient } = mailRequestInvoiceLines(
      [demande('n1', 'scan', '2026-09-02', { held: true }), demande('n2', 'scan', '2026-09-12')],
      'scan',
      numerisation,
      [forfait()],
      octobre,
    )
    // n1 a pris l'inclus du mois : n2 est due, au prix du forfait.
    assert.deepEqual(
      (byClient.get('c1') ?? []).map((line) => [line.mailRequestId, line.unitPriceCents]),
      [['n2', 150]],
    )
  })

  it('facture une réexpédition au catalogue, ses frais relevés', () => {
    const { byClient, warnings } = mailRequestInvoiceLines(
      [demande('r1', 'forward', '2026-09-05', { postageRecorded: true })],
      'forward',
      reexpedition,
      [],
      octobre,
    )
    assert.deepEqual(warnings, [])
    const [line] = byClient.get('c1') ?? []
    assert.deepEqual([line.kind, line.mailRequestId, line.unitPriceCents, line.subscribedServiceId], ['act', 'r1', 500, null])
    assert.equal(line.description, 'Réexpédition d’un pli — réexpédition du 05/09/2026')
  })

  it('fait attendre une réexpédition sans frais relevés, à sa place dans le rang des inclus', () => {
    const inclusUne = [forfait({ id: 'sub-fwd', unitPriceCents: 400 })]
    // r1, la première du mois, attend ses frais : r2 est due au prix du forfait.
    const premier = mailRequestInvoiceLines(
      [
        demande('r1', 'forward', '2026-09-02', { postageRecorded: false }),
        demande('r2', 'forward', '2026-09-20', { postageRecorded: true }),
      ],
      'forward',
      reexpedition,
      inclusUne,
      octobre,
    )
    assert.deepEqual(
      (premier.byClient.get('c1') ?? []).map((line) => [line.mailRequestId, line.unitPriceCents]),
      [['r2', 400]],
    )
    assert.equal(premier.warnings.length, 1)
    assert.match(premier.warnings[0].message, /1 réexpédition non facturée : frais d’affranchissement non relevés/)

    // Ses frais notés (0 s'il n'y en a pas), le lot rejoué la facture : l'inclus du mois.
    const rejoue = mailRequestInvoiceLines(
      [
        demande('r1', 'forward', '2026-09-02', { postageRecorded: true }),
        demande('r2', 'forward', '2026-09-20', { postageRecorded: true, held: true }),
      ],
      'forward',
      reexpedition,
      inclusUne,
      octobre,
    )
    assert.deepEqual(
      (rejoue.byClient.get('c1') ?? []).map((line) => [line.mailRequestId, line.unitPriceCents]),
      [['r1', 0]],
    )
    assert.deepEqual(rejoue.warnings, [])
  })

  it('ne valorise rien sans service au catalogue, et le dit client par client', () => {
    const { byClient, warnings } = mailRequestInvoiceLines(
      [demande('n1', 'scan', '2026-09-02'), demande('n2', 'scan', '2026-09-03', { clientId: 'c2', held: true })],
      'scan',
      null,
      [],
      octobre,
    )
    assert.equal(byClient.size, 0)
    assert.deepEqual(warnings.map((warning) => warning.clientId), ['c1'])
    assert.match(warnings[0].message, /1 numérisation non valorisée : aucun service de code « courrier\.numerisation »/)
  })

  it('refacture les frais d’affranchissement au centime relevé, une fois, sans remise ni prorata', () => {
    const { byClient, warnings } = postageInvoiceLines(
      [{ requestId: 'r1', clientId: 'c1', day: '2026-09-28', postageCents: 435, currency: 'EUR' }],
      reexpedition,
      octobre,
    )
    assert.deepEqual(warnings, [])
    const [line] = byClient.get('c1') ?? []
    assert.deepEqual(
      [line.kind, line.mailRequestId, line.quantity, line.unitPriceCents, line.discountBp, line.discountAmountCents, line.prorataNumerator],
      ['other', 'r1', 1, 435, null, null, null],
    )
    assert.equal(line.description, 'Frais d’affranchissement — réexpédition du 28/09/2026')
    // Frais accessoires : la TVA de la réexpédition (à valider, ADR 037).
    assert.equal(line.vatRateBp, 2000)
    assert.equal(line.serviceId, null)
    assert.equal(net(line), 435)
  })

  it('renvoie à la main des frais dans une autre devise, ou sans service pour en fixer la TVA', () => {
    const autreDevise = postageInvoiceLines(
      [{ requestId: 'r1', clientId: 'c1', day: '2026-09-05', postageCents: 900, currency: 'CHF' }],
      reexpedition,
      octobre,
    )
    assert.equal(autreDevise.byClient.size, 0)
    assert.match(autreDevise.warnings[0].message, /en CHF : à facturer à la main/)

    const sansService = postageInvoiceLines(
      [{ requestId: 'r1', clientId: 'c1', day: '2026-09-05', postageCents: 900, currency: 'EUR' }],
      null,
      octobre,
    )
    assert.equal(sansService.byClient.size, 0)
    assert.match(sansService.warnings[0].message, /non facturés : aucun service de code « courrier\.reexpedition »/)
  })

  it('place les demandes après les plis ouverts, sur la facture du client', () => {
    const runs = computeRun(
      {
        contracts: [],
        contractBilled: new Map(),
        subscriptions: [],
        subscriptionBilled: new Map(),
        bookings: [],
        mailItems: [{ id: 'p1', clientId: 'c1', openedAt: new Date('2026-09-03T09:00:00Z'), day: '2026-09-03', held: false }],
        actService: { id: 'svc', name: 'Ouverture', unitPriceCents: 300, vatRateBp: 2000, currency: 'EUR' },
        actSubscriptions: [],
        mailRequests: [
          demande('r1', 'forward', '2026-09-05', { postageRecorded: true }),
          demande('n1', 'scan', '2026-09-04'),
        ],
        requestServices: { scan: numerisation, forward: reexpedition },
        requestSubscriptions: { scan: [], forward: [] },
        postages: [{ requestId: 'r1', clientId: 'c1', day: '2026-09-05', postageCents: 435, currency: 'EUR' }],
      },
      octobre,
    )
    const [c1] = runs
    assert.deepEqual(
      c1.lines.map((line) => [line.kind, line.mailItemId ?? line.mailRequestId]),
      [
        ['act', 'p1'],
        ['act', 'n1'],
        ['act', 'r1'],
        ['other', 'r1'],
      ],
    )
    assert.deepEqual(c1.warnings, [])
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
    mailRequestId: null,
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
