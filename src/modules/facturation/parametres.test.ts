import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseAmountToCents, parsePercentToBasisPoints } from './tarifs.ts'
import {
  basisPointsToInput,
  centsToInput,
  frenchVatKey,
  isValidSepaCreditorId,
  isValidSiren,
  isValidSiret,
  missingInvoiceRequirements,
  parseBankDetails,
  parseInvoicingRules,
  parsePricingRules,
  parseSellerIdentity,
  vatNumberProblem,
} from './parametres.ts'

const erreurs = (result: ReturnType<typeof parsePricingRules>) =>
  result.ok ? {} : result.fieldErrors

describe('règles tarifaires du centre (R10, ADR 023)', () => {
  const saisie = {
    prorataRule: 'thirty_day_month',
    startedUnitToleranceMinutes: '10',
    halfDayMinutes: '300',
    defaultVatRate: '20',
  }

  it('lit les quatre règles', () => {
    assert.deepEqual(parsePricingRules(saisie), {
      ok: true,
      update: {
        prorataRule: 'thirty_day_month',
        startedUnitToleranceMinutes: 10,
        halfDayMinutes: 300,
        defaultVatRateBp: 2_000,
      },
    })
  })

  it('lit un taux de TVA décimal en points de base', () => {
    const result = parsePricingRules({ ...saisie, defaultVatRate: '5,5' })
    assert.equal(result.ok && result.update.defaultVatRateBp, 550)
  })

  it('tient les bornes de la base', () => {
    assert.deepEqual(
      Object.keys(
        erreurs(
          parsePricingRules({
            prorataRule: 'au-doigt-mouille',
            startedUnitToleranceMinutes: '60',
            halfDayMinutes: '59',
            defaultVatRate: '101',
          }),
        ),
      ).sort(),
      ['defaultVatRate', 'halfDayMinutes', 'prorataRule', 'startedUnitToleranceMinutes'],
    )
    assert.equal(parsePricingRules({ ...saisie, startedUnitToleranceMinutes: '59', halfDayMinutes: '720' }).ok, true)
    assert.equal(parsePricingRules({ ...saisie, startedUnitToleranceMinutes: '1,5' }).ok, false)
  })
})

describe('règles de facturation (ADR 026)', () => {
  const saisie = {
    invoicePaymentTermsDays: '30',
    recurringBillingTiming: 'in_advance',
    latePaymentPenaltyText: 'Taux BCE + 10 points.',
    recoveryIndemnity: '40',
    earlyPaymentDiscountText: 'Pas d’escompte.',
    invoiceFooterText: '',
  }

  it('lit l’échéance, le moment de facturation et les mentions', () => {
    assert.deepEqual(parseInvoicingRules({ ...saisie, vatOnDebits: 'on' }), {
      ok: true,
      update: {
        invoicePaymentTermsDays: 30,
        recurringBillingTiming: 'in_advance',
        vatOnDebits: true,
        latePaymentPenaltyText: 'Taux BCE + 10 points.',
        recoveryIndemnityCents: 4_000,
        earlyPaymentDiscountText: 'Pas d’escompte.',
        invoiceFooterText: null,
      },
    })
  })

  it('refuse une échéance au-delà de 60 jours, plafond légal', () => {
    const result = parseInvoicingRules({ ...saisie, invoicePaymentTermsDays: '61' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.fieldErrors.invoicePaymentTermsDays)
  })

  it('exige les mentions obligatoires', () => {
    const result = parseInvoicingRules({ ...saisie, latePaymentPenaltyText: ' ', earlyPaymentDiscountText: '' })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.deepEqual(Object.keys(result.fieldErrors).sort(), [
        'earlyPaymentDiscountText',
        'latePaymentPenaltyText',
      ])
    }
  })
})

describe('identifiants légaux', () => {
  it('vérifie la clé de Luhn du SIREN et du SIRET', () => {
    assert.equal(isValidSiren('732829320'), true)
    assert.equal(isValidSiren('732829321'), false)
    assert.equal(isValidSiren('73282932'), false)
    assert.equal(isValidSiret('73282932000074'), true)
    assert.equal(isValidSiret('73282932000075'), false)
  })

  it('admet les établissements de La Poste, qui dérogent à la clé de Luhn', () => {
    // Somme des chiffres : 26 (refusé), puis 20 (multiple de 5, accepté).
    assert.equal(isValidSiret('35600000000048'), false)
    assert.equal(isValidSiret('35600000000060'), true)
  })

  it('calcule la clé du numéro de TVA français', () => {
    assert.equal(frenchVatKey('732829320'), '44')
    assert.equal(vatNumberProblem('FR44732829320', '732829320'), undefined)
    assert.match(vatNumberProblem('FR45732829320', '732829320') ?? '', /Clé/)
    assert.match(vatNumberProblem('FR44732829320', '552100554') ?? '', /SIREN du centre/)
    // Un numéro étranger n'est contrôlé que dans sa forme.
    assert.equal(vatNumberProblem('DE123456789', '732829320'), undefined)
    assert.match(vatNumberProblem('44732829320', null) ?? '', /Format/)
  })

  it('vérifie la clé de l’identifiant créancier SEPA', () => {
    assert.equal(isValidSepaCreditorId('FR72ZZZ123456'), true)
    assert.equal(isValidSepaCreditorId('DE98ZZZ09999999999'), true)
    assert.equal(isValidSepaCreditorId('FR73ZZZ123456'), false)
    assert.equal(isValidSepaCreditorId('FR72123456'), false)
  })
})

describe('identité légale du vendeur', () => {
  const saisie = {
    legalName: 'Centre d’affaires SAS',
    legalForm: 'SAS',
    shareCapital: '10 000',
    siren: '732 829 320',
    siret: '732 829 320 00074',
    vatNumber: 'FR 44 732829320',
    rcsCity: 'Vienne',
    addressLine1: '1 rue de la Gare',
    addressLine2: '',
    postalCode: '38200',
    city: 'Vienne',
    country: 'fr',
  }

  it('normalise les identifiants : sans espace, en majuscules', () => {
    const result = parseSellerIdentity(saisie)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.update.siren, '732829320')
    assert.equal(result.update.siret, '73282932000074')
    assert.equal(result.update.vatNumber, 'FR44732829320')
    assert.equal(result.update.shareCapitalCents, 1_000_000)
    assert.equal(result.update.country, 'FR')
    assert.equal(result.update.addressLine2, null)
  })

  it('exige que le SIRET commence par le SIREN', () => {
    const result = parseSellerIdentity({ ...saisie, siret: '55210055400013' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.fieldErrors.siret, /commence par le SIREN/)
  })

  it('laisse les champs vides : la facture dira ce qui manque', () => {
    const result = parseSellerIdentity({ country: 'FR' })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.update.siren, null)
  })
})

describe('coordonnées bancaires du vendeur (ADR 027)', () => {
  it('normalise et vérifie l’IBAN', () => {
    const result = parseBankDetails({
      bankIban: 'fr76 3000 6000 0112 3456 7890 189',
      bankBic: 'agrifrpp882',
      sepaCreditorId: 'FR72ZZZ123456',
      defaultPaymentMethod: 'transfer',
    })
    assert.deepEqual(result, {
      ok: true,
      update: {
        bankIban: 'FR7630006000011234567890189',
        bankBic: 'AGRIFRPP882',
        sepaCreditorId: 'FR72ZZZ123456',
        defaultPaymentMethod: 'transfer',
      },
    })
  })

  it('refuse un IBAN dont la clé est fausse', () => {
    const result = parseBankDetails({ bankIban: 'FR7630006000011234567890188', defaultPaymentMethod: 'transfer' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.fieldErrors.bankIban)
  })
})

describe('valeurs affichées', () => {
  it('rend les centimes en euros sans flottant', () => {
    assert.equal(centsToInput(4_000), '40,00')
    assert.equal(centsToInput(1_999), '19,99')
    assert.equal(centsToInput(5), '0,05')
    assert.equal(centsToInput(2_150_000_000), '21500000,00')
  })

  it('rend les points de base en pourcentage relisible', () => {
    assert.equal(basisPointsToInput(2_000), '20')
    assert.equal(basisPointsToInput(550), '5,5')
    assert.equal(basisPointsToInput(210), '2,1')
    assert.equal(basisPointsToInput(1_999), '19,99')
    assert.equal(basisPointsToInput(7), '0,07')
  })

  it('relit sans perte ce qu’elle affiche', () => {
    for (const basisPoints of [0, 7, 210, 550, 1_000, 1_999, 2_000, 10_000]) {
      assert.equal(parsePercentToBasisPoints(basisPointsToInput(basisPoints)), basisPoints)
    }
    for (const cents of [0, 5, 1_999, 4_000, 1_000_000]) {
      assert.equal(parseAmountToCents(centsToInput(cents)), cents)
    }
  })
})

describe('missingInvoiceRequirements', () => {
  const complet = {
    legalName: 'Centre SAS',
    addressLine1: '1 rue de la Gare',
    postalCode: '38200',
    city: 'Vienne',
    siren: '732829320',
    vatNumber: 'FR44732829320',
    bankIban: 'FR7630006000011234567890189',
    sepaCreditorId: null,
    defaultPaymentMethod: 'transfer' as const,
  }

  it('ne réclame rien à un centre complet', () => {
    assert.deepEqual(missingInvoiceRequirements(complet), [])
  })

  it('liste ce que l’émission d’une facture exigera', () => {
    assert.deepEqual(
      missingInvoiceRequirements({ ...complet, siren: null, city: ' ', bankIban: null }),
      ['adresse', 'SIREN', 'IBAN (paiement par virement)'],
    )
    assert.deepEqual(missingInvoiceRequirements({ ...complet, defaultPaymentMethod: 'direct_debit' }), [
      'identifiant créancier SEPA (prélèvement)',
    ])
  })
})
