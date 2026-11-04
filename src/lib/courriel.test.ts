import assert from 'node:assert/strict'
import { createServer, type AddressInfo } from 'node:net'
import { describe, it } from 'node:test'

import {
  explainSmtpError,
  isLoopbackHost,
  normalizeRecipients,
  sendMessage,
  smtpSettings,
  smtpStatus,
} from './courriel.ts'

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

describe('issue d’un envoi', () => {
  const variables = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM'] as const

  /** Lance `run` sans configuration SMTP, puis rétablit l'environnement. */
  async function sansSmtp<T>(run: () => Promise<T>): Promise<T> {
    const saved = Object.fromEntries(variables.map((name) => [name, process.env[name]]))
    for (const name of variables) delete process.env[name]
    try {
      return await run()
    } finally {
      for (const name of variables) {
        if (saved[name] === undefined) delete process.env[name]
        else process.env[name] = saved[name]
      }
    }
  }

  it('dit « non configuré » sans SMTP, avec les adresses qui auraient été servies', async () => {
    const result = await sansSmtp(() =>
      sendMessage({ to: ['Jeanne@Durand.fr ', 'jeanne@durand.fr'], subject: 'Objet', text: 'Texte' }),
    )
    assert.deepEqual(result, {
      status: 'not_configured',
      recipients: ['jeanne@durand.fr'],
      failed: [],
      error: null,
    })
  })

  it('dit qu’il n’y avait personne à prévenir', async () => {
    const result = await sansSmtp(() => sendMessage({ to: [' ', ''], subject: 'Objet', text: 'Texte' }))
    assert.equal(result.status, 'no_recipient')
  })

  it('normalise les adresses : minuscules, sans blanc ni doublon', () => {
    assert.deepEqual(normalizeRecipients([' A@B.fr', 'a@b.fr', '', 'c@d.fr']), ['a@b.fr', 'c@d.fr'])
  })
})

describe('capteur local et chiffrement (ADR 059)', () => {
  it('admet le clair vers la boucle locale seulement : le capteur de développement', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      assert.equal(smtpSettings({ ...brevo, SMTP_HOST: host, SMTP_PORT: '1025' })?.requireTLS, false, host)
    }
    for (const host of ['localhost.exemple.fr', '10.0.0.5', 'mailpit', 'smtp-relay.brevo.com']) {
      assert.equal(smtpSettings({ ...brevo, SMTP_HOST: host, SMTP_PORT: '1025' })?.requireTLS, true, host)
    }
    assert.equal(isLoopbackHost('127.0.0.12'), true)
    assert.equal(isLoopbackHost('1270.0.0.1'), false)
  })

  it('borne les délais : un serveur injoignable répond en secondes', () => {
    const settings = smtpSettings(brevo)
    assert.equal(settings?.connectionTimeout, 10_000)
    assert.equal(settings?.greetingTimeout, 10_000)
  })
})

describe('état de la configuration (encart « Courriels »)', () => {
  it('dit ce qui est configuré, sans l’identifiant ni la clé', () => {
    const status = smtpStatus(brevo)
    assert.deepEqual(status, {
      configured: true,
      missing: [],
      host: 'smtp-relay.brevo.com',
      port: 587,
      security: 'STARTTLS',
      from: 'Handfield <no-reply@handfield.fr>',
    })
    assert.doesNotMatch(JSON.stringify(status), /xsmtpsib|8a1b2c001/)
  })

  it('nomme les variables qui manquent', () => {
    const status = smtpStatus({ SMTP_HOST: 'smtp-relay.brevo.com', SMTP_PORT: 'abc' })
    assert.equal(status.configured, false)
    assert.deepEqual(status.missing, ['SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM'])
    assert.equal(status.security, null)
  })
})

describe('erreurs SMTP lisibles', () => {
  const erreur = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields)

  it('dit de vérifier l’identifiant et la clé SMTP quand le serveur les refuse', () => {
    const texte = explainSmtpError(
      erreur('Invalid login: 535 5.7.8 Authentication failed', { code: 'EAUTH', responseCode: 535 }),
    )
    assert.match(texte, /^Identifiant ou clé SMTP refusés : vérifiez SMTP_USER/)
    assert.match(texte, /pas la clé d’API/)
    assert.match(texte, /Réponse du serveur : Invalid login: 535 5\.7\.8 Authentication failed$/)
  })

  it('dit que l’expéditeur doit être validé chez Brevo', () => {
    const texte = explainSmtpError(
      erreur('Mail command failed: 550 5.7.1 Sender not allowed', {
        code: 'EENVELOPE',
        command: 'MAIL FROM',
        responseCode: 550,
      }),
    )
    assert.match(texte, /^Expéditeur refusé : MAIL_FROM/)
  })

  it('distingue un serveur introuvable d’un serveur injoignable', () => {
    assert.match(explainSmtpError(erreur('getaddrinfo ENOTFOUND smtp.inconnu', { code: 'EDNS' })), /^Serveur SMTP introuvable/)
    assert.match(explainSmtpError(erreur('Connection timeout', { code: 'ETIMEDOUT' })), /^Serveur SMTP injoignable/)
    assert.match(
      explainSmtpError(erreur('connect ECONNREFUSED 127.0.0.1:1025', { code: 'ESOCKET' })),
      /^Serveur SMTP injoignable/,
    )
  })

  it('garde la réponse du serveur, bornée, quand la cause n’est pas connue', () => {
    assert.equal(explainSmtpError(erreur('Quelque chose', {})), 'Quelque chose')
    assert.equal(explainSmtpError(erreur('x'.repeat(1000), {})).length, 400)
  })
})

/**
 * Un serveur SMTP minimal sur la boucle locale, pour éprouver l'envoi tel que
 * nodemailer le fait réellement, sans rien remettre à personne. `refus`
 * remplace la réponse d'une commande.
 */
async function serveurSmtp(refus: { auth?: string; mail?: string } = {}) {
  const recus: string[] = []
  const server = createServer((socket) => {
    let tampon = ''
    let donnees = false
    let message = ''
    socket.write('220 essai.local ESMTP\r\n')
    socket.on('data', (morceau) => {
      tampon += morceau.toString('utf8')
      let fin = tampon.indexOf('\r\n')
      while (fin >= 0) {
        const ligne = tampon.slice(0, fin)
        tampon = tampon.slice(fin + 2)
        fin = tampon.indexOf('\r\n')
        if (donnees) {
          if (ligne === '.') {
            donnees = false
            recus.push(message)
            message = ''
            socket.write('250 2.0.0 Ok: queued\r\n')
          } else {
            message += `${ligne}\n`
          }
          continue
        }
        const verbe = ligne.split(' ')[0].toUpperCase()
        if (verbe === 'EHLO') socket.write('250-essai.local\r\n250 AUTH PLAIN\r\n')
        else if (verbe === 'AUTH') socket.write(refus.auth ?? '235 2.7.0 Authentication successful\r\n')
        else if (verbe === 'MAIL') socket.write(refus.mail ?? '250 2.1.0 Ok\r\n')
        else if (verbe === 'RCPT') socket.write('250 2.1.5 Ok\r\n')
        else if (verbe === 'DATA') {
          donnees = true
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
        } else if (verbe === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n')
          socket.end()
        } else socket.write('250 Ok\r\n')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const env = {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(port),
    SMTP_USER: 'essai',
    SMTP_PASSWORD: 'essai',
    MAIL_FROM: 'Centre Horizon <centre@exemple.test>',
  }
  return { env, recus, fermer: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

describe('envoi réel vers un serveur SMTP de la boucle locale', () => {
  it('remet un exemplaire par destinataire, sans chiffrement sur la boucle locale', async () => {
    const serveur = await serveurSmtp()
    try {
      const result = await sendMessage(
        { to: ['camille@exemple.test', 'paul@exemple.test'], subject: 'Essai', text: 'Bonjour' },
        serveur.env,
      )
      assert.deepEqual(result, {
        status: 'sent',
        recipients: ['camille@exemple.test', 'paul@exemple.test'],
        failed: [],
        error: null,
      })
      assert.equal(serveur.recus.length, 2)
      assert.match(serveur.recus[0], /Subject: Essai/)
      assert.match(serveur.recus[0], /From: Centre Horizon <centre@exemple\.test>/)
    } finally {
      await serveur.fermer()
    }
  })

  it('journalise un refus d’authentification en clair pour l’équipe', async (t) => {
    t.mock.method(console, 'error', () => {})
    const serveur = await serveurSmtp({ auth: '535 5.7.8 Authentication failed\r\n' })
    try {
      const result = await sendMessage({ to: ['camille@exemple.test'], subject: 'Essai', text: 'Bonjour' }, serveur.env)
      assert.equal(result.status, 'failed')
      assert.deepEqual(result.failed, ['camille@exemple.test'])
      assert.match(result.error ?? '', /^1 envoi sur 1 en échec : Identifiant ou clé SMTP refusés/)
    } finally {
      await serveur.fermer()
    }
  })

  it('dit que l’expéditeur est refusé quand le serveur le refuse', async (t) => {
    t.mock.method(console, 'error', () => {})
    const serveur = await serveurSmtp({ mail: '550 5.7.1 Sender address rejected: not validated\r\n' })
    try {
      const result = await sendMessage({ to: ['camille@exemple.test'], subject: 'Essai', text: 'Bonjour' }, serveur.env)
      assert.equal(result.status, 'failed')
      assert.match(result.error ?? '', /Expéditeur refusé : MAIL_FROM/)
    } finally {
      await serveur.fermer()
    }
  })
})
