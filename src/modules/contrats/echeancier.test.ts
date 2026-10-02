import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  addDays,
  addMonths,
  billingSchedule,
  commitmentEndsOn,
  commitmentSchedule,
  contractSchedule,
  daysInclusive,
  earliestEndOn,
  noticeEndsOn,
  periodEnd,
  periodStart,
  prorataCents,
  prorataFraction,
  scheduleTotalCents,
  type ScheduledContract,
  type ScheduleVersion,
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

describe('prorataFraction : règle du centre (ADR 023)', () => {
  it('compte les jours réels par défaut', () => {
    assert.deepEqual(prorataFraction('calendar_days', '2026-03-10', '2026-03-31', 'monthly'), {
      numerator: 22,
      denominator: 31,
    })
    assert.deepEqual(prorataFraction('calendar_days', '2026-02-01', '2026-03-31', 'quarterly'), {
      numerator: 59,
      denominator: 90,
    })
  })

  it('compte en mois de 30 jours : le 31 n’existe pas, le dernier jour vaut le 30', () => {
    // L'exemple de l'ADR 023 : du 10 au 31 mars, 21/30.
    assert.deepEqual(prorataFraction('thirty_day_month', '2026-03-10', '2026-03-31', 'monthly'), {
      numerator: 21,
      denominator: 30,
    })
    // Fin février : le 28 compte comme le 30.
    assert.deepEqual(prorataFraction('thirty_day_month', '2026-02-15', '2026-02-28', 'monthly'), {
      numerator: 16,
      denominator: 30,
    })
    assert.deepEqual(prorataFraction('thirty_day_month', '2026-02-01', '2026-02-28', 'monthly'), {
      numerator: 30,
      denominator: 30,
    })
    // Le 31 seul ne compte rien.
    assert.deepEqual(prorataFraction('thirty_day_month', '2026-03-31', '2026-03-31', 'monthly'), {
      numerator: 0,
      denominator: 30,
    })
    // Sur un trimestre : février (16, du 15 au 28) et mars (30), sur 90.
    assert.deepEqual(prorataFraction('thirty_day_month', '2026-02-15', '2026-03-31', 'quarterly'), {
      numerator: 46,
      denominator: 90,
    })
  })

  it('donne, en base 30, des morceaux d’un même mois qui s’additionnent à 30', () => {
    for (const cut of ['2026-02-15', '2028-02-29', '2026-03-31', '2026-03-16', '2026-04-30']) {
      const first = prorataFraction(
        'thirty_day_month',
        periodStart(cut, 'monthly'),
        addDays(cut, -1),
        'monthly',
      )
      const rest = prorataFraction('thirty_day_month', cut, periodEnd(cut, 'monthly'), 'monthly')
      assert.equal(first.numerator + rest.numerator, 30, cut)
    }
  })

  it('ne proratise rien en règle « none »', () => {
    assert.deepEqual(prorataFraction('none', '2026-03-10', '2026-03-31', 'monthly'), {
      numerator: 1,
      denominator: 1,
    })
  })
})

describe('contractSchedule : échéancier versionné (ADR 025)', () => {
  const contrat: ScheduledContract = {
    startsOn: '2026-03-01',
    billingPeriod: 'monthly',
    amountCents: 90_000,
  }
  const initiale: ScheduleVersion = {
    amendmentId: null,
    amendmentNumber: null,
    startsOn: '2026-03-01',
    endsOn: '2026-06-14',
    amountCents: 90_000,
  }
  const avenant: ScheduleVersion = {
    amendmentId: 'avenant-1',
    amendmentNumber: 1,
    startsOn: '2026-06-15',
    endsOn: null,
    amountCents: 95_000,
  }

  it('coupe la période au jour d’effet de l’avenant et proratise chaque morceau', () => {
    const periods = contractSchedule(contrat, [initiale, avenant], '2026-07-31')
    assert.equal(periods.length, 5)
    const juin = periods[3]
    assert.equal(juin.startsOn, '2026-06-01')
    assert.equal(juin.full, true)
    assert.deepEqual(
      juin.pieces.map((piece) => [
        piece.startsOn,
        piece.endsOn,
        piece.amendmentNumber,
        piece.numerator,
        piece.denominator,
        piece.amountCents,
      ]),
      [
        // 14 jours sur 30 à 900 €, puis 16 sur 30 à 950 €.
        ['2026-06-01', '2026-06-14', null, 14, 30, 42_000],
        ['2026-06-15', '2026-06-30', 1, 16, 30, 50_667],
      ],
    )
    assert.equal(juin.amountCents, 42_000 + 50_667)
    // Juillet est entièrement au nouveau prix.
    assert.equal(periods[4].amountCents, 95_000)
    assert.equal(periods[4].pieces[0].amendmentId, 'avenant-1')
  })

  it('suit la règle du mois de 30 jours au jour d’effet', () => {
    const periods = contractSchedule(
      contrat,
      [{ ...initiale, endsOn: '2026-07-14' }, { ...avenant, startsOn: '2026-07-15' }],
      '2026-07-31',
      'thirty_day_month',
    )
    // Juillet compte 31 jours réels : du 1er au 14 (14/30), du 15 au 31 (16/30).
    assert.deepEqual(
      periods[4].pieces.map((piece) => [piece.numerator, piece.denominator, piece.amountCents]),
      [
        [14, 30, 42_000],
        [16, 30, 50_667],
      ],
    )
  })

  it('en règle « none », garde la période entière au prix en vigueur sur son premier jour', () => {
    const periods = contractSchedule(contrat, [initiale, avenant], '2026-07-31', 'none')
    const [juinAncien, juinNouveau] = periods[3].pieces
    assert.equal(juinAncien.amountCents, 90_000)
    assert.equal(juinNouveau.numerator, 0)
    assert.equal(juinNouveau.amountCents, 0)
    assert.equal(periods[3].amountCents, 90_000)
    assert.equal(periods[4].amountCents, 95_000)
    // Une période d'entrée partielle est due en entier.
    const tardif = contractSchedule(
      { ...contrat, startsOn: '2026-03-10' },
      [{ ...initiale, startsOn: '2026-03-10' }],
      '2026-03-31',
      'none',
    )
    assert.equal(tardif[0].full, false)
    assert.equal(tardif[0].amountCents, 90_000)
  })

  it('facture une version ligne à ligne, au centime de la base', () => {
    const lignes: ScheduleVersion = {
      ...initiale,
      startsOn: '2026-03-10',
      endsOn: null,
      amountCents: 107_000,
      lines: [
        { quantity: 1, unitPriceCents: 80_000, isRecurring: true },
        // 2 × 150 € remisés de 10 % : 270 € par mois.
        { quantity: 2, unitPriceCents: 15_000, discountBp: 1_000, isRecurring: true },
        { quantity: 1, unitPriceCents: 5_000, isRecurring: false },
      ],
    }
    const [mars, avril] = contractSchedule(
      { ...contrat, startsOn: '2026-03-10' },
      [lignes],
      '2026-04-30',
    )
    // Chaque ligne est proratisée et arrondie seule : 22/31 de 800 € et de 270 €.
    assert.equal(mars.pieces[0].amountCents, 56_774 + 19_161)
    // Les frais de dossier sont dus une fois, dans la période du premier jour.
    assert.equal(mars.pieces[0].oneOffCents, 5_000)
    assert.equal(mars.amountCents, 56_774 + 19_161 + 5_000)
    assert.equal(avril.amountCents, 107_000)
    assert.equal(avril.pieces[0].oneOffCents, 0)
  })

  it('reste celui d’avant pour un contrat sans version', () => {
    const versionne = contractSchedule({ ...contrat, startsOn: '2026-03-10' }, [], '2026-04-30')
    const simple = billingSchedule({ ...contrat, startsOn: '2026-03-10' }, '2026-04-30')
    assert.deepEqual(
      versionne.map(({ startsOn, endsOn, full, amountCents }) => ({
        startsOn,
        endsOn,
        full,
        amountCents,
      })),
      simple,
    )
  })

  it('s’arrête à la résiliation, même au milieu d’une version', () => {
    const periods = contractSchedule(
      { ...contrat, terminatedOn: '2026-06-20' },
      [initiale, avenant],
      '2026-12-31',
    )
    const dernier = periods.at(-1)
    assert.equal(dernier?.endsOn, '2026-06-20')
    assert.equal(dernier?.pieces.at(-1)?.endsOn, '2026-06-20')
    // Du 15 au 20 juin : 6 jours sur 30 de 950 €.
    assert.equal(dernier?.pieces.at(-1)?.amountCents, 19_000)
  })
})

describe('engagement et préavis (ADR 023)', () => {
  it('ajoute des mois comme Postgres, en ramenant au dernier jour du mois', () => {
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28')
    assert.equal(addMonths('2028-01-31', 1), '2028-02-29')
    assert.equal(addMonths('2026-03-10', 12), '2027-03-10')
    assert.equal(addMonths('2026-11-15', 3), '2027-02-15')
  })

  it('calcule la fin d’engagement de date à date', () => {
    assert.equal(commitmentEndsOn('2026-03-10', 12), '2027-03-09')
    assert.equal(commitmentEndsOn('2026-03-01', 1), '2026-03-31')
    assert.equal(commitmentEndsOn('2026-01-31', 1), '2026-02-27')
    assert.equal(commitmentEndsOn('2026-03-10', null), null)
  })

  it('retient le plus tardif du préavis et de la fin d’engagement', () => {
    assert.equal(earliestEndOn('2026-04-01', 90, '2027-03-09'), '2027-03-09')
    assert.equal(earliestEndOn('2027-03-01', 90, '2027-03-09'), '2027-05-29')
    assert.equal(earliestEndOn('2026-03-01', 90, null), '2026-05-29')
  })
})

describe('règle de prorata du centre sur l’échéancier (R10, ADR 023)', () => {
  const dixMars: ScheduledContract = {
    startsOn: '2026-03-10',
    billingPeriod: 'monthly',
    amountCents: 90_000,
  }

  it('rend une fraction égale à 1 pour une période entière, quelle que soit la règle', () => {
    for (const rule of ['calendar_days', 'thirty_day_month', 'none'] as const) {
      const { numerator, denominator } = prorataFraction(rule, '2026-03-01', '2026-03-31', 'monthly')
      assert.equal(numerator, denominator, rule)
    }
  })

  it('distingue, en base 30, le 28 et le 29 février d’une année bissextile', () => {
    assert.equal(prorataFraction('thirty_day_month', '2028-02-01', '2028-02-28', 'monthly').numerator, 28)
    assert.equal(prorataFraction('thirty_day_month', '2028-02-01', '2028-02-29', 'monthly').numerator, 30)
    // Du 1er au 30 mars vaut un mois entier.
    assert.equal(prorataFraction('thirty_day_month', '2026-03-01', '2026-03-30', 'monthly').numerator, 30)
  })

  it('base 30 : du 10 au 31 mars vaut 21/30 de la mensualité', () => {
    const [mars] = contractSchedule(dixMars, [], '2026-03-31', 'thirty_day_month')
    assert.deepEqual([mars.pieces[0].numerator, mars.pieces[0].denominator], [21, 30])
    assert.equal(mars.amountCents, 63_000)
  })

  it('base 30 au trimestre : dénominateur 90', () => {
    const [premier] = contractSchedule(
      { startsOn: '2026-02-01', billingPeriod: 'quarterly', amountCents: 270_000 },
      [],
      '2026-03-31',
      'thirty_day_month',
    )
    assert.deepEqual([premier.pieces[0].numerator, premier.pieces[0].denominator], [60, 90])
    assert.equal(premier.amountCents, 180_000)
  })

  it('sans prorata : une période entamée, à l’entrée comme à la sortie, est due en entier', () => {
    const periods = contractSchedule(
      { ...dixMars, terminatedOn: '2026-04-15' },
      [],
      '2026-12-31',
      'none',
    )
    assert.deepEqual(
      periods.map((period) => period.amountCents),
      [90_000, 90_000],
    )
  })
})

describe('commitmentSchedule : ce que l’engagement garantit (R10, ADR 023)', () => {
  const engage = {
    startsOn: '2026-03-10',
    billingPeriod: 'monthly' as const,
    amountCents: 45_000,
    commitmentEndsOn: '2027-03-09',
  }

  it('totalise les périodes dues jusqu’à la fin d’engagement, de date à date', () => {
    const engagement = commitmentSchedule(engage)
    assert.equal(engagement?.endsOn, '2027-03-09')
    assert.equal(engagement?.periods.length, 13)
    // 22/31 de mars, onze mois, 9/31 de mars suivant : douze mois exactement.
    assert.equal(engagement?.totalCents, 12 * 45_000)
  })

  it('suit les versions de prix et la règle du centre', () => {
    const engagement = commitmentSchedule(
      { ...engage, startsOn: '2026-03-01', commitmentEndsOn: '2026-04-30' },
      [
        { amendmentId: null, amendmentNumber: null, startsOn: '2026-03-01', endsOn: '2026-03-31', amountCents: 45_000 },
        { amendmentId: 'avenant-1', amendmentNumber: 1, startsOn: '2026-04-01', endsOn: null, amountCents: 50_000 },
      ],
      'thirty_day_month',
    )
    assert.equal(engagement?.totalCents, 45_000 + 50_000)
  })

  it('ne rend rien sans engagement', () => {
    assert.equal(commitmentSchedule({ ...engage, commitmentEndsOn: null }), undefined)
  })
})
