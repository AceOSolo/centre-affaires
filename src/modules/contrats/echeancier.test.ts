import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  addDays,
  billingSchedule,
  daysInclusive,
  noticeEndsOn,
  periodEnd,
  periodStart,
  prorataCents,
  scheduleTotalCents,
  type ScheduledContract,
} from './echeancier.ts'

const mensuel = (overrides: Partial<ScheduledContract> = {}): ScheduledContract => ({
  startsOn: '2026-03-01',
  billingPeriod: 'monthly',
  amountCents: 90_000, // 900 €
  ...overrides,
})

describe('arithmétique de calendrier', () => {
  it('compte les jours bornes comprises', () => {
    assert.equal(daysInclusive('2026-03-01', '2026-03-31'), 31)
    assert.equal(daysInclusive('2026-03-10', '2026-03-10'), 1)
    assert.equal(daysInclusive('2026-02-01', '2026-02-28'), 28)
  })

  it('compte le 29 février des années bissextiles', () => {
    assert.equal(daysInclusive('2028-02-01', '2028-02-29'), 29)
  })

  it('franchit les fins de mois et d’année', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01')
    assert.equal(addDays('2026-12-31', 1), '2027-01-01')
    assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  })
})

describe('bornes de période', () => {
  it('cadre un mois civil', () => {
    assert.equal(periodStart('2026-03-17', 'monthly'), '2026-03-01')
    assert.equal(periodEnd('2026-03-17', 'monthly'), '2026-03-31')
    assert.equal(periodEnd('2026-02-17', 'monthly'), '2026-02-28')
    assert.equal(periodEnd('2028-02-17', 'monthly'), '2028-02-29')
  })

  it('cadre un trimestre civil', () => {
    assert.equal(periodStart('2026-05-17', 'quarterly'), '2026-04-01')
    assert.equal(periodEnd('2026-05-17', 'quarterly'), '2026-06-30')
    assert.equal(periodStart('2026-01-01', 'quarterly'), '2026-01-01')
    assert.equal(periodEnd('2026-12-31', 'quarterly'), '2026-12-31')
  })

  it('cadre une année civile', () => {
    assert.equal(periodStart('2026-05-17', 'yearly'), '2026-01-01')
    assert.equal(periodEnd('2026-05-17', 'yearly'), '2026-12-31')
  })
})

describe('prorataCents', () => {
  it('rend le montant entier pour une période complète', () => {
    assert.equal(prorataCents(90_000, 31, 31), 90_000)
  })

  it('ne dépasse jamais le montant du contrat', () => {
    assert.equal(prorataCents(90_000, 40, 31), 90_000)
  })

  it('calcule au prorata des jours couverts', () => {
    // Du 10 au 31 mars : 22 jours sur 31.
    assert.equal(prorataCents(90_000, 22, 31), Math.round((90_000 * 22) / 31))
    assert.equal(prorataCents(90_000, 22, 31), 63_871)
  })

  it('rend un entier de centimes, jamais un flottant', () => {
    const montant = prorataCents(100_000, 1, 31)
    assert.equal(Number.isInteger(montant), true)
    assert.equal(montant, 3_226)
  })

  it('ne facture rien pour une période non couverte', () => {
    assert.equal(prorataCents(90_000, 0, 31), 0)
    assert.equal(prorataCents(90_000, 10, 0), 0)
  })
})

describe('billingSchedule', () => {
  it('facture un mois plein sans prorata', () => {
    const periods = billingSchedule(mensuel(), '2026-03-31')
    assert.deepEqual(periods, [
      { startsOn: '2026-03-01', endsOn: '2026-03-31', full: true, amountCents: 90_000 },
    ])
  })

  it('proratise le premier mois quand le contrat commence en cours de mois', () => {
    const periods = billingSchedule(mensuel({ startsOn: '2026-03-10' }), '2026-04-30')
    assert.equal(periods.length, 2)
    assert.deepEqual(periods[0], {
      startsOn: '2026-03-10',
      endsOn: '2026-03-31',
      full: false,
      amountCents: 63_871,
    })
    assert.equal(periods[1].full, true)
    assert.equal(periods[1].amountCents, 90_000)
  })

  it('proratise le dernier mois sur le terme du contrat', () => {
    const periods = billingSchedule(
      mensuel({ startsOn: '2026-03-01', endsOn: '2026-04-15' }),
      '2026-12-31',
    )
    assert.equal(periods.length, 2)
    assert.deepEqual(periods[1], {
      startsOn: '2026-04-01',
      endsOn: '2026-04-15',
      full: false,
      // 15 jours sur 30.
      amountCents: 45_000,
    })
  })

  it('arrête tout à la résiliation, même avant le terme prévu', () => {
    const periods = billingSchedule(
      mensuel({ startsOn: '2026-03-01', endsOn: '2026-12-31', terminatedOn: '2026-04-15' }),
      '2026-12-31',
    )
    assert.equal(periods.at(-1)?.endsOn, '2026-04-15')
    assert.equal(scheduleTotalCents(periods), 90_000 + 45_000)
  })

  it('ne génère rien avant le début du contrat', () => {
    assert.deepEqual(billingSchedule(mensuel({ startsOn: '2026-06-01' }), '2026-03-31'), [])
  })

  it('borne un contrat à durée indéterminée sur la date demandée', () => {
    const periods = billingSchedule(mensuel({ startsOn: '2026-01-01' }), '2026-12-31')
    assert.equal(periods.length, 12)
    assert.equal(periods.every((period) => period.full), true)
    assert.equal(scheduleTotalCents(periods), 12 * 90_000)
  })

  it('coupe la dernière période sur `until`', () => {
    const periods = billingSchedule(mensuel({ startsOn: '2026-01-01' }), '2026-02-10')
    assert.equal(periods.length, 2)
    assert.deepEqual(periods[1], {
      startsOn: '2026-02-01',
      endsOn: '2026-02-10',
      full: false,
      // 10 jours sur 28.
      amountCents: prorataCents(90_000, 10, 28),
    })
  })

  it('suit les trimestres civils, pas les trimestres anniversaires', () => {
    const periods = billingSchedule(
      mensuel({ startsOn: '2026-02-01', billingPeriod: 'quarterly', amountCents: 270_000 }),
      '2026-06-30',
    )
    assert.equal(periods.length, 2)
    assert.deepEqual(periods[0], {
      startsOn: '2026-02-01',
      endsOn: '2026-03-31',
      full: false,
      // 59 jours (février + mars) sur 90 (janvier à mars).
      amountCents: prorataCents(270_000, 59, 90),
    })
    assert.deepEqual(periods[1], {
      startsOn: '2026-04-01',
      endsOn: '2026-06-30',
      full: true,
      amountCents: 270_000,
    })
  })

  it('facture une année civile en une échéance', () => {
    const periods = billingSchedule(
      mensuel({ startsOn: '2026-01-01', billingPeriod: 'yearly', amountCents: 1_080_000 }),
      '2026-12-31',
    )
    assert.deepEqual(periods, [
      { startsOn: '2026-01-01', endsOn: '2026-12-31', full: true, amountCents: 1_080_000 },
    ])
  })

  it('facture un contrat d’un seul jour', () => {
    const periods = billingSchedule(
      mensuel({ startsOn: '2026-03-10', endsOn: '2026-03-10' }),
      '2026-12-31',
    )
    assert.equal(periods.length, 1)
    assert.equal(periods[0].amountCents, prorataCents(90_000, 1, 31))
  })
})

describe('noticeEndsOn', () => {
  it('compte le préavis à partir du jour de la demande', () => {
    // 90 jours à partir du 1er mars : mars (31) + avril (30) + 29 jours de mai.
    assert.equal(noticeEndsOn('2026-03-01', 90), '2026-05-29')
  })

  it('termine le jour même quand il n’y a pas de préavis', () => {
    assert.equal(noticeEndsOn('2026-03-01', 0), '2026-03-01')
  })
})
