import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  bpToPercentInput,
  centsToAmountInput,
  formatBp,
  isIsoDate,
  parseInteger,
  parsePercentToBp,
  shiftIsoDate,
} from './saisie.ts'

/** Saisie des taux, montants, quantités et dates : tout finit en entiers (décision 5). */
describe('saisie des taux et des montants', () => {
  it('lit un pourcentage en points de base, sans flottant', () => {
    assert.equal(parsePercentToBp('20'), 2_000)
    assert.equal(parsePercentToBp('5,5'), 550)
    assert.equal(parsePercentToBp('2.1'), 210)
    assert.equal(parsePercentToBp('12,25 %'), 1_225)
    assert.equal(parsePercentToBp('0'), 0)
    assert.equal(parsePercentToBp('100'), 10_000)
  })

  it('refuse un pourcentage illisible, trop précis ou au-delà de 100', () => {
    for (const saisie of ['', 'vingt', '12,345', '100,01', '-5', '1e2']) {
      assert.equal(parsePercentToBp(saisie), undefined, saisie)
    }
  })

  it('rend un taux et un montant au format de saisie, à l’inverse exact de la lecture', () => {
    assert.equal(bpToPercentInput(2_000), '20')
    assert.equal(bpToPercentInput(550), '5,5')
    assert.equal(bpToPercentInput(1_225), '12,25')
    assert.equal(formatBp(210), '2,1 %')
    for (const bp of [0, 1, 99, 550, 1_225, 2_000, 10_000]) {
      assert.equal(parsePercentToBp(bpToPercentInput(bp)), bp)
    }
    assert.equal(centsToAmountInput(1_999), '19,99')
    assert.equal(centsToAmountInput(5), '0,05')
    assert.equal(centsToAmountInput(-250), '-2,50')
  })

  it('lit une quantité entière dans ses bornes', () => {
    assert.equal(parseInteger('3', 1), 3)
    assert.equal(parseInteger(' 12 ', 0), 12)
    assert.equal(parseInteger('0', 1), undefined)
    assert.equal(parseInteger('2,5', 1), undefined)
    assert.equal(parseInteger('3000000000', 1), undefined)
  })

  it('ne reconnaît que les dates qui existent, et les décale sans fuseau', () => {
    assert.equal(isIsoDate('2028-02-29'), true)
    assert.equal(isIsoDate('2026-02-29'), false)
    assert.equal(isIsoDate('2026-9-1'), false)
    assert.equal(shiftIsoDate('2026-10-01', -1), '2026-09-30')
    assert.equal(shiftIsoDate('2026-12-31', 1), '2027-01-01')
  })
})
