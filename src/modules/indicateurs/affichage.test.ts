import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatDay, formatPeriod, monthPoints } from './affichage.ts'

describe('mise en forme des indicateurs', () => {
  it('écrit les jours à la française, « 1er » compris', () => {
    assert.equal(formatDay('2026-10-01'), '1er octobre 2026')
    assert.equal(formatDay('2026-10-14'), '14 octobre 2026')
    assert.equal(formatPeriod({ from: '2026-10-01', to: '2026-10-31' }), 'du 1er octobre 2026 au 31 octobre 2026')
    assert.equal(formatPeriod({ from: '2026-10-14', to: '2026-10-14' }), 'le 14 octobre 2026')
  })

  it('nomme les mois de l’axe, l’année sous le premier et sous janvier', () => {
    const points = monthPoints(
      [
        { month: '2026-11', value: 1 },
        { month: '2026-12', value: 2 },
        { month: '2027-01', value: 3 },
      ],
      (value) => `${value} €`,
    )
    assert.deepEqual(
      points.map((point) => [point.label, point.shortLabel, point.year, point.display]),
      [
        ['novembre 2026', 'nov.', '2026', '1 €'],
        ['décembre 2026', 'déc.', undefined, '2 €'],
        ['janvier 2027', 'janv.', '2027', '3 €'],
      ],
    )
  })
})
