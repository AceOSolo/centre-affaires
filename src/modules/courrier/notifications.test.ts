import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { invitationMessage } from '../clients/invitation.ts'
import { mailArrivedMessage, mailScannedMessage, openingRequestedMessage } from './notifications.ts'

const faits = {
  centreName: 'Handfield',
  clientName: 'Atelier Durand',
  kind: 'recommande' as const,
  // 1er octobre 0h30 à Paris.
  receivedAt: new Date('2026-09-30T22:30:00Z'),
  timeZone: 'Europe/Paris',
  link: 'https://www.handfield.fr/compte/courrier',
}

describe('courriels du courrier', () => {
  it('annonce l’arrivée sans rien dire du contenu', () => {
    const { subject, text } = mailArrivedMessage({ ...faits, opened: false })
    assert.equal(subject, 'Nouveau courrier pour Atelier Durand')
    assert.match(text, /recommandé/)
    assert.match(text, /en demander l’ouverture/)
    assert.match(text, /ne contient pas le document/)
    assert.ok(text.includes(faits.link))
  })

  it('date le pli à l’heure du centre', () => {
    const { text } = mailArrivedMessage({ ...faits, opened: false })
    assert.match(text, /1 oct\. 2026 à 00:30/)
  })

  it('dit d’emblée qu’un pli enregistré ouvert est déjà lisible', () => {
    const { subject, text } = mailArrivedMessage({ ...faits, opened: true })
    assert.equal(subject, 'Nouveau courrier numérisé pour Atelier Durand')
    assert.match(text, /ouvert et numérisé/)
    assert.doesNotMatch(text, /en demander l’ouverture/)
  })

  it('prévient de la numérisation', () => {
    const { subject } = mailScannedMessage(faits)
    assert.equal(subject, 'Votre courrier a été numérisé — Atelier Durand')
  })

  it('nomme le demandeur dans la demande adressée au centre', () => {
    const { text } = openingRequestedMessage({ ...faits, requestedBy: 'Jeanne Durand' })
    assert.match(text, /^Jeanne Durand demande l’ouverture/)
  })

  it('reste lisible sans adresse d’application configurée', () => {
    const { text } = mailScannedMessage({ ...faits, link: undefined })
    assert.doesNotMatch(text, /undefined/)
  })
})

describe('invitation à l’espace client', () => {
  it('indique l’adresse avec laquelle créer l’accès', () => {
    const { subject, text } = invitationMessage({
      centreName: 'Handfield',
      clientName: 'Atelier Durand',
      email: 'jeanne@durand.fr',
      link: 'https://www.handfield.fr/auth/connexion',
    })
    assert.equal(subject, 'Votre espace client Handfield')
    assert.match(text, /jeanne@durand\.fr/)
    assert.match(text, /https:\/\/www\.handfield\.fr\/auth\/connexion/)
  })
})
