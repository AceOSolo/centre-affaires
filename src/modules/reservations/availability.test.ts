import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  findConflicts,
  isValidRange,
  occupiesResource,
  overlaps,
  type ExistingBooking,
} from './availability.ts'

const at = (iso: string) => new Date(iso)
const range = (start: string, end: string) => ({ startsAt: at(start), endsAt: at(end) })

const SALLE = 'resource-salle'
const BUREAU = 'resource-bureau'

const booking = (
  id: string,
  start: string,
  end: string,
  overrides: Partial<ExistingBooking> = {},
): ExistingBooking => ({
  id,
  resourceId: SALLE,
  status: 'confirmed',
  ...range(start, end),
  ...overrides,
})

describe('isValidRange', () => {
  it('refuse une durée nulle', () => {
    assert.equal(isValidRange(range('2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z')), false)
  })

  it('refuse une fin avant le début', () => {
    assert.equal(isValidRange(range('2026-10-01T10:00:00Z', '2026-10-01T09:00:00Z')), false)
  })

  it('accepte une durée positive', () => {
    assert.equal(isValidRange(range('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z')), true)
  })
})

describe('overlaps', () => {
  it('ne voit pas de conflit entre deux créneaux jointifs', () => {
    const matin = range('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z')
    const suite = range('2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z')
    assert.equal(overlaps(matin, suite), false)
    assert.equal(overlaps(suite, matin), false)
  })

  it('voit un conflit sur un recouvrement partiel', () => {
    const a = range('2026-10-01T09:00:00Z', '2026-10-01T10:30:00Z')
    const b = range('2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z')
    assert.equal(overlaps(a, b), true)
    assert.equal(overlaps(b, a), true)
  })

  it('voit un conflit quand un créneau en contient un autre', () => {
    const journee = range('2026-10-01T08:00:00Z', '2026-10-01T18:00:00Z')
    const reunion = range('2026-10-01T14:00:00Z', '2026-10-01T15:00:00Z')
    assert.equal(overlaps(journee, reunion), true)
    assert.equal(overlaps(reunion, journee), true)
  })

  it('ignore le fuseau de saisie : seul l\'instant compte', () => {
    // 11h00 à Paris (heure d'été) = 09h00 UTC, donc jointif avec 09h00-10h00 UTC.
    const utc = range('2026-10-01T08:00:00Z', '2026-10-01T09:00:00Z')
    const paris = range('2026-10-01T11:00:00+02:00', '2026-10-01T12:00:00+02:00')
    assert.equal(overlaps(utc, paris), false)
  })

  it('reste correct au passage à l\'heure d\'hiver', () => {
    // La nuit du 25 octobre 2026, 02h00 Paris revient à 02h00 : 02h30+02:00 et
    // 02h30+01:00 sont deux instants distincts séparés d'une heure.
    const avant = range('2026-10-25T02:00:00+02:00', '2026-10-25T02:45:00+02:00')
    const apres = range('2026-10-25T02:00:00+01:00', '2026-10-25T02:45:00+01:00')
    assert.equal(overlaps(avant, apres), false)
  })
})

describe('occupiesResource', () => {
  it('libère le créneau une fois la réservation annulée', () => {
    assert.equal(occupiesResource('cancelled'), false)
  })

  it('occupe la ressource tant que la demande est en attente', () => {
    assert.equal(occupiesResource('pending'), true)
    assert.equal(occupiesResource('confirmed'), true)
  })
})

describe('findConflicts', () => {
  const candidate = { resourceId: SALLE, ...range('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z') }

  it('ne retient que la même ressource', () => {
    const conflits = findConflicts(candidate, [
      booking('autre-salle', '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', {
        resourceId: BUREAU,
      }),
    ])
    assert.deepEqual(conflits, [])
  })

  it('ignore les réservations annulées', () => {
    const conflits = findConflicts(candidate, [
      booking('annulee', '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', { status: 'cancelled' }),
    ])
    assert.deepEqual(conflits, [])
  })

  it('signale la réservation en conflit', () => {
    const conflits = findConflicts(candidate, [
      booking('jointive', '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z'),
      booking('chevauchante', '2026-10-01T09:30:00Z', '2026-10-01T10:30:00Z'),
    ])
    assert.deepEqual(
      conflits.map((c) => c.id),
      ['chevauchante'],
    )
  })

  it('ne met pas une réservation en conflit avec elle-même lors d\'un déplacement', () => {
    const existante = booking('a-deplacer', '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z')
    const conflits = findConflicts(
      { resourceId: SALLE, ...range('2026-10-01T09:15:00Z', '2026-10-01T10:15:00Z') },
      [existante],
      { excludeBookingId: 'a-deplacer' },
    )
    assert.deepEqual(conflits, [])
  })
})
