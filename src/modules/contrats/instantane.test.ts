import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildContractSnapshot,
  CONTRACT_SNAPSHOT_SCHEMA,
  readContractSnapshot,
  type SnapshotInput,
} from './instantane.ts'

/**
 * Instantané d'un document de contrat (R12, ADR 025) : tout ce que le
 * document montre y est copié, libellés compris, pour qu'il se rende tel
 * qu'il a été remis, sans relire le contrat ni le centre.
 */
const entree = (overrides: Partial<SnapshotInput> = {}): SnapshotInput => ({
  issuedOn: '2026-03-01',
  tenant: {
    name: 'Centre d’affaires',
    legalName: 'Domotop SAS',
    legalForm: 'SAS',
    shareCapitalCents: 1_000_000,
    siren: '123456789',
    siret: '12345678900012',
    vatNumber: 'FR12123456789',
    rcsCity: 'Vienne',
    addressLine1: '1 rue des Affaires',
    addressLine2: null,
    postalCode: '38200',
    city: 'Vienne',
    country: 'FR',
    email: 'contact@centre.fr',
    phone: null,
    prorataRule: 'calendar_days',
    recurringBillingTiming: 'in_advance',
    invoicePaymentTermsDays: 30,
    latePaymentPenaltyText: 'Pénalités de retard : trois fois le taux légal.',
    recoveryIndemnityCents: 4000,
    earlyPaymentDiscountText: 'Pas d’escompte.',
    vatOnDebits: false,
  },
  client: {
    name: 'Acme SAS',
    legalForm: 'SAS',
    siret: '98765432100011',
    vatNumber: null,
    addressLine1: '2 avenue du Client',
    addressLine2: 'Bâtiment B',
    postalCode: '69001',
    city: 'Lyon',
    country: 'FR',
    email: null,
    phone: null,
  },
  contract: {
    reference: 'CT-2026-0001',
    contractType: 'bureau',
    startsOn: '2026-03-01',
    endsOn: null,
    billingPeriod: 'monthly',
    currency: 'EUR',
    noticeDays: 90,
    commitmentMonths: 12,
    commitmentEndsOn: '2027-02-28',
    tacitRenewal: false,
    renewalMonths: null,
    amountCents: 107_000,
    vatRateBp: 2000,
  },
  offerName: 'Bureau Premium',
  resource: { code: 'BUR-A1', name: 'Bureau 1', resourceType: 'bureau' },
  lines: [
    {
      description: 'Bureau 1',
      targetLabel: 'Bureau 1 (BUR-A1)',
      quantity: 1,
      unit: 'month',
      unitPriceCents: 80_000,
      discountBp: null,
      discountAmountCents: null,
      vatRateBp: 2000,
      netAmountCents: 80_000,
      isRecurring: true,
    },
    {
      description: 'Postes de coworking',
      targetLabel: 'Bureau',
      quantity: 2,
      unit: 'month',
      unitPriceCents: 15_000,
      discountBp: 1000,
      discountAmountCents: null,
      vatRateBp: 2000,
      netAmountCents: 27_000,
      isRecurring: true,
    },
    {
      description: 'Frais de dossier',
      targetLabel: null,
      quantity: 1,
      unit: 'unit',
      unitPriceCents: 5_000,
      discountBp: null,
      discountAmountCents: null,
      vatRateBp: 2000,
      netAmountCents: 5_000,
      isRecurring: false,
    },
  ],
  versionAmountCents: 107_000,
  subscriptions: [
    {
      serviceName: 'Numérisation',
      includedQuantity: 10,
      quantity: 1,
      unit: 'unit',
      unitPriceCents: 150,
      discountBp: null,
      discountAmountCents: null,
      vatRateBp: 2000,
      startsOn: '2026-03-01',
      endsOn: null,
    },
  ],
  amendment: null,
  ...overrides,
})

describe('instantané d’un contrat', () => {
  it('copie les parties, l’objet, les lignes et les conditions, libellés compris', () => {
    const snapshot = buildContractSnapshot(entree())
    assert.equal(snapshot.schema, CONTRACT_SNAPSHOT_SCHEMA)
    assert.equal(snapshot.kind, 'contract')
    assert.equal(snapshot.seller.name, 'Domotop SAS')
    assert.deepEqual(snapshot.seller.address, ['1 rue des Affaires', '38200 Vienne'])
    assert.equal(snapshot.seller.city, 'Vienne')
    assert.equal(snapshot.buyer.siren, '987654321')
    assert.deepEqual(snapshot.buyer.address, ['2 avenue du Client', 'Bâtiment B', '69001 Lyon'])
    assert.equal(snapshot.contract.contractTypeLabel, 'Bureau privatif')
    assert.equal(snapshot.contract.billingPeriodLabel, 'Mensuelle')
    assert.equal(snapshot.contract.offerName, 'Bureau Premium')
    assert.deepEqual(snapshot.resource, { code: 'BUR-A1', name: 'Bureau 1', typeLabel: 'Bureau' })
    assert.equal(snapshot.price.lines[1].unitLabel, 'Au mois')
    assert.equal(snapshot.subscriptions[0].includedQuantity, 10)
    assert.equal(snapshot.conditions.paymentTermsDays, 30)
    assert.match(snapshot.conditions.prorataLabel, /nombre réel de jours/)
    assert.equal(snapshot.amendment, null)
  })

  it('totalise le récurrent et le ponctuel, TVA par taux', () => {
    const { price } = buildContractSnapshot(entree())
    assert.equal(price.amountCents, 107_000)
    assert.equal(price.totals.recurringVatCents, 21_400)
    assert.equal(price.totals.recurringGrossCents, 128_400)
    assert.equal(price.totals.oneOffNetCents, 5_000)
  })

  it('présente une version sans ligne en une redevance, à la TVA du contrat', () => {
    const { price } = buildContractSnapshot(
      entree({ lines: [], versionAmountCents: 90_000, contract: { ...entree().contract, vatRateBp: 1000 } }),
    )
    assert.equal(price.lines.length, 1)
    assert.equal(price.lines[0].description, 'Redevance — bureau privatif')
    assert.equal(price.lines[0].netAmountCents, 90_000)
    assert.equal(price.totals.recurringVatCents, 9_000)
  })

  it('décrit un avenant : numéro, date d’effet, ressource avant et après', () => {
    const snapshot = buildContractSnapshot(
      entree({
        resource: { code: 'BUR-A2', name: 'Bureau 2', resourceType: 'bureau' },
        amendment: {
          number: 1,
          effectiveOn: '2026-05-01',
          reason: 'Passage au bureau 2',
          priceChanged: false,
          changesResource: true,
          previousResource: { code: 'BUR-A1', name: 'Bureau 1', resourceType: 'bureau' },
        },
      }),
    )
    assert.equal(snapshot.kind, 'amendment')
    assert.equal(snapshot.amendment?.number, 1)
    assert.equal(snapshot.amendment?.previousResource?.code, 'BUR-A1')
    assert.equal(snapshot.resource?.code, 'BUR-A2')
  })

  it('ne copie pas les notes internes du contrat dans le document remis', () => {
    const contract = { ...entree().contract, notes: 'Client difficile' } as SnapshotInput['contract']
    assert.doesNotMatch(JSON.stringify(buildContractSnapshot(entree({ contract }))), /Client difficile/)
  })

  it('est déterministe : les mêmes données donnent le même document', () => {
    assert.equal(
      JSON.stringify(buildContractSnapshot(entree())),
      JSON.stringify(buildContractSnapshot(entree())),
    )
  })
})

describe('relecture d’un instantané archivé', () => {
  it('accepte la forme qu’il a écrite, une fois passée par JSON', () => {
    const stored = JSON.parse(JSON.stringify(buildContractSnapshot(entree())))
    assert.ok(readContractSnapshot(stored))
  })

  it('refuse une forme inconnue au lieu de la rendre de travers', () => {
    assert.equal(readContractSnapshot({ v: 1 }), undefined)
    assert.equal(readContractSnapshot({ ...buildContractSnapshot(entree()), schema: 'contrat/2' }), undefined)
    assert.equal(readContractSnapshot(null), undefined)
  })
})
