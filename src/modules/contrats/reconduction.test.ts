import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { nextTerm, noticeStillPossible, tacitRenewalTerm } from './reconduction.ts'

/**
 * Reconduction tacite (R10, ADR 023, ADR 033) : quand elle est acquise, et
 * jusqu'où elle porte le terme.
 */
const annuel = { endsOn: '2026-12-31', renewalMonths: 12, noticeDays: 90, commitmentEndsOn: null }

describe('reconduction tacite', () => {
  it('prolonge de date à date, du lendemain du terme à la veille', () => {
    assert.equal(nextTerm('2026-12-31', 12), '2027-12-31')
    assert.equal(nextTerm('2027-02-28', 12), '2028-02-29')
    assert.equal(nextTerm('2026-03-31', 1), '2026-04-30')
    assert.equal(nextTerm('2026-09-30', 3), '2026-12-31')
  })

  it('attend tant qu’un préavis donné ce jour-là met encore fin au contrat à son terme', () => {
    // 90 jours, jour de la demande compris : le 3 octobre est le dernier jour.
    assert.equal(noticeStillPossible(annuel, '2026-10-03'), true)
    assert.equal(tacitRenewalTerm(annuel, '2026-10-03'), null)
    assert.equal(tacitRenewalTerm(annuel, '2026-06-01'), null)
  })

  it('est acquise le lendemain du dernier jour de préavis, d’une période', () => {
    assert.equal(noticeStillPossible(annuel, '2026-10-04'), false)
    assert.equal(tacitRenewalTerm(annuel, '2026-10-04'), '2027-12-31')
  })

  it('sans préavis, au lendemain du terme', () => {
    const sansPreavis = { ...annuel, noticeDays: 0 }
    assert.equal(tacitRenewalTerm(sansPreavis, '2026-12-31'), null)
    assert.equal(tacitRenewalTerm(sansPreavis, '2027-01-01'), '2027-12-31')
  })

  it('rattrape plusieurs périodes manquées d’un coup', () => {
    const repris = { ...annuel, endsOn: '2023-12-31' }
    assert.equal(tacitRenewalTerm(repris, '2026-10-02'), '2026-12-31')
    assert.equal(tacitRenewalTerm(repris, '2026-10-04'), '2027-12-31')
    const mensuel = { endsOn: '2026-06-30', renewalMonths: 1, noticeDays: 30, commitmentEndsOn: null }
    // Le 2 octobre, un préavis finit le 31 : octobre est le dernier mois acquis.
    assert.equal(tacitRenewalTerm(mensuel, '2026-10-02'), '2026-10-31')
  })

  it('ne précède pas la fin de l’engagement', () => {
    // Terme saisi avant la fin d'engagement : prolongé jusqu'à la couvrir.
    const engage = { ...annuel, endsOn: '2026-06-30', commitmentEndsOn: '2027-06-30' }
    assert.equal(tacitRenewalTerm(engage, '2026-05-01'), '2027-06-30')
  })
})
