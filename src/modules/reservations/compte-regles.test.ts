import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { wallClockToUtc } from '../../lib/dates.ts'
import {
  canClientCancel,
  canClientModify,
  clientBookingTrace,
  clientChangeBlocker,
  clientChangeDeadline,
  clientChangeNotice,
  isClientBookingInProgress,
  splitClientBookings,
} from './compte-regles.ts'

const NOW = new Date('2026-10-01T10:00:00Z')
const PARIS = 'Europe/Paris'
const SEPT_JOURS = { days: 7, timeZone: PARIS }

const reservation = (
  id: string,
  startsAt: string,
  endsAt: string,
  status: 'pending' | 'confirmed' | 'cancelled' = 'confirmed',
) => ({ id, status, startsAt: new Date(startsAt), endsAt: new Date(endsAt) })

describe('modification et annulation depuis l’espace client (ADR 076)', () => {
  // Délai nul : jusqu'au début, comme avant le réglage.
  const jusquauDebut = { days: 0, timeZone: 'Europe/Paris' }

  it('laisse annuler une demande en attente, et désormais une réservation confirmée', () => {
    assert.equal(
      canClientCancel(reservation('a', '2026-10-02T08:00:00Z', '2026-10-02T09:00:00Z', 'pending'), NOW, jusquauDebut),
      true,
    )
    assert.equal(
      canClientCancel(reservation('a', '2026-10-02T08:00:00Z', '2026-10-02T09:00:00Z', 'confirmed'), NOW, jusquauDebut),
      true,
    )
  })

  it('refuse une réservation commencée, annulée, ou du matériel en option', () => {
    assert.equal(
      canClientCancel(reservation('a', '2026-10-01T09:30:00Z', '2026-10-01T11:00:00Z', 'pending'), NOW, jusquauDebut),
      false,
    )
    assert.equal(
      canClientCancel(reservation('a', '2026-10-05T09:30:00Z', '2026-10-05T11:00:00Z', 'cancelled'), NOW, jusquauDebut),
      false,
    )
    const option = { ...reservation('o', '2026-10-05T09:30:00Z', '2026-10-05T11:00:00Z', 'pending'), parentBookingId: 'a' }
    assert.equal(clientChangeBlocker(option, NOW, jusquauDebut), 'option')
  })

  it('ne modifie pas une réservation qui emporte du matériel : l’accueil le déplace', () => {
    const salle = reservation('a', '2026-10-20T08:00:00Z', '2026-10-20T09:00:00Z', 'confirmed')
    assert.equal(canClientModify({ ...salle, optionCount: 0 }, NOW, SEPT_JOURS), true)
    assert.equal(canClientModify({ ...salle, optionCount: 1 }, NOW, SEPT_JOURS), false)
    // L'annuler reste possible : le matériel est annulé avec elle.
    assert.equal(canClientCancel(salle, NOW, SEPT_JOURS), true)
  })
})

describe('délai de modification, en heure murale du centre (ADR 076)', () => {
  const at = (wallClock: string) => wallClockToUtc(wallClock, PARIS)
  const lundi9h = reservation('a', at('2026-11-16T09:00').toISOString(), at('2026-11-16T10:00').toISOString(), 'confirmed')

  it('ferme le délai sept jours avant, à la même heure : jusqu’au lundi précédent 9 h', () => {
    assert.equal(clientChangeDeadline(lundi9h.startsAt, 7, PARIS).toISOString(), at('2026-11-09T09:00').toISOString())
    assert.equal(canClientCancel(lundi9h, at('2026-11-09T08:59'), SEPT_JOURS), true)
    assert.equal(canClientCancel(lundi9h, at('2026-11-09T09:00'), SEPT_JOURS), false)
    assert.equal(clientChangeBlocker(lundi9h, at('2026-11-09T09:00'), SEPT_JOURS), 'delai')
  })

  it('à un jour, ferme la veille à la même heure', () => {
    const veille = { days: 1, timeZone: PARIS }
    assert.equal(canClientModify({ ...lundi9h, optionCount: 0 }, at('2026-11-15T08:59'), veille), true)
    assert.equal(canClientModify({ ...lundi9h, optionCount: 0 }, at('2026-11-15T09:00'), veille), false)
  })

  it('compte les jours du centre, pas ceux du serveur', () => {
    // Lundi 16 novembre, 0 h 30 à Paris : dimanche 23 h 30 UTC.
    const minuit = reservation('m', at('2026-11-16T00:30').toISOString(), at('2026-11-16T02:00').toISOString(), 'pending')
    assert.equal(
      clientChangeDeadline(minuit.startsAt, 1, PARIS).toISOString(),
      at('2026-11-15T00:30').toISOString(),
    )
  })

  it('garde l’heure murale à travers le changement d’heure', () => {
    // Lundi 2 novembre 2026 9 h (heure d'hiver) : le délai de sept jours
    // tombe le lundi 26 octobre 9 h, déjà en heure d'hiver ; celui de dix
    // jours le vendredi 23 octobre 9 h, en heure d'été (UTC+2).
    const apres = reservation('h', at('2026-11-02T09:00').toISOString(), at('2026-11-02T10:00').toISOString(), 'confirmed')
    assert.equal(clientChangeDeadline(apres.startsAt, 10, PARIS).toISOString(), '2026-10-23T07:00:00.000Z')
    assert.equal(clientChangeDeadline(apres.startsAt, 7, PARIS).toISOString(), '2026-10-26T08:00:00.000Z')
    // Dix fois 24 heures auraient donné 08:00 UTC le 23, soit 10 h à Paris :
    // une heure de trop, celle du changement d'heure.
  })

  it('dit jusqu’à quand, ou pourquoi plus', () => {
    assert.match(clientChangeNotice(lundi9h, at('2026-11-01T10:00'), SEPT_JOURS) ?? '', /jusqu’au lundi 9 novembre 2026 à 09:00/)
    assert.match(clientChangeNotice(lundi9h, at('2026-11-10T10:00'), SEPT_JOURS) ?? '', /délai .* est passé \(7 jours avant le début\)/)
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
