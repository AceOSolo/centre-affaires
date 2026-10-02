import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EN16931_SPECIFICATION,
  basisPointsToPercent,
  centsToDecimal,
  checkEn16931,
  decimalToCents,
  en16931Summary,
  toEn16931,
  type En16931Source,
} from './en16931.ts'

/**
 * Représentation EN 16931 d'une facture émise et vérification de complétude
 * (R16, ADR 026, ADR 030) : les termes BT-* principaux, les règles
 * arithmétiques BR-CO-*, ce que la réforme française exige en plus.
 */
const seller = {
  legalName: 'Centre de démonstration SAS',
  legalForm: 'SAS',
  shareCapitalCents: 1_000_000,
  siren: '123456789',
  siret: '12345678900012',
  vatNumber: 'FR32123456789',
  rcsCity: 'Vienne',
  addressLine1: '1 rue de l’Exemple',
  addressLine2: null,
  postalCode: '38070',
  city: 'Saint-Quentin-Fallavier',
  country: 'FR',
  email: 'compta@centre.fr',
  phone: null,
  websiteUrl: null,
  bankIban: 'FR7630006000011234567890189',
  bankBic: 'AGRIFRPP',
  sepaCreditorId: 'FR12ZZZ123456',
}

const buyer = {
  name: 'Atelier Durand',
  legalForm: 'SARL',
  siret: '98765432100015',
  siren: '987654321',
  vatNumber: null,
  addressLine1: '2 place du Marché',
  addressLine2: null,
  postalCode: '38000',
  city: 'Grenoble',
  country: 'FR',
  email: null,
  accountingCode: null,
}

const mentions = {
  paymentTermsDays: 30,
  latePaymentPenaltyText: 'Pénalités de retard : taux BCE majoré de 10 points.',
  recoveryIndemnityCents: 4_000,
  earlyPaymentDiscountText: 'Pas d’escompte pour paiement anticipé.',
  vatOnDebits: false,
  operationCategory: 'services' as const,
  footerText: null,
  creditedInvoiceNumber: null,
}

const line = (values: Partial<En16931Source['lines'][number]> = {}): En16931Source['lines'][number] => ({
  id: 'l1',
  position: 0,
  kind: 'rent',
  description: 'Loyer bureau B12 — septembre 2026',
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  quantity: 1,
  unit: 'month',
  unitPriceCents: 90_000,
  discountBp: null,
  discountAmountCents: null,
  prorataNumerator: null,
  prorataDenominator: null,
  netAmountCents: 90_000,
  vatRateBp: 2000,
  vatCategory: 'S',
  vatExemptionReason: null,
  vatAmountCents: 18_000,
  ...values,
})

/**
 * Loyer prorata 22/31 avec 10 % de remise (57 484 HT), trois ouvertures de
 * pli à 3 €, une remise de 10 € en pied : 58 384 HT, 11 677 de TVA.
 */
const source = (values: Partial<En16931Source['invoice']> = {}, lines = [
  line({
    discountBp: 1000,
    prorataNumerator: 22,
    prorataDenominator: 31,
    netAmountCents: 57_484,
    vatAmountCents: 11_497,
  }),
  line({
    id: 'l2',
    position: 1,
    kind: 'act',
    description: 'Ouverture et numérisation du courrier',
    periodStart: null,
    periodEnd: null,
    quantity: 3,
    unit: 'unit',
    unitPriceCents: 300,
    netAmountCents: 900,
    vatAmountCents: 180,
  }),
  line({
    id: 'l3',
    position: 2,
    kind: 'discount',
    description: 'Remise de bienvenue',
    periodStart: null,
    periodEnd: null,
    quantity: 1,
    unit: null,
    unitPriceCents: -1_000,
    netAmountCents: -1_000,
    vatAmountCents: -200,
  }),
]): En16931Source => ({
  invoice: {
    kind: 'invoice',
    number: 'FA-2026-0001',
    issueDate: '2026-10-01',
    dueDate: '2026-10-31',
    paymentTermsDays: 30,
    currency: 'EUR',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    buyerReference: null,
    notes: null,
    expectedPaymentMethod: 'transfer',
    mandateReference: null,
    totalExclTaxCents: 57_384,
    totalTaxCents: 11_477,
    totalInclTaxCents: 68_861,
    sellerSnapshot: seller,
    buyerSnapshot: buyer,
    legalMentions: mentions,
    ...values,
  },
  lines,
  precedingInvoice: null,
})

describe('conversions sans flottant', () => {
  it('écrit les centimes en décimal à point, et les relit', () => {
    assert.equal(centsToDecimal(0), '0.00')
    assert.equal(centsToDecimal(5), '0.05')
    assert.equal(centsToDecimal(-50), '-0.50')
    assert.equal(centsToDecimal(123_456), '1234.56')
    assert.equal(decimalToCents('-0.50'), -50)
    assert.equal(decimalToCents('1234.56'), 123_456)
  })

  it('écrit un taux en pourcentage', () => {
    assert.equal(basisPointsToPercent(2000), '20.00')
    assert.equal(basisPointsToPercent(550), '5.50')
    assert.equal(basisPointsToPercent(210), '2.10')
    assert.equal(basisPointsToPercent(0), '0.00')
  })
})

describe('représentation EN 16931', () => {
  const doc = toEn16931(source())

  it('porte l’en-tête : numéro, dates, type, devise, spécification', () => {
    assert.equal(doc['BT-24'], EN16931_SPECIFICATION)
    assert.equal(doc['BT-1'], 'FA-2026-0001')
    assert.equal(doc['BT-2'], '2026-10-01')
    assert.equal(doc['BT-3'], '380')
    assert.equal(doc['BT-5'], 'EUR')
    assert.equal(doc['BT-9'], '2026-10-31')
    assert.equal(doc['BT-20'], 'Paiement à 30 jours à compter de la date d’émission.')
    assert.deepEqual(doc['BG-14'], { 'BT-73': '2026-09-01', 'BT-74': '2026-09-30' })
  })

  it('décrit le vendeur et l’acheteur depuis les instantanés figés', () => {
    assert.equal(doc['BG-4']['BT-27'], 'Centre de démonstration SAS')
    assert.deepEqual(doc['BG-4']['BT-30'], { value: '123456789', scheme: '0002' })
    assert.deepEqual(doc['BG-4']['BT-34'], { value: '123456789', scheme: '0225' })
    assert.equal(doc['BG-4']['BT-31'], 'FR32123456789')
    assert.equal(doc['BG-4']['BT-33'], 'SAS au capital de 10 000,00 € — RCS Vienne 123456789 — SIRET 12345678900012')
    assert.equal(doc['BG-4']['BG-5']['BT-40'], 'FR')
    assert.equal(doc['BG-7']['BT-44'], 'Atelier Durand')
    assert.deepEqual(doc['BG-7']['BT-47'], { value: '987654321', scheme: '0002' })
    assert.equal(doc['BG-7']['BG-8']['BT-37'], 'Grenoble')
  })

  it('pose les mentions obligatoires en notes codées', () => {
    assert.deepEqual(
      doc['BG-1'].map((note) => note['BT-21']),
      ['PMD', 'PMT', 'AAB'],
    )
    assert.ok(doc['BG-1'][1]['BT-22'].includes('40,00 €'))
  })

  it('décrit le paiement par virement : code 58, IBAN et BIC du centre', () => {
    assert.deepEqual(doc['BG-16'], {
      'BT-81': '58',
      'BT-82': 'Virement SEPA',
      'BT-83': 'FA-2026-0001',
      'BG-17': { 'BT-84': 'FR7630006000011234567890189', 'BT-86': 'AGRIFRPP' },
      'BG-19': null,
    })
  })

  it('porte remise et prorata d’une ligne en remise de ligne, au centime', () => {
    const [loyer, actes] = doc['BG-25']
    assert.equal(loyer['BT-126'], '1')
    assert.equal(loyer['BT-130'], 'MON')
    assert.equal(loyer['BG-29']['BT-146'], '900.00')
    assert.equal(loyer['BT-131'], '574.84')
    // BR-LIN-04 : 1 × 900,00 − 325,16 = 574,84.
    assert.deepEqual(loyer['BG-27'], [{ 'BT-136': '325.16', 'BT-139': 'Remise et prorata temporis' }])
    assert.deepEqual(loyer['BG-26'], { 'BT-134': '2026-09-01', 'BT-135': '2026-09-30' })
    assert.equal(actes['BT-129'], '3')
    assert.equal(actes['BT-130'], 'C62')
    assert.deepEqual(actes['BG-27'], [])
  })

  it('passe une ligne de remise au pied de facture : jamais de prix négatif', () => {
    assert.equal(doc['BG-25'].length, 2)
    assert.deepEqual(doc['BG-20'], [
      { 'BT-92': '10.00', 'BT-95': 'S', 'BT-96': '20.00', 'BT-97': 'Remise de bienvenue' },
    ])
    assert.deepEqual(doc['BG-22'], {
      'BT-106': '583.84',
      'BT-107': '10.00',
      'BT-108': '0.00',
      'BT-109': '573.84',
      'BT-110': '114.77',
      'BT-112': '688.61',
      'BT-113': '0.00',
      'BT-114': '0.00',
      'BT-115': '688.61',
    })
    assert.deepEqual(doc['BG-23'], [
      { 'BT-116': '573.84', 'BT-117': '114.77', 'BT-118': 'S', 'BT-119': '20.00', 'BT-120': null },
    ])
  })

  it('décrit un avoir : code 381 et facture rectifiée', () => {
    const credit = toEn16931({
      ...source({ kind: 'credit_note', number: 'AV-2026-0001', dueDate: '2026-10-01', paymentTermsDays: 0 }),
      precedingInvoice: { number: 'FA-2026-0001', issueDate: '2026-10-01' },
    })
    assert.equal(credit['BT-3'], '381')
    assert.deepEqual(credit['BG-3'], [{ 'BT-25': 'FA-2026-0001', 'BT-26': '2026-10-01' }])
  })

  it('décrit un prélèvement : code 59, RUM et ICS', () => {
    const debit = toEn16931(source({ expectedPaymentMethod: 'direct_debit', mandateReference: 'RUM-20260115-ABCDEF' }))
    assert.equal(debit['BG-16']['BT-81'], '59')
    assert.deepEqual(debit['BG-16']['BG-19'], { 'BT-89': 'RUM-20260115-ABCDEF', 'BT-90': 'FR12ZZZ123456' })
    assert.equal(debit['BG-16']['BG-17'], null)
  })
})

describe('vérification de complétude', () => {
  const failing = (doc: ReturnType<typeof toEn16931>) =>
    checkEn16931(doc)
      .filter((check) => !check.ok)
      .map((check) => check.term)

  it('déclare complète une facture émise conforme', () => {
    const checks = checkEn16931(toEn16931(source()))
    assert.deepEqual(failing(toEn16931(source())), [])
    assert.deepEqual(en16931Summary(checks), { complete: true, failures: 0 })
    assert.ok(checks.length > 20)
  })

  it('signale un brouillon : sans numéro ni date d’émission', () => {
    assert.deepEqual(failing(toEn16931(source({ number: null, issueDate: null }))), ['BT-1', 'BT-2'])
  })

  it('exige le SIREN d’un acheteur français, pas celui d’un acheteur étranger', () => {
    const french = toEn16931(source({ buyerSnapshot: { ...buyer, siret: null, siren: null } }))
    assert.deepEqual(failing(french), ['BT-47', 'BT-49'])
    const foreign = toEn16931(
      source({ buyerSnapshot: { ...buyer, siret: null, siren: null, country: 'BE', vatNumber: 'BE0123456749' } }),
    )
    assert.deepEqual(failing(foreign), [])
  })

  it('exige les identifiants du vendeur et ses coordonnées de paiement', () => {
    const doc = toEn16931(
      source({ sellerSnapshot: { ...seller, siren: '', vatNumber: '', bankIban: null, city: '' } }),
    )
    assert.deepEqual(failing(doc), ['BT-30', 'BT-31', 'BG-5', 'BT-34', 'BT-84'])
  })

  it('exige la référence de la facture rectifiée sur un avoir', () => {
    const credit = toEn16931({ ...source({ kind: 'credit_note', number: 'AV-2026-0001' }), precedingInvoice: null })
    assert.deepEqual(failing(credit), ['BT-25'])
  })

  it('exige un motif d’exonération hors taux normal', () => {
    const exempt = line({
      id: 'l9',
      position: 3,
      kind: 'other',
      description: 'Débours',
      vatRateBp: 0,
      vatCategory: 'E',
      unitPriceCents: 500,
      netAmountCents: 500,
      vatAmountCents: 0,
    })
    const base = source()
    const withExempt = (reason: string | null) =>
      toEn16931({
        ...base,
        invoice: { ...base.invoice, totalExclTaxCents: 57_884, totalInclTaxCents: 69_361 },
        lines: [...base.lines, { ...exempt, vatExemptionReason: reason }],
      })
    assert.deepEqual(failing(withExempt(null)), ['BT-120'])
    assert.deepEqual(failing(withExempt('Exonération, art. 261 du CGI')), [])
  })

  it('n’exige pas de motif au taux zéro (BR-Z-10)', () => {
    const zero = line({ vatRateBp: 0, vatCategory: 'Z', netAmountCents: 90_000, vatAmountCents: 0 })
    const doc = toEn16931(source({ totalTaxCents: 0, totalExclTaxCents: 90_000, totalInclTaxCents: 90_000 }, [zero]))
    assert.ok(!failing(doc).includes('BT-120'))
  })

  it('tolère sur un avoir l’écart d’un centime par ligne que laisse la TVA exacte d’une ligne soldée (ADR 032)', () => {
    // 33,33 € HT à 20 % : 6,67 € sur sa base, 6,66 € quand la ligne d'origine
    // portait l'écart d'arrondi de sa facture.
    const soldee = line({ netAmountCents: 3_333, unitPriceCents: 3_333, vatAmountCents: 666 })
    const totaux = { totalExclTaxCents: 3_333, totalTaxCents: 666, totalInclTaxCents: 3_999 }
    const avoir = toEn16931({
      ...source({ ...totaux, kind: 'credit_note', number: 'AV-2026-0001' }, [soldee]),
      precedingInvoice: { number: 'FA-2026-0001', issueDate: '2026-10-01' },
    })
    assert.ok(!failing(avoir).includes('BR-CO-17'))
    // Une facture, elle, tombe au centime de base × taux.
    assert.ok(failing(toEn16931(source(totaux, [soldee]))).includes('BR-CO-17'))
    // Et l'avoir ne s'écarte pas de plus d'un centime par ligne.
    const ecart = line({ netAmountCents: 3_333, unitPriceCents: 3_333, vatAmountCents: 665 })
    const avoirFaux = toEn16931({
      ...source({ ...totaux, totalTaxCents: 665, totalInclTaxCents: 3_998, kind: 'credit_note', number: 'AV-2026-0002' }, [ecart]),
      precedingInvoice: { number: 'FA-2026-0001', issueDate: '2026-10-01' },
    })
    assert.ok(failing(avoirFaux).includes('BR-CO-17'))
  })

  it('vérifie les totaux au centime (BR-CO-*)', () => {
    const doc = toEn16931(source({ totalTaxCents: 11_478, totalInclTaxCents: 68_862 }))
    assert.deepEqual(failing(doc), ['BR-CO-14'])
    const wrongVat = toEn16931(
      source({}, [line({ netAmountCents: 1_001, unitPriceCents: 1_001, vatAmountCents: 201 })]),
    )
    assert.ok(failing(wrongVat).includes('BR-CO-17'))
  })

  it('exige les mentions de pénalités, d’indemnité et d’escompte', () => {
    assert.deepEqual(failing(toEn16931(source({ legalMentions: null }))), [
      'BG-1 PMD',
      'BG-1 PMT',
      'BG-1 AAB',
    ])
  })
})
