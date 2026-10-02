import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  canClientCancel,
  clientBookingTrace,
  isClientBookingInProgress,
  splitClientBookings,
} from './compte-regles.ts'

const NOW = new Date('2026-10-01T10:00:00Z')

const reservation = (
  id: string,
  startsAt: string,
  endsAt: string,
  status: 'pending' | 'confirmed' | 'cancelled' = 'confirmed',
) => ({ id, status, startsAt: new Date(startsAt), endsAt: new Date(endsAt) })

describe('annulation depuis l’espace client', () => {
  it('permet d’annuler une demande pas encore validée', () => {
    assert.equal(
      canClientCancel(reservation('a', '2026-10-02T08:00:00Z', '2026-10-02T09:00:00Z', 'pending'), NOW),
      true,
    )
  })

  it('renvoie vers le centre pour une réservation confirmée', () => {
    // Délais et frais d'annulation relèvent du contrat, pas du code.
    assert.equal(
      canClientCancel(reservation('a', '2026-10-02T08:00:00Z', '2026-10-02T09:00:00Z', 'confirmed'), NOW),
      false,
    )
  })

  it('refuse d’annuler une demande dont le créneau a commencé', () => {
    assert.equal(
      canClientCancel(reservation('a', '2026-10-01T09:30:00Z', '2026-10-01T11:00:00Z', 'pending'), NOW),
      false,
    )
  })
})

describe('liste des réservations du client', () => {
  const liste = [
    reservation('passee', '2026-09-20T08:00:00Z', '2026-09-20T09:00:00Z'),
    reservation('lointaine', '2026-10-20T08:00:00Z', '2026-10-20T09:00:00Z'),
    reservation('en-cours', '2026-10-01T09:00:00Z', '2026-10-01T11:00:00Z'),
    reservation('annulee-future', '2026-10-05T08:00:00Z', '2026-10-05T09:00:00Z', 'cancelled'),
    reservation('prochaine', '2026-10-02T08:00:00Z', '2026-10-02T09:00:00Z', 'pending'),
  ]

  it('met à venir ce qui n’est pas fini, dans l’ordre chronologique', () => {
    const { upcoming } = splitClientBookings(liste, NOW)
    assert.deepEqual(
      upcoming.map((r) => r.id),
      ['en-cours', 'prochaine', 'lointaine'],
    )
  })

  it('range en historique le passé et les annulations, le plus récent d’abord', () => {
    const { history } = splitClientBookings(liste, NOW)
    assert.deepEqual(
      history.map((r) => r.id),
      ['annulee-future', 'passee'],
    )
  })
})

describe('traçabilité côté client (R24, ADR 036)', () => {
  const trace = (overrides: Partial<Parameters<typeof clientBookingTrace>[0]> = {}) =>
    clientBookingTrace({
      status: 'confirmed',
      channel: 'client',
      bookedBy: null,
      cancelledByMember: null,
      cancelledByCentre: false,
      ...overrides,
    })

  it('nomme la personne de l’entreprise qui a réservé depuis l’espace', () => {
    assert.equal(trace({ bookedBy: 'Jeanne Martin' }).origin, 'Réservée par Jeanne Martin depuis l’espace client')
  })

  it('dit d’où vient une réservation sans auteur : l’accueil ou le site', () => {
    assert.equal(trace({ channel: 'staff' }).origin, 'Réservée par l’accueil du centre')
    assert.equal(trace({ channel: 'public' }).origin, 'Demandée depuis le site du centre')
  })

  it('nomme l’auteur d’une annulation, sans nommer l’équipe', () => {
    assert.equal(
      trace({ status: 'cancelled', cancelledByMember: 'Jeanne Martin' }).cancellation,
      'Annulée par Jeanne Martin',
    )
    assert.equal(trace({ status: 'cancelled', cancelledByCentre: true }).cancellation, 'Annulée par le centre')
    // Annulation sans trace (antérieure à la vague 3) : rien n'est inventé.
    assert.equal(trace({ status: 'cancelled' }).cancellation, null)
    assert.equal(trace({ status: 'confirmed', cancelledByCentre: true }).cancellation, null)
  })

  it('reconnaît une réservation en cours', () => {
    assert.equal(
      isClientBookingInProgress(reservation('a', '2026-10-01T09:00:00Z', '2026-10-01T11:00:00Z'), NOW),
      true,
    )
    assert.equal(
      isClientBookingInProgress(reservation('a', '2026-10-01T10:30:00Z', '2026-10-01T11:00:00Z'), NOW),
      false,
    )
    assert.equal(
      isClientBookingInProgress(reservation('a', '2026-10-01T09:00:00Z', '2026-10-01T11:00:00Z', 'cancelled'), NOW),
      false,
    )
  })
})
