import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { dayAvailability } from './disponibilites.ts'

/**
 * Moteur commun des disponibilités (R02, R23) : le même calcul pour la page
 * publique, le back-office et l'espace client, qui ne lit des autres
 * réservations que leurs heures.
 */
const SALLE = 'salle'
const BUREAU = 'bureau'
const rules = [
  // Le centre : 9 h – 12 h et 14 h – 18 h en semaine.
  ...[1, 2, 3, 4, 5].flatMap((weekday) => [
    { resourceId: null, weekday, opensAt: '09:00', closesAt: '12:00' },
    { resourceId: null, weekday, opensAt: '14:00', closesAt: '18:00' },
  ]),
]
const at = (wall: string) => new Date(`${wall}:00Z`)

describe('disponibilités d’une journée', () => {
  it('retire les créneaux occupés des plages d’ouverture, ressource par ressource', () => {
    const [salle, bureau] = dayAvailability(
      '2026-10-06',
      'UTC',
      [{ id: SALLE }, { id: BUREAU }],
      [{ resourceId: SALLE, startsAt: at('2026-10-06T10:00'), endsAt: at('2026-10-06T11:00') }],
      { rules, closures: [] },
    )
    assert.deepEqual(
      salle.free.map((range) => [range.startsAt.toISOString(), range.endsAt.toISOString()]),
      [
        ['2026-10-06T09:00:00.000Z', '2026-10-06T10:00:00.000Z'],
        ['2026-10-06T11:00:00.000Z', '2026-10-06T12:00:00.000Z'],
        ['2026-10-06T14:00:00.000Z', '2026-10-06T18:00:00.000Z'],
      ],
    )
    assert.equal(salle.freeMinutes, 6 * 60)
    assert.equal(bureau.freeMinutes, 7 * 60)
    assert.equal(salle.closed, false)
  })

  it('distingue « fermé » de « complet »', () => {
    const [dimanche] = dayAvailability('2026-10-04', 'UTC', [{ id: SALLE }], [], { rules, closures: [] })
    assert.equal(dimanche.closed, true)
    const [complet] = dayAvailability(
      '2026-10-06',
      'UTC',
      [{ id: SALLE }],
      [{ resourceId: SALLE, startsAt: at('2026-10-06T08:00'), endsAt: at('2026-10-06T19:00') }],
      { rules, closures: [] },
    )
    assert.equal(complet.closed, false)
    assert.equal(complet.free.length, 0)
  })

  it('ferme une ressource un jour de fermeture exceptionnelle', () => {
    const [salle, bureau] = dayAvailability('2026-10-06', 'UTC', [{ id: SALLE }, { id: BUREAU }], [], {
      rules,
      closures: [{ resourceId: SALLE, startsOn: '2026-10-06', endsOn: '2026-10-06' }],
    })
    assert.equal(salle.closed, true)
    assert.equal(bureau.closed, false)
  })
})
