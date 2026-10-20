import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { can } from '../../../lib/auth/permissions.ts'
import { dayTimeline, todoTiles } from './journee.ts'

const counts = { requests: 3, mailRequests: 1, inspectionsToFinish: 0, inspectionsToSign: 2 }

describe('tuiles « à traiter »', () => {
  it('dit le nombre et accorde le pluriel', () => {
    const labels = todoTiles(counts, () => true).map((tile) => tile.label)
    assert.deepEqual(labels, [
      '3 demandes à traiter',
      '1 demande de courrier',
      'Aucun état des lieux en cours',
      '2 états des lieux à faire signer',
    ])
  })

  it('garde les files vides : « rien à traiter » est une information', () => {
    const tiles = todoTiles({ requests: 0, mailRequests: 0, inspectionsToFinish: 0, inspectionsToSign: 0 }, () => true)
    assert.equal(tiles.length, 4)
    assert.ok(tiles.every((tile) => tile.count === 0))
  })

  it('ne montre que les files que le rôle peut traiter', () => {
    const keys = todoTiles(counts, (permission) => permission === 'courrier.gerer').map((tile) => tile.key)
    assert.deepEqual(keys, ['mailRequests'])
  })

  it('montre tout à l’accueil comme à l’exploitant', () => {
    for (const role of ['staff', 'admin'] as const) {
      assert.equal(todoTiles(counts, (permission) => can(role, permission)).length, 4, role)
    }
  })
})

describe('journée du planning', () => {
  const at = (hour: number) => new Date(Date.UTC(2026, 9, 20, hour))
  const booking = (id: string, from: number, to: number, status: 'pending' | 'confirmed' | 'cancelled' = 'confirmed') =>
    ({ id, kind: 'booking' as const, status, startsAt: at(from), endsAt: at(to) })

  it('range par heure et situe chaque réservation par rapport à maintenant', () => {
    const timeline = dayTimeline([booking('apres', 14, 16), booking('avant', 7, 9), booking('pendant', 9, 11)], at(10))
    assert.deepEqual(timeline.map((item) => [item.id, item.moment]), [
      ['avant', 'termine'],
      ['pendant', 'en_cours'],
      ['apres', 'a_venir'],
    ])
  })

  it('bornes [) : finie à 10 h, terminée à 10 h ; commencée à 10 h, en cours à 10 h', () => {
    const timeline = dayTimeline([booking('fin', 8, 10), booking('debut', 10, 12)], at(10))
    assert.deepEqual(timeline.map((item) => item.moment), ['termine', 'en_cours'])
  })

  it('ne garde que les réservations : ni occupation de contrat, ni indisponibilité', () => {
    const timeline = dayTimeline([
      { ...booking('contrat', 0, 23), kind: 'contract' as const },
      { ...booking('travaux', 8, 12), kind: 'unavailability' as const },
      booking('reunion', 9, 10),
    ], at(8))
    assert.deepEqual(timeline.map((item) => item.id), ['reunion'])
  })

  it('retire les annulées, garde les demandes à valider', () => {
    const timeline = dayTimeline([booking('annulee', 9, 10, 'cancelled'), booking('demande', 11, 12, 'pending')], at(8))
    assert.deepEqual(timeline.map((item) => item.id), ['demande'])
  })
})
