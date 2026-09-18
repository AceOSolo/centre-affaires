import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatTime } from '../../lib/dates.ts'
import { isoWeekday, openingWindows } from '../ressources/ouverture.ts'
import { weekColumns, weekDays, weekExtent, weekStart } from './semaine.ts'

const PARIS = 'Europe/Paris'

const ouverture = (isoDate: string, opensAt: string, closesAt: string) =>
  openingWindows(isoDate, PARIS, {
    rules: [{ resourceId: null, weekday: isoWeekday(isoDate), opensAt, closesAt }],
    resourceId: 'resource',
  })

describe('weekStart et weekDays', () => {
  it('remonte au lundi depuis n’importe quel jour', () => {
    // 2026-09-18 est un vendredi, 2026-09-20 un dimanche.
    assert.equal(weekStart('2026-09-18'), '2026-09-14')
    assert.equal(weekStart('2026-09-20'), '2026-09-14')
    assert.equal(weekStart('2026-09-14'), '2026-09-14')
  })

  it('rend sept jours, du lundi au dimanche', () => {
    const jours = weekDays('2026-09-18')
    assert.equal(jours.length, 7)
    assert.equal(jours[0], '2026-09-14')
    assert.equal(jours[6], '2026-09-20')
  })

  it('franchit un changement de mois', () => {
    assert.deepEqual(weekDays('2026-10-01').slice(0, 3), ['2026-09-28', '2026-09-29', '2026-09-30'])
  })
})

describe('weekExtent', () => {
  it('va de la première ouverture à la dernière fermeture', () => {
    const plages = [
      ...ouverture('2026-09-14', '09:00:00', '18:00:00'),
      ...ouverture('2026-09-15', '08:00:00', '17:00:00'),
    ]
    assert.deepEqual(weekExtent(plages, PARIS), { openHour: 8, closeHour: 18 })
  })

  it('arrondit à l’heure supérieure une fermeture à la demie', () => {
    const plages = ouverture('2026-09-14', '09:00:00', '18:30:00')
    assert.deepEqual(weekExtent(plages, PARIS), { openHour: 9, closeHour: 19 })
  })

  it('retombe sur l’amplitude de repli quand la semaine est fermée', () => {
    assert.deepEqual(weekExtent([], PARIS), { openHour: 8, closeHour: 19 })
  })

  it('couvre la journée entière quand une plage court jusqu’à minuit', () => {
    const plages = ouverture('2026-09-18', '18:00:00', '24:00:00')
    assert.deepEqual(weekExtent(plages, PARIS), { openHour: 18, closeHour: 24 })
  })
})

describe('weekColumns', () => {
  const extent = { openHour: 9, closeHour: 18 }
  const openingByDay = Object.fromEntries(
    weekDays('2026-09-18').map((jour) => [
      jour,
      isoWeekday(jour) <= 5 ? ouverture(jour, '09:00:00', '18:00:00') : [],
    ]),
  )

  it('rend sept colonnes numérotées du lundi au dimanche', () => {
    const colonnes = weekColumns('2026-09-18', PARIS, extent, openingByDay)
    assert.equal(colonnes.length, 7)
    assert.deepEqual(
      colonnes.map((c) => c.weekday),
      [1, 2, 3, 4, 5, 6, 7],
    )
  })

  it('marque le week-end fermé', () => {
    const colonnes = weekColumns('2026-09-18', PARIS, extent, openingByDay)
    assert.deepEqual(
      colonnes.map((c) => c.closed),
      [false, false, false, false, false, true, true],
    )
  })

  it('aligne toutes les colonnes sur la même heure murale', () => {
    const colonnes = weekColumns('2026-09-18', PARIS, extent, openingByDay)
    for (const colonne of colonnes) {
      assert.equal(formatTime(colonne.window.startsAt, PARIS), '09:00')
      assert.equal(formatTime(colonne.window.endsAt, PARIS), '18:00')
    }
  })

  it('garde la même durée de part et d’autre d’un changement d’heure', () => {
    // Semaine du 26 octobre 2026 : le changement a eu lieu le dimanche 25.
    const colonnes = weekColumns('2026-10-26', PARIS, extent, {})
    const durees = colonnes.map(
      (c) => (c.window.endsAt.getTime() - c.window.startsAt.getTime()) / 3_600_000,
    )
    assert.deepEqual(durees, [9, 9, 9, 9, 9, 9, 9])
  })

  it('couvre la journée civile entière, 25 heures comprises', () => {
    // Dimanche 25 octobre 2026 : la journée fait 25 heures.
    const [, , , , , , dimanche] = weekColumns(
      '2026-10-25',
      PARIS,
      { openHour: 0, closeHour: 24 },
      {},
    )
    assert.equal(dimanche.isoDate, '2026-10-25')
    assert.equal(
      (dimanche.window.endsAt.getTime() - dimanche.window.startsAt.getTime()) / 3_600_000,
      25,
    )
  })
})
