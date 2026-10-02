import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  mailForwardedMessage,
  mailRequestRefusedMessage,
  mailRequestSubmittedMessage,
} from './notifications-demandes.ts'

/**
 * Courriels des demandes sur un pli (ADR 037, ADR 038) : ils préviennent, ils
 * ne transportent rien (ADR 015) — ni document, ni adresse de réexpédition,
 * ni motif de refus. Les dates sont celles du centre.
 */
const faits = {
  centreName: 'Handfield',
  clientName: 'Atelier Durand',
  // 1er octobre 0h30 à Paris.
  receivedAt: new Date('2026-09-30T22:30:00Z'),
  timeZone: 'Europe/Paris',
  link: 'https://www.handfield.fr/compte/courrier/demandes',
}

describe('courriels des demandes de courrier', () => {
  it('prévient le centre d’une numérisation ou d’une réexpédition demandée, avec le lien pour la traiter', () => {
    const numerisation = mailRequestSubmittedMessage({ ...faits, kind: 'scan', requestedBy: 'Jeanne Durand' })
    assert.equal(numerisation.subject, 'Numérisation de courrier demandée — Atelier Durand')
    assert.match(numerisation.text, /Jeanne Durand demande la numérisation du courrier reçu le 1 oct\. 2026 à 00:30/)
    assert.ok(numerisation.text.includes(faits.link))

    const reexpedition = mailRequestSubmittedMessage({ ...faits, kind: 'forward', requestedBy: null })
    assert.match(reexpedition.text, /^Le client demande la réexpédition/)
  })

  it('annonce la réexpédition sans l’adresse ni le numéro de suivi', () => {
    const { subject, text } = mailForwardedMessage({
      ...faits,
      kind: 'forward',
      forwardedAt: new Date('2026-10-02T13:15:00Z'),
    })
    assert.equal(subject, 'Votre courrier a été réexpédié — Atelier Durand')
    assert.match(text, /réexpédié le 2 oct\. 2026 à 15:15/)
    assert.match(text, /adresse indiquée dans votre demande/)
    assert.match(text, /figure dans votre espace client/)
  })

  it('annonce un refus sans le motif, qui reste dans l’espace', () => {
    const ouverture = mailRequestRefusedMessage({ ...faits, kind: 'open_and_scan' })
    assert.equal(ouverture.subject, 'Votre demande d’ouverture et de numérisation n’a pas pu être traitée — Atelier Durand')
    assert.match(ouverture.text, /Le motif est indiqué dans votre espace client/)
    assert.match(mailRequestRefusedMessage({ ...faits, kind: 'scan' }).subject, /^Votre demande de numérisation/)
  })
})
