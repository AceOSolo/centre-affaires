import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  describeDomiciliationPrice,
  domiciliationLines,
  domiciliationTotal,
  parseChosenServices,
  totalSentence,
  UNPRICED_MESSAGE,
  type DomiciliationOffer,
} from './domiciliation-tarif.ts'

const offer: DomiciliationOffer = {
  currency: 'EUR',
  base: { label: 'Domiciliation, forfait mensuel', amountCents: 3_000, vatRateBp: 2000, ratePlanItemId: 'grille-1' },
  options: [
    { code: 'domiciliation.reexpedition', serviceId: 's-1', label: 'Réexpédition hebdomadaire', description: null, amountCents: 2_500, vatRateBp: 2000 },
    { code: 'domiciliation.scan', serviceId: 's-2', label: 'Numérisation du courrier', description: 'Chaque pli scanné.', amountCents: 1_250, vatRateBp: 2000 },
  ],
}

describe('tarif de la domiciliation (ADR 074)', () => {
  it('additionne le forfait et les options cochées, en centimes, HT puis TTC', () => {
    const forfait = domiciliationTotal(offer, [])
    assert.equal(forfait.status, 'priced')
    assert.equal(forfait.status === 'priced' && forfait.netCents, 3_000)
    assert.equal(forfait.status === 'priced' && forfait.grossCents, 3_600)

    const total = domiciliationTotal(offer, ['domiciliation.scan', 'domiciliation.reexpedition'])
    assert.ok(total.status === 'priced')
    assert.equal(total.netCents, 6_750)
    assert.equal(total.vatCents, 1_350)
    assert.equal(total.grossCents, 8_100)
    assert.deepEqual(total.lines.map((line) => line.label), ['Domiciliation, forfait mensuel', 'Réexpédition hebdomadaire', 'Numérisation du courrier'])
  })

  it('calcule la TVA par taux sur la somme des bases, comme une facture', () => {
    // 3 × 0,05 € à 20 % : 0,03 € sur la somme, et non 3 × 0,01 €.
    const petit: DomiciliationOffer = {
      currency: 'EUR',
      base: { label: 'Forfait', amountCents: 5, vatRateBp: 2000, ratePlanItemId: 'g' },
      options: [
        { code: 'a', serviceId: 'a', label: 'A', description: null, amountCents: 5, vatRateBp: 2000 },
        { code: 'b', serviceId: 'b', label: 'B', description: null, amountCents: 5, vatRateBp: 2000 },
      ],
    }
    const total = domiciliationTotal(petit, ['a', 'b'])
    assert.ok(total.status === 'priced')
    assert.equal(total.vatCents, 3)
  })

  it('n’invente rien sans forfait connu', () => {
    const sansForfait = { ...offer, base: null }
    assert.deepEqual(domiciliationTotal(sansForfait, ['domiciliation.scan']), { status: 'unpriced' })
    assert.equal(totalSentence(domiciliationTotal(sansForfait, []), 'EUR'), UNPRICED_MESSAGE)
  })

  it('refuse une option que le centre ne propose pas, et range les autres dans son ordre', () => {
    assert.match(parseChosenServices(offer, ['domiciliation.standard']).error ?? '', /plus proposée/)
    assert.deepEqual(parseChosenServices(offer, ['domiciliation.scan', 'domiciliation.reexpedition', 'domiciliation.scan', '']).codes, [
      'domiciliation.reexpedition',
      'domiciliation.scan',
    ])
  })

  it('fait du forfait et des options les lignes du devis, au prix annoncé', () => {
    const lines = domiciliationLines(offer, ['domiciliation.scan'])
    assert.deepEqual(
      lines.map((line) => [line.source, line.label, line.unit, line.quantity, line.unitPriceCents, line.serviceId, line.ratePlanItemId]),
      [
        ['manual', 'Domiciliation, forfait mensuel', 'month', 1, 3_000, null, 'grille-1'],
        ['service', 'Numérisation du courrier', 'month', 1, 1_250, 's-2', null],
      ],
    )
    assert.equal(domiciliationLines({ ...offer, base: null }, []).length, 0)
  })

  it('écrit les options et le tarif annoncé en clair, pour le devis', () => {
    const described = describeDomiciliationPrice(offer, ['domiciliation.reexpedition'])
    assert.equal(described[0].label, 'Options choisies')
    assert.match(described[0].value, /^Réexpédition hebdomadaire \(25,00\s€ HT par mois\)$/)
    assert.equal(described[1].label, 'Tarif annoncé')
    assert.match(described[1].value, /^55,00\s€ HT, soit 66,00\s€ TTC par mois$/)
    assert.deepEqual(describeDomiciliationPrice({ ...offer, base: null }, []), [{ name: 'tarif', label: 'Tarif annoncé', value: UNPRICED_MESSAGE }])
  })
})
