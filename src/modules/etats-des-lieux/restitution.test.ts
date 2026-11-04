import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  bookingBlockClass,
  bookingLabel,
  bookingSegmentClass,
  bookingStateLabel,
  type DisplayableBooking,
} from '../reservations/affichage.ts'
import { conflictingBookingIds, markConflicts, unreturnedFor, type UnreturnedOccupation } from './restitution.ts'

const occupation = (resourceId: string, conflicts: string[]): UnreturnedOccupation => ({
  entryId: `e-${resourceId}`,
  since: new Date('2026-11-04T11:00:00Z'),
  resource: { id: resourceId, name: 'Utilitaire', code: 'V-1', resourceType: 'vehicule' },
  client: { id: 'c1', name: 'Atelier Durand' },
  booking: { id: `b-${resourceId}`, title: 'Déménagement', startsAt: new Date('2026-11-04T07:00:00Z') },
  contract: null,
  conflicts: conflicts.map((id) => ({
    id,
    kind: 'booking',
    status: 'confirmed',
    title: 'Livraison',
    startsAt: new Date('2026-11-04T13:00:00Z'),
    endsAt: new Date('2026-11-04T15:00:00Z'),
    clientId: 'c2',
    clientName: 'Boulangerie Petit',
    contractId: null,
  })),
})

const reservation = (overrides: Partial<DisplayableBooking> = {}): DisplayableBooking => ({
  id: 'y',
  kind: 'booking',
  status: 'confirmed',
  title: 'Livraison',
  startsAt: new Date('2026-11-04T13:00:00Z'),
  endsAt: new Date('2026-11-04T15:00:00Z'),
  clientId: null,
  contractId: null,
  ...overrides,
})

describe('réservations en conflit avec une ressource non restituée (ADR 063)', () => {
  it('marque les réservations en conflit, et elles seules', () => {
    const retards = [occupation('r1', ['y', 'z']), occupation('r2', ['w'])]
    assert.deepEqual([...conflictingBookingIds(retards)].sort(), ['w', 'y', 'z'])
    assert.deepEqual(
      markConflicts([{ id: 'y' }, { id: 'a' }], retards),
      [{ id: 'y', conflict: true }, { id: 'a' }],
    )
    assert.deepEqual(unreturnedFor(retards, 'r2').map((retard) => retard.entryId), ['e-r2'])
    // Rien à marquer : la liste ressort telle quelle.
    assert.deepEqual(markConflicts([{ id: 'y' }], []), [{ id: 'y' }])
  })

  it('dit le conflit en toutes lettres, pas seulement en couleur', () => {
    const conflit = reservation({ conflict: true })
    assert.equal(bookingLabel(conflit), 'Conflit — Livraison')
    assert.equal(bookingStateLabel(conflit), 'Conflit — ressource non restituée')
    assert.match(bookingBlockClass(conflit), /statut-conflit/)
    assert.equal(bookingSegmentClass(conflit), 'bg-statut-conflit')
    // Sans conflit, rien ne change ; annulée, elle n'est plus en conflit.
    assert.equal(bookingLabel(reservation()), 'Livraison')
    assert.doesNotMatch(bookingBlockClass(reservation()), /statut-conflit/)
    assert.equal(bookingStateLabel(reservation({ conflict: true, status: 'cancelled' })), 'Annulée')
    // Filtré sur un autre client, le créneau reste « occupé », sans détail.
    assert.doesNotMatch(bookingBlockClass(conflit, 'autre'), /statut-conflit/)
  })
})
