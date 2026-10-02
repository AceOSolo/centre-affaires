import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { smtpSettings } from './courriel.ts'

const brevo = {
  SMTP_HOST: 'smtp-relay.brevo.com',
  SMTP_PORT: '587',
  // Identifiant Brevo : il contient un `@`, qu'une URL aurait dû encoder.
  SMTP_USER: '8a1b2c001@smtp-brevo.com',
  SMTP_PASSWORD: 'xsmtpsib-cle',
  MAIL_FROM: 'Handfield <no-reply@handfield.fr>',
}

describe('réglages SMTP', () => {
  it('lit la configuration de Brevo telle quelle, identifiant compris', () => {
    const settings = smtpSettings(brevo)
    assert.equal(settings?.host, 'smtp-relay.brevo.com')
    assert.deepEqual(settings?.auth, { user: '8a1b2c001@smtp-brevo.com', pass: 'xsmtpsib-cle' })
  })

  it('exige STARTTLS sur le port 587 : jamais de courriel en clair', () => {
    const settings = smtpSettings(brevo)
    assert.equal(settings?.secure, false)
    assert.equal(settings?.requireTLS, true)
  })

  it('chiffre d’emblée sur le port 465', () => {
    const settings = smtpSettings({ ...brevo, SMTP_PORT: '465' })
    assert.equal(settings?.secure, true)
  })

  it('prend 587 quand le port n’est pas précisé', () => {
    assert.equal(smtpSettings({ ...brevo, SMTP_PORT: undefined })?.port, 587)
  })

  it('n’envoie rien tant qu’une valeur manque', () => {
    // Le développement tourne sans SMTP : aucune adresse réelle ne doit y
    // recevoir de message.
    for (const manquante of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM']) {
      assert.equal(smtpSettings({ ...brevo, [manquante]: '' }), undefined, manquante)
    }
  })

  it('refuse un port illisible plutôt que d’improviser', () => {
    assert.equal(smtpSettings({ ...brevo, SMTP_PORT: 'abc' }), undefined)
  })
})
