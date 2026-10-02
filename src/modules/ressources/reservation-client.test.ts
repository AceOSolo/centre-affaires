import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  clientBookingModeDescriptions,
  clientBookingModeLabels,
  defaultClientBookingMode,
  parseClientBookingMode,
} from './reservation-client.ts'
import { clientBookingModes, resourceTypes } from './schema.ts'

/** Réglage « réservation depuis l'espace client » d'une ressource (R23, ADR 036). */
describe('réglage de réservation depuis l’espace client', () => {
  it('propose de fermer au portail les casiers et les boîtes aux lettres, qui se louent par contrat', () => {
    assert.equal(defaultClientBookingMode('casier'), 'closed')
    assert.equal(defaultClientBookingMode('boite_aux_lettres'), 'closed')
  })

  it('propose l’accord de l’accueil pour les autres types : la valeur prudente de la base', () => {
    for (const type of ['salle', 'bureau', 'vehicule'] as const) {
      assert.equal(defaultClientBookingMode(type), 'approval', type)
    }
    // Tout type a une proposition.
    for (const type of resourceTypes) assert.ok(clientBookingModes.includes(defaultClientBookingMode(type)))
  })

  it('ne lit que les trois réglages', () => {
    assert.equal(parseClientBookingMode('instant'), 'instant')
    assert.equal(parseClientBookingMode(' approval '), 'approval')
    assert.equal(parseClientBookingMode('closed'), 'closed')
    assert.equal(parseClientBookingMode('confirmed'), undefined)
    assert.equal(parseClientBookingMode(''), undefined)
    assert.equal(parseClientBookingMode(null), undefined)
  })

  it('nomme et explique chaque réglage', () => {
    for (const mode of clientBookingModes) {
      assert.ok(clientBookingModeLabels[mode])
      assert.ok(clientBookingModeDescriptions[mode])
    }
  })
})
