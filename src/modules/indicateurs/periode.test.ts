import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  evolutionMonths,
  isIsoDate,
  MAX_PERIOD_DAYS,
  monthPeriod,
  parsePeriod,
  periodDays,
  periodLength,
  periodMonths,
  periodPresets,
  unionPeriod,
} from './periode.ts'

const TODAY = '2026-10-14'

describe('période des indicateurs', () => {
  it('prend le mois en cours, entier, sans paramètre', () => {
    const parsed = parsePeriod({}, TODAY)
    assert.deepEqual(parsed.period, { from: '2026-10-01', to: '2026-10-31' })
    assert.deepEqual(parsed.errors, {})
  })

  it('accepte une période valide, un seul jour compris', () => {
    assert.deepEqual(parsePeriod({ du: '2026-09-01', au: '2026-09-30' }, TODAY).period, {
      from: '2026-09-01',
      to: '2026-09-30',
    })
    assert.deepEqual(parsePeriod({ du: '2026-09-15', au: '2026-09-15' }, TODAY).period, {
      from: '2026-09-15',
      to: '2026-09-15',
    })
  })

  it('refuse une date qui n’existe pas, une borne manquante ou inversée, et dit laquelle', () => {
    assert.equal(isIsoDate('2026-02-30'), false)
    assert.equal(isIsoDate('2028-02-29'), true)

    const inexistante = parsePeriod({ du: '2026-02-30', au: '2026-03-31' }, TODAY)
    assert.ok(inexistante.errors.du)
    assert.equal(inexistante.errors.au, undefined)
    // La saisie est rendue telle quelle, la période retombe sur le mois en cours.
    assert.equal(inexistante.input.du, '2026-02-30')
    assert.deepEqual(inexistante.period, monthPeriod('2026-10'))

    assert.ok(parsePeriod({ du: '2026-09-01' }, TODAY).errors.au)
    assert.ok(parsePeriod({ du: '2026-09-30', au: '2026-09-01' }, TODAY).errors.au)
  })

  it('borne la période à une année', () => {
    assert.equal(periodLength({ from: '2028-01-01', to: '2028-12-31' }), MAX_PERIOD_DAYS)
    assert.deepEqual(parsePeriod({ du: '2028-01-01', au: '2028-12-31' }, TODAY).errors, {})
    assert.ok(parsePeriod({ du: '2026-01-01', au: '2027-01-02' }, TODAY).errors.au)
  })

  it('énumère les jours et les mois, changement d’année compris', () => {
    assert.equal(periodDays({ from: '2026-12-30', to: '2027-01-02' }).length, 4)
    assert.deepEqual(periodMonths({ from: '2026-11-15', to: '2027-01-02' }), [
      '2026-11',
      '2026-12',
      '2027-01',
    ])
    assert.deepEqual(monthPeriod('2028-02'), { from: '2028-02-01', to: '2028-02-29' })
  })

  it('fait finir la courbe d’évolution avec le mois de fin de période', () => {
    const months = evolutionMonths({ from: '2026-09-01', to: '2026-10-14' })
    assert.equal(months.length, 12)
    assert.equal(months[0], '2025-11')
    assert.equal(months.at(-1), '2026-10')
    assert.deepEqual(unionPeriod({ from: '2026-09-01', to: '2026-10-14' }, { from: '2025-11-01', to: '2026-10-31' }), {
      from: '2025-11-01',
      to: '2026-10-31',
    })
  })

  it('propose des raccourcis tous acceptés par le formulaire', () => {
    for (const preset of periodPresets(TODAY)) {
      const parsed = parsePeriod({ du: preset.period.from, au: preset.period.to }, TODAY)
      assert.deepEqual(parsed.errors, {}, preset.label)
      assert.deepEqual(parsed.period, preset.period)
    }
    const [ceMois, precedent] = periodPresets(TODAY)
    assert.deepEqual(ceMois.period, { from: '2026-10-01', to: '2026-10-31' })
    assert.deepEqual(precedent.period, { from: '2026-09-01', to: '2026-09-30' })
  })
})
