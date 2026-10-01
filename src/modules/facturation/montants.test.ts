import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  amountDueCents,
  invoiceAmounts,
  invoicePaymentStatus,
  lineNetAmountCents,
  vatAmountCents,
  type VatLine,
} from './montants.ts'

/**
 * Règles d'arrondi de l'argent (ADR 023, 026). Les mêmes cas sont rejoués
 * contre les fonctions SQL dans `montants.db.test.ts`.
 */
describe('montant net d’une ligne', () => {
  it('multiplie la quantité par le prix, sans arrondi quand il n’y en a pas besoin', () => {
    assert.equal(lineNetAmountCents({ quantity: 3, unitPriceCents: 2_500 }), 7_500)
  })

  it('applique une remise en points de base, arrondie au centime le plus proche', () => {
    // 10 % de 90,00 € : 81,00 €.
    assert.equal(lineNetAmountCents({ quantity: 1, unitPriceCents: 9_000, discountBp: 1_000 }), 8_100)
    // 12,5 % de 0,99 € = 0,86625 € : 0,87 €.
    assert.equal(lineNetAmountCents({ quantity: 1, unitPriceCents: 99, discountBp: 1_250 }), 87)
  })

  it('arrondit la moitié en s’éloignant de zéro', () => {
    // 1,25 € à 50 % : 0,625 € → 0,63 €.
    assert.equal(lineNetAmountCents({ quantity: 1, unitPriceCents: 125, discountBp: 5_000 }), 63)
    // Une ligne de remise négative est arrondie symétriquement : −0,625 € → −0,63 €.
    assert.equal(lineNetAmountCents({ quantity: 1, unitPriceCents: -125, discountBp: 5_000 }), -63)
  })

  it('retranche une remise en montant par période', () => {
    assert.equal(
      lineNetAmountCents({ quantity: 2, unitPriceCents: 45_000, discountAmountCents: 5_000 }),
      85_000,
    )
  })

  it('proratise une période partielle, remise comprise, en un seul arrondi', () => {
    // Loyer de 900 € du 10 au 31 mars : 22/31.
    assert.equal(
      lineNetAmountCents({
        quantity: 1,
        unitPriceCents: 90_000,
        prorataNumerator: 22,
        prorataDenominator: 31,
      }),
      63_871,
    )
    // Même période, remise de 100 € par mois : (900 − 100) × 22/31.
    assert.equal(
      lineNetAmountCents({
        quantity: 1,
        unitPriceCents: 90_000,
        discountAmountCents: 10_000,
        prorataNumerator: 22,
        prorataDenominator: 31,
      }),
      56_774,
    )
    // Base 30 jours : 15 jours d'un mois sont la moitié du loyer.
    assert.equal(
      lineNetAmountCents({
        quantity: 1,
        unitPriceCents: 90_001,
        prorataNumerator: 15,
        prorataDenominator: 30,
      }),
      45_001,
    )
  })

  it('rend une période entière exactement, sans passer par une division inexacte', () => {
    assert.equal(
      lineNetAmountCents({ quantity: 1, unitPriceCents: 99_999, prorataNumerator: 31, prorataDenominator: 31 }),
      99_999,
    )
  })

  it('ne déborde pas sur de grands montants', () => {
    assert.equal(
      lineNetAmountCents({ quantity: 1_000, unitPriceCents: 2_000_000, discountBp: 1, prorataNumerator: 1, prorataDenominator: 3 }),
      666_600_000,
    )
  })
})

describe('TVA', () => {
  it('calcule 20 % au centime le plus proche', () => {
    assert.equal(vatAmountCents(10_000, 2_000), 2_000)
    // 0,33 € × 20 % = 0,066 € → 0,07 €.
    assert.equal(vatAmountCents(33, 2_000), 7)
    // 5,5 % de 0,10 € = 0,0055 € → 0,01 €.
    assert.equal(vatAmountCents(10, 550), 1)
    assert.equal(vatAmountCents(-33, 2_000), -7)
  })
})

describe('TVA d’une facture, par taux', () => {
  const ligne = (id: string, position: number, netAmountCents: number, vatRateBp = 2_000): VatLine => ({
    id,
    position,
    netAmountCents,
    vatRateBp,
    vatCategory: vatRateBp === 0 ? 'E' : 'S',
  })

  it('calcule la TVA sur la somme des bases, pas ligne à ligne (EN 16931)', () => {
    // Trois lignes à 0,33 € : ligne à ligne, 3 × 0,07 € = 0,21 € ; sur la
    // base de 0,99 €, 0,198 € → 0,20 €.
    const montants = invoiceAmounts([ligne('a', 0, 33), ligne('b', 1, 33), ligne('c', 2, 33)])
    assert.equal(montants.totalTaxCents, 20)
    assert.deepEqual(montants.breakdown, [
      { vatCategory: 'S', vatRateBp: 2_000, taxableAmountCents: 99, vatAmountCents: 20 },
    ])
  })

  it('répartit l’écart d’arrondi pour que les lignes tombent sur le total', () => {
    const montants = invoiceAmounts([ligne('a', 0, 33), ligne('b', 1, 33), ligne('c', 2, 33)])
    const somme = [...montants.lineVatCents.values()].reduce((total, vat) => total + vat, 0)
    assert.equal(somme, montants.totalTaxCents)
    // À valeur égale, l'écart va à la première par position.
    assert.equal(montants.lineVatCents.get('a'), 6)
    assert.equal(montants.lineVatCents.get('b'), 7)
  })

  it('porte l’écart sur la ligne de plus forte valeur absolue', () => {
    const montants = invoiceAmounts([ligne('a', 0, 33), ligne('b', 1, 1_033), ligne('c', 2, 33)])
    // Base 10,99 € → 2,198 € → 2,20 € ; lignes : 0,07 + 2,07 + 0,07 = 2,21 €.
    assert.equal(montants.totalTaxCents, 220)
    assert.equal(montants.lineVatCents.get('b'), 206)
  })

  it('ventile par taux, et totalise HT, TVA et TTC', () => {
    const montants = invoiceAmounts([
      ligne('loyer', 0, 90_000),
      ligne('repas', 1, 1_500, 1_000),
      ligne('exonere', 2, 5_000, 0),
      ligne('remise', 3, -9_000),
    ])
    assert.equal(montants.totalExclTaxCents, 87_500)
    assert.equal(montants.totalTaxCents, 16_200 + 150)
    assert.equal(montants.totalInclTaxCents, 87_500 + 16_350)
    assert.equal(montants.breakdown.length, 3)
  })
})

describe('statut d’une facture émise', () => {
  it('se déduit des paiements et des avoirs', () => {
    assert.equal(invoicePaymentStatus('invoice', 12_000, 0, 0), 'issued')
    assert.equal(invoicePaymentStatus('invoice', 12_000, 2_000, 0), 'partially_paid')
    assert.equal(invoicePaymentStatus('invoice', 12_000, 12_000, 0), 'paid')
    assert.equal(invoicePaymentStatus('invoice', 12_000, 14_000, 0), 'paid')
    assert.equal(invoicePaymentStatus('invoice', 12_000, 10_000, 2_000), 'paid')
    assert.equal(invoicePaymentStatus('invoice', 12_000, 0, 2_000), 'issued')
    assert.equal(invoicePaymentStatus('invoice', 12_000, 0, 12_000), 'cancelled')
    // Payée puis annulée par avoir : annulée, le trop-perçu est à rembourser.
    assert.equal(invoicePaymentStatus('invoice', 12_000, 12_000, 12_000), 'cancelled')
    assert.equal(amountDueCents({ totalInclTaxCents: 12_000, paidCents: 12_000, creditedCents: 12_000 }), -12_000)
  })

  it('tient une facture à zéro pour soldée, et un avoir pour émis', () => {
    assert.equal(invoicePaymentStatus('invoice', 0, 0, 0), 'paid')
    assert.equal(invoicePaymentStatus('credit_note', 12_000, 0, 0), 'issued')
  })
})
