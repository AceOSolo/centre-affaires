import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { OPEN_ENDED_BOOKING_END } from '../reservations/schema.ts'
import { formatBookingDay, formatBookingHours, formatIsoDay } from './historique.ts'

/**
 * Affichage de l'historique d'une fiche client : la base est en UTC, la fiche
 * parle l'heure du centre (décision 4).
 */
const PARIS = 'Europe/Paris'

const slot = (startsAt: string, endsAt: string | Date) => ({
  startsAt: new Date(startsAt),
  endsAt: typeof endsAt === 'string' ? new Date(endsAt) : endsAt,
})

describe('formatIsoDay', () => {
  it('lit une date de contrat sans fuseau', () => {
    assert.equal(formatIsoDay('2026-10-01'), '1 oct. 2026')
    assert.equal(formatIsoDay('2027-02-28'), '28 févr. 2027')
  })
})

describe('formatBookingDay', () => {
  it('donne le jour du centre, pas celui d’UTC', () => {
    // 23h30 UTC le 11 : déjà le 12 à Paris.
    assert.equal(formatBookingDay(new Date('2026-10-11T22:30:00Z'), PARIS), 'lun. 12 oct. 2026')
  })
})

describe('formatBookingHours', () => {
  it('donne les heures du centre sur une journée', () => {
    assert.equal(formatBookingHours(slot('2026-10-12T07:00:00Z', '2026-10-12T08:30:00Z'), PARIS), '09:00 – 10:30')
  })

  it('suit le changement d’heure', () => {
    // Le 26 octobre, Paris est repassé à UTC+1.
    assert.equal(formatBookingHours(slot('2026-10-26T08:00:00Z', '2026-10-26T09:00:00Z'), PARIS), '09:00 – 10:00')
  })

  it('garde dans la journée une fin à minuit', () => {
    assert.equal(formatBookingHours(slot('2026-10-12T06:00:00Z', '2026-10-12T22:00:00Z'), PARIS), '08:00 – 24:00')
  })

  it('nomme le jour de fin d’une réservation sur plusieurs jours', () => {
    assert.equal(
      formatBookingHours(slot('2026-10-24T07:00:00Z', '2026-10-26T17:00:00Z'), PARIS),
      '09:00 → 26 oct. 18:00',
    )
  })

  it('dit « sans terme » plutôt qu’une date en l’an 9999', () => {
    assert.equal(
      formatBookingHours(slot('2026-10-12T07:00:00Z', OPEN_ENDED_BOOKING_END), PARIS),
      'depuis 09:00, sans terme',
    )
  })
})
