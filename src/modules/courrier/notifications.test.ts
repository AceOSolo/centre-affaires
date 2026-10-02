import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatDateTime } from '../../lib/dates.ts'
import { defaultTemplates, notificationEventLabels } from '../notifications/catalogue.ts'
import { renderMessage } from '../notifications/rendu.ts'
import type { NotificationEvent } from '../notifications/schema.ts'

/**
 * Textes par défaut des courriels du courrier et de l'invitation (ADR 015),
 * désormais rendus par le moteur de notifications (ADR 038) : ce qu'un centre
 * qui n'a écrit aucun modèle envoie.
 */
const rendre = (event: NotificationEvent, values: Record<string, string | null | undefined>) =>
  renderMessage(defaultTemplates[event], { centre: 'Handfield', ...values }, notificationEventLabels[event])

const faits = {
  client: 'Atelier Durand',
  nature: 'recommandé',
  // 1er octobre 0h30 à Paris.
  date: formatDateTime(new Date('2026-09-30T22:30:00Z'), 'Europe/Paris'),
  lien: 'https://www.handfield.fr/compte/courrier',
}

describe('courriels du courrier', () => {
  it('annonce l’arrivée sans rien dire du contenu', () => {
    const { subject, body } = rendre('mail_received', faits)
    assert.equal(subject, 'Nouveau courrier pour Atelier Durand')
    assert.match(body, /recommandé/)
    assert.match(body, /en demander l’ouverture/)
    assert.match(body, /ne contient pas le document/)
    assert.ok(body.includes(faits.lien))
  })

  it('date le pli à l’heure du centre', () => {
    const { body } = rendre('mail_received', faits)
    assert.match(body, /1 oct\. 2026 à 00:30/)
  })

  it('prévient de la numérisation, lisible dans l’espace', () => {
    const { subject, body } = rendre('mail_scanned', faits)
    assert.equal(subject, 'Votre courrier a été numérisé — Atelier Durand')
    assert.match(body, /ouvert et numérisé/)
    assert.doesNotMatch(body, /en demander l’ouverture/)
  })

  it('nomme le demandeur dans la demande adressée au centre', () => {
    const { subject, body } = rendre('mail_request_submitted', {
      ...faits,
      demande: 'ouverture et numérisation',
      demandeur: 'Jeanne Durand',
      lien: 'https://www.handfield.fr/courrier/1',
    })
    assert.equal(subject, 'Demande de courrier (ouverture et numérisation) — Atelier Durand')
    assert.match(body, /^Jeanne Durand demande pour Atelier Durand : ouverture et numérisation/)
  })

  it('reste lisible sans adresse d’application configurée', () => {
    const { body } = rendre('mail_scanned', { ...faits, lien: undefined })
    assert.doesNotMatch(body, /undefined/)
    assert.doesNotMatch(body, /Votre boîte aux lettres/)
    assert.match(body, /ne contient pas le document/)
  })

  it('signe du nom du centre', () => {
    assert.match(rendre('mail_received', faits).body, /—\nHandfield$/)
  })
})

describe('invitation à l’espace client', () => {
  it('indique l’adresse avec laquelle créer l’accès', () => {
    const { subject, body } = rendre('member_invited', {
      client: 'Atelier Durand',
      adresse: 'jeanne@durand.fr',
      lien: 'https://www.handfield.fr/auth/connexion',
    })
    assert.equal(subject, 'Votre espace client Handfield')
    assert.match(body, /jeanne@durand\.fr/)
    assert.match(body, /https:\/\/www\.handfield\.fr\/auth\/connexion/)
  })
})
