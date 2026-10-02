import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  expectedPortalOutcome,
  isPortalBookable,
  portalBookingRejection,
  portalBookingTitle,
  portalOutcomeMessage,
  portalOutcomeNotice,
} from './portail-regles.ts'

/**
 * Règles de la réservation depuis l'espace client (R23, ADR 036) : ce qui est
 * annoncé avant l'envoi doit être ce que la base posera, et ce qui est refusé
 * avant l'écriture, ce que le client peut corriger.
 */
const at = (iso: string) => new Date(iso)
const range = (start: string, end: string) => ({ startsAt: at(start), endsAt: at(end) })
const now = at('2026-10-05T06:00:00Z')
const policy = { bookingLeadHours: 2, bookingHorizonDays: 30 }
/** Libre de 9 h à 12 h et de 14 h à 18 h (UTC), le 6 octobre. */
const free = [
  range('2026-10-06T09:00:00Z', '2026-10-06T12:00:00Z'),
  range('2026-10-06T14:00:00Z', '2026-10-06T18:00:00Z'),
]

describe('réglage par ressource', () => {
  it('ne propose pas une ressource fermée au portail', () => {
    assert.equal(isPortalBookable('closed'), false)
    assert.equal(isPortalBookable('approval'), true)
    assert.equal(isPortalBookable('instant'), true)
  })

  it('confirme d’emblée une ressource à confirmation immédiate dont le tarif est calculé', () => {
    assert.equal(expectedPortalOutcome('instant', true), 'confirmed')
  })

  it('laisse en attente une confirmation immédiate sans tarif : un prix ne s’engage pas à l’aveugle', () => {
    assert.equal(expectedPortalOutcome('instant', false), 'pending')
  })

  it('laisse en attente une ressource soumise à l’accord de l’accueil, même chiffrée', () => {
    assert.equal(expectedPortalOutcome('approval', true), 'pending')
    assert.equal(expectedPortalOutcome('approval', false), 'pending')
  })

  it('dit avant l’envoi lequel des deux se produira', () => {
    assert.match(portalOutcomeNotice('instant', true), /Confirmation immédiate/)
    assert.match(portalOutcomeNotice('instant', false), /confirmée par l’accueil/)
    assert.match(portalOutcomeNotice('approval', true), /transmise à l’accueil/)
  })

  it('dit après l’écriture ce que la base a posé', () => {
    const facts = { resourceName: 'Salle Europe', when: 'le mardi 6 octobre 2026, de 09:00 à 10:00' }
    assert.equal(portalOutcomeMessage('confirmed', facts).title, 'Réservation confirmée')
    assert.equal(portalOutcomeMessage('pending', facts).title, 'Demande envoyée à l’accueil')
    assert.match(portalOutcomeMessage('pending', facts).body, /annuler la demande/)
  })
})

describe('créneau demandé depuis l’espace client', () => {
  it('accepte un créneau qui tient dans une plage libre', () => {
    assert.equal(
      portalBookingRejection(range('2026-10-06T09:00:00Z', '2026-10-06T11:00:00Z'), free, policy, now),
      undefined,
    )
  })

  it('va jusqu’à la fin d’une plage libre, sans le plafond de huit heures de la page publique', () => {
    const longue = [range('2026-10-06T07:00:00Z', '2026-10-06T19:00:00Z')]
    assert.equal(
      portalBookingRejection(range('2026-10-06T07:00:00Z', '2026-10-06T19:00:00Z'), longue, policy, now),
      undefined,
    )
  })

  it('refuse un créneau illisible ou trop court', () => {
    assert.equal(portalBookingRejection(undefined, free, policy, now), 'creneau-illisible')
    assert.equal(
      portalBookingRejection(range('2026-10-06T09:00:00Z', '2026-10-06T09:15:00Z'), free, policy, now),
      'duree-trop-courte',
    )
  })

  it('applique le préavis et l’horizon du centre', () => {
    assert.equal(
      portalBookingRejection(range('2026-10-05T05:00:00Z', '2026-10-05T06:30:00Z'), free, policy, now),
      'creneau-passe',
    )
    assert.equal(
      portalBookingRejection(range('2026-10-05T07:00:00Z', '2026-10-05T08:00:00Z'), free, policy, now),
      'preavis-insuffisant',
    )
    assert.equal(
      portalBookingRejection(range('2026-11-20T09:00:00Z', '2026-11-20T10:00:00Z'), free, policy, now),
      'creneau-trop-lointain',
    )
  })

  it('refuse un créneau qui enjambe une pause ou une réservation', () => {
    assert.equal(
      portalBookingRejection(range('2026-10-06T11:00:00Z', '2026-10-06T15:00:00Z'), free, policy, now),
      'creneau-indisponible',
    )
  })
})

describe('objet de la réservation', () => {
  it('garde l’objet saisi, ou affiche l’entreprise à l’accueil', () => {
    assert.equal(portalBookingTitle('  Comité   de direction ', 'Atelier Durand'), 'Comité de direction')
    assert.equal(portalBookingTitle('', 'Atelier Durand'), 'Réservation Atelier Durand')
    assert.equal(portalBookingTitle('x'.repeat(300), 'Atelier Durand').length, 200)
  })
})
