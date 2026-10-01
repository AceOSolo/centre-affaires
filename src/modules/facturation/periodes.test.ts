import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  billablePieces,
  civilPeriods,
  formatPeriod,
  monthRange,
  prorataFor,
  runWindows,
  subtractRanges,
} from './periodes.ts'

/**
 * Calendrier de la facturation périodique (ADR 023, 026, 029) : fenêtres d'un
 * lot, périodes civiles, jours restant à facturer, prorata selon la règle du
 * centre, morceaux coupés aux versions d'un contrat.
 */
describe('fenêtres d’un lot', () => {
  it('cadre un mois civil, fin février comprise', () => {
    assert.deepEqual(monthRange('2026-10'), { start: '2026-10-01', end: '2026-10-31' })
    assert.deepEqual(monthRange('2026-02'), { start: '2026-02-01', end: '2026-02-28' })
    assert.deepEqual(monthRange('2028-02'), { start: '2028-02-01', end: '2028-02-29' })
  })

  it('facture à échoir le récurrent du mois, les consommations du mois précédent', () => {
    assert.deepEqual(runWindows('2026-10', 'in_advance'), {
      invoice: { start: '2026-10-01', end: '2026-10-31' },
      recurring: { start: '2026-10-01', end: '2026-10-31' },
      consumption: { start: '2026-09-01', end: '2026-09-30' },
    })
  })

  it('facture à terme échu le récurrent du mois précédent, y compris en janvier', () => {
    const windows = runWindows('2027-01', 'in_arrears')
    assert.deepEqual(windows.invoice, { start: '2027-01-01', end: '2027-01-31' })
    assert.deepEqual(windows.recurring, { start: '2026-12-01', end: '2026-12-31' })
    assert.deepEqual(windows.consumption, { start: '2026-12-01', end: '2026-12-31' })
  })
})

describe('périodes civiles', () => {
  it('rend le mois, le trimestre ou l’année qui touche la fenêtre', () => {
    const octobre = monthRange('2026-10')
    assert.deepEqual(civilPeriods(octobre, 'monthly'), [octobre])
    assert.deepEqual(civilPeriods(octobre, 'quarterly'), [{ start: '2026-10-01', end: '2026-12-31' }])
    assert.deepEqual(civilPeriods(octobre, 'yearly'), [{ start: '2026-01-01', end: '2026-12-31' }])
  })
})

describe('jours restant à facturer', () => {
  const octobre = monthRange('2026-10')

  it('rend toute la période quand rien n’est facturé', () => {
    assert.deepEqual(subtractRanges(octobre, []), [octobre])
  })

  it('ne rend rien d’une période déjà facturée : un lot rejoué ne refacture pas', () => {
    assert.deepEqual(subtractRanges(octobre, [octobre]), [])
    assert.deepEqual(subtractRanges(octobre, [{ start: '2026-09-15', end: '2026-11-15' }]), [])
  })

  it('rend les trous, dans l’ordre, chevauchements compris', () => {
    assert.deepEqual(
      subtractRanges(octobre, [
        { start: '2026-10-20', end: '2026-10-25' },
        { start: '2026-10-05', end: '2026-10-12' },
        { start: '2026-10-10', end: '2026-10-11' },
      ]),
      [
        { start: '2026-10-01', end: '2026-10-04' },
        { start: '2026-10-13', end: '2026-10-19' },
        { start: '2026-10-26', end: '2026-10-31' },
      ],
    )
  })

  it('ignore ce qui est facturé hors de la période', () => {
    assert.deepEqual(subtractRanges(octobre, [{ start: '2026-09-01', end: '2026-09-30' }]), [octobre])
  })
})

describe('prorata d’une période partielle (ADR 023)', () => {
  const mars = monthRange('2026-03')

  it('ne proratise pas une période complète', () => {
    assert.equal(prorataFor('calendar_days', mars, mars, 'monthly'), null)
    assert.equal(prorataFor('thirty_day_month', mars, mars, 'monthly'), null)
  })

  it('jours réels : du 10 au 31 mars, 22/31', () => {
    assert.deepEqual(prorataFor('calendar_days', { start: '2026-03-10', end: '2026-03-31' }, mars, 'monthly'), {
      numerator: 22,
      denominator: 31,
    })
  })

  it('base 30 : du 10 au 31 mars, 21/30', () => {
    assert.deepEqual(
      prorataFor('thirty_day_month', { start: '2026-03-10', end: '2026-03-31' }, mars, 'monthly'),
      { numerator: 21, denominator: 30 },
    )
  })

  it('base 30 : le dernier jour d’un mois compte comme le 30, fin février comprise', () => {
    const fevrier = monthRange('2026-02')
    assert.equal(prorataFor('thirty_day_month', fevrier, fevrier, 'monthly'), null)
    assert.deepEqual(
      prorataFor('thirty_day_month', { start: '2026-02-15', end: '2026-02-28' }, fevrier, 'monthly'),
      { numerator: 16, denominator: 30 },
    )
    // Un 31 isolé ne compte rien : les morceaux d'un mois s'additionnent à 30.
    assert.deepEqual(
      prorataFor('thirty_day_month', { start: '2026-03-31', end: '2026-03-31' }, mars, 'monthly'),
      { numerator: 0, denominator: 30 },
    )
  })

  it('base 30 au trimestre : dénominateur 90, jours comptés mois par mois', () => {
    const trimestre = { start: '2026-01-01', end: '2026-03-31' }
    assert.deepEqual(
      prorataFor('thirty_day_month', { start: '2026-02-15', end: '2026-03-31' }, trimestre, 'quarterly'),
      { numerator: 16 + 30, denominator: 90 },
    )
  })

  it('sans prorata : une période entamée est due en entier', () => {
    assert.equal(prorataFor('none', { start: '2026-03-30', end: '2026-03-31' }, mars, 'monthly'), null)
  })
})

describe('morceaux facturés par un lot', () => {
  const initiale = { startsOn: '2026-01-01', endsOn: null }

  it('à échoir : le mois du lot, et le premier mois partiel dans le lot de son mois', () => {
    const octobre = monthRange('2026-10')
    assert.deepEqual(
      billablePieces([initiale], 'monthly', octobre, 'in_advance').map((piece) => piece.piece),
      [octobre],
    )
    assert.deepEqual(
      billablePieces([{ startsOn: '2026-10-10', endsOn: null }], 'monthly', octobre, 'in_advance').map(
        (piece) => piece.piece,
      ),
      [{ start: '2026-10-10', end: '2026-10-31' }],
    )
  })

  it('coupe la période à la date d’effet d’un avenant', () => {
    const versions = [
      { startsOn: '2026-01-01', endsOn: '2026-10-14' },
      { startsOn: '2026-10-15', endsOn: null },
    ]
    const pieces = billablePieces(versions, 'monthly', monthRange('2026-10'), 'in_advance')
    assert.deepEqual(
      pieces.map((piece) => [piece.version.startsOn, piece.piece]),
      [
        ['2026-01-01', { start: '2026-10-01', end: '2026-10-14' }],
        ['2026-10-15', { start: '2026-10-15', end: '2026-10-31' }],
      ],
    )
  })

  it('facture un trimestre une seule fois : dans le lot de son premier mois à échoir', () => {
    assert.equal(billablePieces([initiale], 'quarterly', monthRange('2026-10'), 'in_advance').length, 1)
    assert.equal(billablePieces([initiale], 'quarterly', monthRange('2026-11'), 'in_advance').length, 0)
  })

  it('à terme échu : le morceau qui finit dans la fenêtre, résiliation comprise', () => {
    const septembre = monthRange('2026-09')
    assert.deepEqual(
      billablePieces([{ startsOn: '2026-01-01', endsOn: '2026-09-15' }], 'monthly', septembre, 'in_arrears').map(
        (piece) => piece.piece,
      ),
      [{ start: '2026-09-01', end: '2026-09-15' }],
    )
    assert.equal(billablePieces([initiale], 'quarterly', monthRange('2026-11'), 'in_arrears').length, 0)
    assert.equal(billablePieces([initiale], 'quarterly', monthRange('2026-12'), 'in_arrears').length, 1)
  })

  it('ne facture rien après le dernier jour du contrat', () => {
    assert.equal(
      billablePieces([{ startsOn: '2026-01-01', endsOn: '2026-09-30' }], 'monthly', monthRange('2026-10'), 'in_advance')
        .length,
      0,
    )
  })
})

describe('période lisible', () => {
  it('dit un mois entier, un jour, ou des bornes', () => {
    assert.equal(formatPeriod('2026-10-01', '2026-10-31'), 'octobre 2026')
    assert.equal(formatPeriod('2026-09-12', '2026-09-12'), 'le 12/09/2026')
    assert.equal(formatPeriod('2026-10-10', '2026-10-31'), 'du 10/10/2026 au 31/10/2026')
  })
})
