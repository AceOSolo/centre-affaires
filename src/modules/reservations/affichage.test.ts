import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  bookingBlockClass,
  bookingFocus,
  bookingHref,
  bookingLabel,
  bookingStateLabel,
  bookingTimeLabel,
  contractReference,
  coversDay,
  occupationPeriodLabel,
  type DisplayableBooking,
} from './affichage.ts'
import { OPEN_ENDED_BOOKING_END } from './schema.ts'

const PARIS = 'Europe/Paris'
const CLIENT = '01a00000-0000-7000-8000-0000000c0c01'

const reservation = (overrides: Partial<DisplayableBooking> = {}): DisplayableBooking => ({
  id: 'b1',
  kind: 'booking',
  status: 'confirmed',
  title: 'Comité de direction',
  // 9h00 – 10h00 à Paris, heure d'été.
  startsAt: new Date('2026-10-05T07:00:00Z'),
  endsAt: new Date('2026-10-05T08:00:00Z'),
  clientId: null,
  contractId: null,
  ...overrides,
})

/** Occupation d'un contrat, du 1er mars au 30 juin 2026 à Paris. */
const occupation = (overrides: Partial<DisplayableBooking> = {}) =>
  reservation({
    id: 'occ',
    kind: 'contract',
    title: 'Contrat CT-2026-0001',
    contractId: 'c1',
    clientId: CLIENT,
    startsAt: new Date('2026-02-28T23:00:00Z'),
    endsAt: new Date('2026-06-30T22:00:00Z'),
    ...overrides,
  })

describe('libellés d’une occupation de contrat', () => {
  it('dit « Occupé — contrat X » et mène au contrat', () => {
    assert.equal(contractReference(occupation()), 'CT-2026-0001')
    assert.equal(bookingLabel(occupation()), 'Occupé — contrat CT-2026-0001')
    assert.equal(bookingHref(occupation()), '/contrats/c1')
    assert.equal(bookingStateLabel(occupation()), 'Sous contrat')
  })

  it('donne la période en jours du centre, dernier jour compris', () => {
    assert.equal(occupationPeriodLabel(occupation(), PARIS), 'du 1 mars 2026 au 30 juin 2026')
  })

  it('dit « sans terme » plutôt que le 31 décembre 9999', () => {
    assert.equal(
      occupationPeriodLabel(occupation({ endsAt: OPEN_ENDED_BOOKING_END }), PARIS),
      'depuis le 1 mars 2026, sans terme',
    )
  })

  it('nomme un contrat d’une seule journée par son jour', () => {
    const unJour = occupation({
      startsAt: new Date('2026-10-04T22:00:00Z'),
      endsAt: new Date('2026-10-05T22:00:00Z'),
    })
    assert.equal(occupationPeriodLabel(unJour, PARIS), 'le 5 octobre 2026')
  })
})

describe('bookingLabel, bookingHref et bookingStateLabel', () => {
  it('garde l’objet d’une réservation et mène à sa fiche', () => {
    assert.equal(bookingLabel(reservation()), 'Comité de direction')
    assert.equal(bookingHref(reservation()), '/reservations/b1')
    assert.equal(bookingStateLabel(reservation()), 'Confirmée')
    assert.equal(bookingStateLabel(reservation({ status: 'pending' })), 'À valider')
  })

  it('préfixe un blocage de l’équipe', () => {
    const blocage = reservation({ kind: 'unavailability', title: 'Entretien' })
    assert.equal(bookingLabel(blocage), 'Indisponible — Entretien')
    assert.equal(bookingStateLabel(blocage), 'Indisponible')
  })
})

describe('bookingTimeLabel et coversDay', () => {
  it('donne l’horaire d’une réservation du jour', () => {
    assert.equal(bookingTimeLabel(reservation(), '2026-10-05', PARIS), '09:00 – 10:00')
    assert.equal(coversDay(reservation(), '2026-10-05', PARIS), false)
  })

  it('dit « Toute la journée » pour une occupation qui couvre le jour', () => {
    assert.equal(bookingTimeLabel(occupation(), '2026-04-15', PARIS), 'Toute la journée')
    assert.equal(coversDay(occupation(), '2026-04-15', PARIS), true)
    assert.equal(
      bookingTimeLabel(occupation({ endsAt: OPEN_ENDED_BOOKING_END }), '2030-01-01', PARIS),
      'Toute la journée',
    )
  })

  it('couvre la journée de 25 heures du retour à l’heure d’hiver', () => {
    const longue = occupation({
      startsAt: new Date('2026-10-01T22:00:00Z'),
      endsAt: OPEN_ENDED_BOOKING_END,
    })
    assert.equal(coversDay(longue, '2026-10-25', PARIS), true)
  })

  it('distingue une réservation commencée la veille ou finie le lendemain', () => {
    const nuit = reservation({
      startsAt: new Date('2026-10-04T20:00:00Z'),
      endsAt: new Date('2026-10-05T06:00:00Z'),
    })
    assert.equal(bookingTimeLabel(nuit, '2026-10-05', PARIS), 'jusqu’à 08:00')
    assert.equal(bookingTimeLabel(nuit, '2026-10-04', PARIS), 'dès 22:00')
  })
})

describe('bookingFocus', () => {
  it('ne distingue rien sans filtre client', () => {
    assert.equal(bookingFocus(reservation(), undefined), 'tous')
  })

  it('met en avant le client filtré et réduit les autres', () => {
    assert.equal(bookingFocus(reservation({ clientId: CLIENT }), CLIENT), 'client')
    assert.equal(bookingFocus(reservation({ clientId: null }), CLIENT), 'autre')
    assert.equal(bookingBlockClass(reservation(), 'autre').includes('bg-statut-annule'), true)
  })
})

describe('bookingBlockClass', () => {
  it('porte les états sur les jetons de statut de la charte', () => {
    assert.match(bookingBlockClass(reservation({ status: 'pending' })), /statut-reserve/)
    assert.match(bookingBlockClass(reservation()), /statut-confirme/)
    assert.match(bookingBlockClass(occupation()), /statut-confirme/)
  })
})
