import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  addDays,
  billingSchedule,
  commitmentSchedule,
  daysInclusive,
  earliestEndOn,
  noticeEndsOn,
  periodEnd,
  periodStart,
  prorataFraction,
  scheduleTotalCents,
  thirtyDayCount,
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

describe('prorataFraction', () => {
  const mars = { startsOn: '2026-03-01', endsOn: '2026-03-31', period: 'monthly' as const }
  const du10au31 = { startsOn: '2026-03-10', endsOn: '2026-03-31' }

  it('compte les jours réels, bornes comprises (calendar_days, ADR 006)', () => {
    assert.deepEqual(prorataFraction('calendar_days', du10au31, mars), {
      numerator: 22,
      denominator: 31,
    })
  })

  it('compte en base 30 : le 31 n’existe pas (thirty_day_month)', () => {
    // Du 10 au 31 mars : 21/30 (ADR 023).
    assert.deepEqual(prorataFraction('thirty_day_month', du10au31, mars), {
      numerator: 21,
      denominator: 30,
    })
  })

  it('ne proratise rien sans prorata (none)', () => {
    assert.deepEqual(prorataFraction('none', du10au31, mars), { numerator: 1, denominator: 1 })
  })

  it('rend une fraction égale à 1 pour une période entière', () => {
    for (const rule of ['calendar_days', 'thirty_day_month', 'none'] as const) {
      const { numerator, denominator } = prorataFraction(rule, mars, mars)
      assert.equal(numerator, denominator, rule)
    }
  })
})

describe('thirtyDayCount', () => {
  it('compte la fin février comme un 30', () => {
    assert.equal(thirtyDayCount('2026-02-01', '2026-02-28'), 30)
    assert.equal(thirtyDayCount('2026-02-15', '2026-02-28'), 16)
    assert.equal(thirtyDayCount('2026-02-01', '2026-02-27'), 27)
  })

  it('distingue le 28 et le 29 février d’une année bissextile', () => {
    assert.equal(thirtyDayCount('2028-02-01', '2028-02-28'), 28)
    assert.equal(thirtyDayCount('2028-02-01', '2028-02-29'), 30)
  })

  it('ignore le 31 : du 1er au 30 mars vaut un mois entier', () => {
    assert.equal(thirtyDayCount('2026-03-01', '2026-03-30'), 30)
    assert.equal(thirtyDayCount('2026-03-31', '2026-03-31'), 1)
  })

  it('additionne les mois d’un trimestre', () => {
    assert.equal(thirtyDayCount('2026-02-01', '2026-03-31'), 60)
    assert.equal(thirtyDayCount('2026-01-01', '2026-03-31'), 90)
  })
})

/** Ce que la plupart des cas comparent : bornes, couverture, montant. */
const essentiel = (periods: ReturnType<typeof billingSchedule>) =>
  periods.map(({ startsOn, endsOn, full, amountCents }) => ({ startsOn, endsOn, full, amountCents }))

describe('billingSchedule', () => {
  it('facture un mois plein sans prorata', () => {
    const periods = billingSchedule(mensuel(), '2026-03-31')
    assert.deepEqual(periods, [
      {
        startsOn: '2026-03-01',
        endsOn: '2026-03-31',
        full: true,
        amountCents: 90_000,
        prorata: { numerator: 31, denominator: 31 },
        amendmentNumber: null,
        oneOffCents: 0,
      },
    ])
  })

  it('proratise le premier mois quand le contrat commence en cours de mois', () => {
    const periods = billingSchedule(mensuel({ startsOn: '2026-03-10' }), '2026-04-30')
    assert.equal(periods.length, 2)
    assert.deepEqual(essentiel(periods)[0], {
      startsOn: '2026-03-10',
      endsOn: '2026-03-31',
      full: false,
      // 900 € × 22/31 = 638,709… €, un seul arrondi.
      amountCents: 63_871,
    })
    assert.deepEqual(periods[0].prorata, { numerator: 22, denominator: 31 })
    assert.equal(periods[1].full, true)
    assert.equal(periods[1].amountCents, 90_000)
  })

  it('proratise le dernier mois sur le terme du contrat', () => {
    const periods = billingSchedule(
      mensuel({ startsOn: '2026-03-01', endsOn: '2026-04-15' }),
      '2026-12-31',
    )
    assert.equal(periods.length, 2)
    assert.deepEqual(essentiel(periods)[1], {
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
    assert.deepEqual(essentiel(periods)[1], {
      startsOn: '2026-02-01',
      endsOn: '2026-02-10',
      full: false,
      // 10 jours sur 28 : 321,428… €.
      amountCents: 32_143,
    })
  })

  it('suit les trimestres civils, pas les trimestres anniversaires', () => {
    const periods = billingSchedule(
      mensuel({ startsOn: '2026-02-01', billingPeriod: 'quarterly', amountCents: 270_000 }),
      '2026-06-30',
    )
    assert.deepEqual(essentiel(periods), [
      // 59 jours (février + mars) sur 90 (janvier à mars).
      { startsOn: '2026-02-01', endsOn: '2026-03-31', full: false, amountCents: 177_000 },
      { startsOn: '2026-04-01', endsOn: '2026-06-30', full: true, amountCents: 270_000 },
    ])
  })

  it('facture une année civile en une échéance', () => {
    const periods = billingSchedule(
      mensuel({ startsOn: '2026-01-01', billingPeriod: 'yearly', amountCents: 1_080_000 }),
      '2026-12-31',
    )
    assert.deepEqual(essentiel(periods), [
      { startsOn: '2026-01-01', endsOn: '2026-12-31', full: true, amountCents: 1_080_000 },
    ])
  })

  it('facture un contrat d’un seul jour', () => {
    const periods = billingSchedule(
      mensuel({ startsOn: '2026-03-10', endsOn: '2026-03-10' }),
      '2026-12-31',
    )
    assert.equal(periods.length, 1)
    // 900 € × 1/31 = 29,032… €.
    assert.equal(periods[0].amountCents, 2_903)
  })

  it('rend un entier de centimes, jamais un flottant', () => {
    const periods = billingSchedule(mensuel({ startsOn: '2026-03-31', amountCents: 100_000 }), '2026-03-31')
    assert.equal(Number.isInteger(periods[0].amountCents), true)
    assert.equal(periods[0].amountCents, 3_226)
  })
})

describe('billingSchedule : règle de prorata du centre (R10, ADR 023)', () => {
  it('base 30 : du 10 au 31 mars vaut 21/30', () => {
    const [mars] = billingSchedule(mensuel({ startsOn: '2026-03-10' }), '2026-03-31', {
      prorataRule: 'thirty_day_month',
    })
    assert.deepEqual(mars.prorata, { numerator: 21, denominator: 30 })
    assert.equal(mars.amountCents, 63_000)
  })

  it('base 30 : février entier est un mois entier', () => {
    const periods = billingSchedule(mensuel({ startsOn: '2026-02-01' }), '2026-02-28', {
      prorataRule: 'thirty_day_month',
    })
    assert.equal(periods[0].full, true)
    assert.equal(periods[0].amountCents, 90_000)
  })

  it('base 30 au trimestre : dénominateur 90', () => {
    const [premier] = billingSchedule(
      mensuel({ startsOn: '2026-02-01', billingPeriod: 'quarterly', amountCents: 270_000 }),
      '2026-03-31',
      { prorataRule: 'thirty_day_month' },
    )
    assert.deepEqual(premier.prorata, { numerator: 60, denominator: 90 })
    assert.equal(premier.amountCents, 180_000)
  })

  it('sans prorata : une période entamée est due en entier', () => {
    const periods = billingSchedule(
      mensuel({ startsOn: '2026-03-10', terminatedOn: '2026-04-15' }),
      '2026-12-31',
      { prorataRule: 'none' },
    )
    assert.deepEqual(
      periods.map((period) => period.amountCents),
      [90_000, 90_000],
    )
  })
})

describe('billingSchedule : versions de prix (ADR 025)', () => {
  const versions = [
    { amendmentNumber: null, startsOn: '2026-01-01', endsOn: '2026-03-14', amountCents: 90_000, lines: [] },
    { amendmentNumber: 1, startsOn: '2026-03-15', endsOn: null, amountCents: 120_000, lines: [] },
  ]

  it('coupe la période à la date d’effet de l’avenant', () => {
    const periods = billingSchedule(mensuel({ startsOn: '2026-01-01' }), '2026-04-30', { versions })
    const mars = periods.filter((period) => period.startsOn.startsWith('2026-03'))
    assert.deepEqual(
      mars.map(({ startsOn, endsOn, amountCents, amendmentNumber }) => ({
        startsOn,
        endsOn,
        amountCents,
        amendmentNumber,
      })),
      [
        // 900 € × 14/31 et 1 200 € × 17/31.
        { startsOn: '2026-03-01', endsOn: '2026-03-14', amountCents: 40_645, amendmentNumber: null },
        { startsOn: '2026-03-15', endsOn: '2026-03-31', amountCents: 65_806, amendmentNumber: 1 },
      ],
    )
    assert.equal(periods.at(-1)?.amountCents, 120_000)
  })

  it('en base 30, chaque morceau compte ses jours de base 30', () => {
    const periods = billingSchedule(mensuel({ startsOn: '2026-01-01' }), '2026-03-31', {
      versions,
      prorataRule: 'thirty_day_month',
    })
    // 900 € × 14/30 et 1 200 € × 16/30.
    assert.deepEqual(
      periods.slice(-2).map((period) => period.amountCents),
      [42_000, 64_000],
    )
  })

  it('sans prorata, l’avenant s’applique à la période suivante', () => {
    const periods = billingSchedule(mensuel({ startsOn: '2026-01-01' }), '2026-04-30', {
      versions,
      prorataRule: 'none',
    })
    assert.deepEqual(
      periods.map((period) => period.amountCents),
      [90_000, 90_000, 90_000, 120_000],
    )
  })

  it('facture une version ligne à ligne, remises comprises', () => {
    const lignes = [
      // Bureau à 500 € remisé de 10 %.
      { quantity: 1, unitPriceCents: 50_000, discountBp: 1_000, isRecurring: true },
      // Domiciliation à 30 € remisée de 5 €.
      { quantity: 1, unitPriceCents: 3_000, discountAmountCents: 500, isRecurring: true },
      // Frais de dossier, une fois.
      { quantity: 1, unitPriceCents: 15_000, isRecurring: false },
    ]
    const periods = billingSchedule(mensuel({ startsOn: '2026-03-10' }), '2026-04-30', {
      versions: [{ amendmentNumber: null, startsOn: '2026-03-10', endsOn: null, amountCents: 0, lines: lignes }],
    })
    // Mars, 22/31 : 450 € × 22/31 = 319,354… → 319,35 € ; 25 € × 22/31 =
    // 17,741… → 17,74 € ; plus 150 € de frais.
    assert.equal(periods[0].amountCents, 31_935 + 1_774 + 15_000)
    assert.equal(periods[0].oneOffCents, 15_000)
    // Avril entier, sans les frais.
    assert.equal(periods[1].amountCents, 45_000 + 2_500)
    assert.equal(periods[1].oneOffCents, 0)
  })
})

describe('engagement (R10, ADR 023)', () => {
  const engage = {
    ...mensuel({ startsOn: '2026-03-10', amountCents: 45_000 }),
    commitmentEndsOn: '2027-03-09',
  }

  it('totalise ce que l’engagement garantit, de date à date', () => {
    const engagement = commitmentSchedule(engage)
    assert.equal(engagement?.endsOn, '2027-03-09')
    assert.equal(engagement?.periods.length, 13)
    // 22/31 de mars, onze mois, 9/31 de mars suivant : douze mois exactement.
    assert.equal(engagement?.totalCents, 12 * 45_000)
  })

  it('ne rend rien sans engagement', () => {
    assert.equal(commitmentSchedule({ ...engage, commitmentEndsOn: null }), undefined)
  })

  it('reporte la fin possible au terme de l’engagement', () => {
    assert.equal(earliestEndOn('2026-06-01', 90, '2027-03-09'), '2027-03-09')
  })

  it('laisse le préavis l’emporter quand il finit après l’engagement', () => {
    assert.equal(earliestEndOn('2027-01-15', 90, '2027-03-09'), '2027-04-14')
    assert.equal(earliestEndOn('2027-01-15', 90, null), '2027-04-14')
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
