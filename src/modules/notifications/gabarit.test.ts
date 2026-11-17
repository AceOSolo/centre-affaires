import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { defaultTemplates, notificationEventLabels } from './catalogue.ts'
import {
  brandMessage,
  buttonOf,
  escapeHtml,
  linkify,
  parseEmailBody,
  renderEmailHtml,
  withSignature,
  type EmailBranding,
} from './gabarit.ts'
import { exampleValuesFor, renderMessage } from './rendu.ts'
import type { NotificationEvent } from './schema.ts'

/**
 * Gabarit des courriels (ADR 080) : la mise en page de tout message, lue dans
 * son texte brut — paragraphes, boutons vers le site, signature —, échappée,
 * sans ressource distante autre que le logo.
 */
const SITE = 'https://centre.exemple'

const branding: EmailBranding = {
  centreName: 'Centre Horizon',
  logo: { url: `${SITE}/handfield-logo.png`, width: 176, height: 56 },
  signatureLines: ['1 rue de l’Exemple', '38000 Grenoble', '04 00 00 00 00 · accueil@centre.exemple', 'https://www.centre.exemple'],
  linkOrigins: [SITE],
}

const html = (text: string, subject = 'Objet', brand = branding) => renderEmailHtml({ subject, text }, brand)

describe('lecture du texte d’un message', () => {
  it('fait un bouton d’une ligne « Libellé : lien du site »', () => {
    const parsed = parseEmailBody(`Bonjour,\n\nVotre boîte aux lettres : ${SITE}/compte/courrier`, [SITE])
    assert.deepEqual(parsed.blocks, [
      { kind: 'text', lines: ['Bonjour,'] },
      { kind: 'button', label: 'Votre boîte aux lettres', url: `${SITE}/compte/courrier` },
    ])
  })

  it('ne fait pas de bouton d’un lien vers un autre site : un client ne dicte pas les actions du centre', () => {
    assert.equal(buttonOf('Message : https://piege.exemple/connexion', [SITE]), null)
    assert.equal(buttonOf('https://piege.exemple/connexion', [SITE]), null)
    const page = html('Message : https://piege.exemple/connexion')
    assert.match(page, /<a href="https:\/\/piege\.exemple\/connexion"[^>]*>https:\/\/piege\.exemple\/connexion<\/a>/)
    assert.doesNotMatch(page, /mso-padding-alt/)
  })

  it('nomme le bouton d’un lien seul : le mot de passe à choisir, sinon « Ouvrir le lien »', () => {
    assert.deepEqual(buttonOf(`${SITE}/api/auth/reset-password/abc?callbackURL=%2F`, [SITE]), {
      label: 'Choisir mon mot de passe',
      url: `${SITE}/api/auth/reset-password/abc?callbackURL=%2F`,
    })
    assert.equal(buttonOf(`${SITE}/api/auth/verify-email?token=x`, [SITE])?.label, 'Confirmer mon adresse')
    assert.equal(buttonOf(`${SITE}/devis`, [SITE])?.label, 'Ouvrir le lien')
  })

  it('laisse en texte une phrase longue qui finit par un lien', () => {
    const line = `Vous avez déjà un compte chez Centre Horizon : l’équipe vous répond. Connectez-vous : ${SITE}/auth/connexion`
    assert.equal(buttonOf(line, [SITE]), null)
    assert.match(html(line), new RegExp(`<a href="${SITE}/auth/connexion"`))
  })

  it('sépare la signature et le pied de message après « — »', () => {
    const parsed = parseEmailBody(
      `Bonjour,\n\nLe message.\n\n—\nCentre Horizon\n\nPour ne plus le recevoir : ${SITE}/compte/preferences`,
      [SITE],
    )
    assert.deepEqual(parsed.signature, ['Centre Horizon'])
    assert.deepEqual(parsed.blocks, [
      { kind: 'text', lines: ['Bonjour,'] },
      { kind: 'text', lines: ['Le message.'] },
    ])
    // Pas de bouton en pied de message : la désinscription n'est pas l'action.
    assert.deepEqual(parsed.notes, [{ kind: 'text', lines: [`Pour ne plus le recevoir : ${SITE}/compte/preferences`] }])
  })

  it('reconnaît un texte sans signature', () => {
    assert.equal(parseEmailBody('Madame, Monsieur,', [SITE]).signature, null)
  })
})

describe('version texte', () => {
  it('ajoute les lignes de signature sous le nom du centre, à la place où le modèle signe', () => {
    assert.equal(
      withSignature('Bonjour,\n\n—\nCentre Horizon\n\nVous recevez ce message…\nhttps://lien', branding),
      'Bonjour,\n\n—\nCentre Horizon\n1 rue de l’Exemple\n38000 Grenoble\n04 00 00 00 00 · accueil@centre.exemple\n' +
        'https://www.centre.exemple\n\nVous recevez ce message…\nhttps://lien',
    )
  })

  it('signe un texte qui ne signe pas', () => {
    assert.equal(
      withSignature('Madame, Monsieur,\n', { ...branding, signatureLines: ['04 00 00 00 00'] }),
      'Madame, Monsieur,\n\n—\nCentre Horizon\n04 00 00 00 00',
    )
  })

  it('laisse le texte tel quel sans ligne de signature à ajouter', () => {
    const text = 'Bonjour,\n\n—\nCentre Horizon'
    assert.equal(withSignature(text, { ...branding, signatureLines: [] }), text)
  })

  it('met le nom du centre sous un « — » qui ne nomme personne', () => {
    assert.equal(withSignature('Texte\n\n—', { ...branding, signatureLines: [] }), 'Texte\n\n—\nCentre Horizon')
  })
})

describe('HTML', () => {
  it('échappe tout ce qui vient du texte et de l’objet', () => {
    const page = html('Bonjour <script>alert(1)</script> & "Durand"', 'Pli pour <b>Durand</b>')
    assert.doesNotMatch(page, /<script>|<b>/)
    assert.match(page, /Bonjour &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;Durand&quot;/)
    assert.match(page, /<title>Pli pour &lt;b&gt;Durand&lt;\/b&gt;<\/title>/)
  })

  it('ne charge aucune police ni ressource distante : seul le logo vient du site', () => {
    const page = html(`Bonjour,\n\nVotre espace : ${SITE}/compte`)
    assert.doesNotMatch(page, /fonts\.googleapis|@import|<link|<script|@font-face/i)
    assert.match(page, /font-family:Rubik, Arial, Helvetica, sans-serif/)
    const sources = [...page.matchAll(/\ssrc="([^"]+)"/g)].map((match) => match[1])
    assert.deepEqual(sources, [`${SITE}/handfield-logo.png`])
  })

  it('met le logo en tête, avec le nom du centre en texte alternatif et ses dimensions', () => {
    assert.match(html('Texte'), /<img src="https:\/\/centre\.exemple\/handfield-logo\.png" alt="Centre Horizon" width="176" height="56"/)
  })

  it('met le nom du centre en tête quand il n’y a pas de logo', () => {
    const page = html('Texte', 'Objet', { ...branding, logo: null })
    assert.doesNotMatch(page, /<img/)
    assert.match(page, /font-weight:600;color:#00487B;">Centre Horizon<\/p>/)
  })

  it('porte les boutons en bleu foncé et texte blanc, jamais du texte sur le bleu clair', () => {
    const page = html(`Vos réservations : ${SITE}/compte/reservations`)
    assert.match(page, /bgcolor="#00487B"/)
    assert.match(page, /color:#FFFFFF;text-decoration:none;border-radius:12px;">Vos réservations<\/a>/)
    // Le bleu clair n'est qu'un filet.
    assert.deepEqual([...page.matchAll(/#1FABE3/g)].length, 1)
    assert.match(page, /border-top:4px solid #1FABE3/)
  })

  it('signe avec le nom du modèle et les lignes du centre, liens compris', () => {
    const page = html('Bonjour,\n\n—\nL’équipe Horizon')
    assert.match(page, /color:#00487B;">L’équipe Horizon<\/p>/)
    assert.match(page, /1 rue de l’Exemple<br>38000 Grenoble<br>04 00 00 00 00 · <a href="mailto:accueil@centre\.exemple"/)
    assert.match(page, /<a href="https:\/\/www\.centre\.exemple"[^>]*>www\.centre\.exemple<\/a>/)
  })

  it('donne un texte d’aperçu sans la formule d’appel', () => {
    assert.match(html('Bonjour,\n\nUn courrier est arrivé pour vous.'), /mso-hide:all;">Un courrier est arrivé pour vous\.<\/div>/)
  })

  it('s’annonce en français, en thème clair, à 600 px', () => {
    const page = html('Texte')
    assert.match(page, /<html lang="fr"/)
    assert.match(page, /<meta name="color-scheme" content="light">/)
    assert.match(page, /max-width:600px/)
    assert.doesNotMatch(page, /<base /)
    assert.match(renderEmailHtml({ subject: 'Objet', text: 'Texte' }, branding, { preview: true }), /<base target="_blank">/)
  })
})

describe('liens dans le texte', () => {
  it('garde la ponctuation hors du lien', () => {
    assert.equal(
      linkify('Voir https://centre.exemple/compte.'),
      'Voir <a href="https://centre.exemple/compte" style="color:#00487B;text-decoration:underline;">https://centre.exemple/compte</a>.',
    )
  })

  it('fait un lien d’une adresse électronique et d’une adresse en www', () => {
    assert.match(linkify('Écrire à accueil@centre.exemple'), /<a href="mailto:accueil@centre\.exemple"/)
    assert.match(linkify('www.centre.exemple'), /<a href="https:\/\/www\.centre\.exemple"/)
  })

  it('montre une adresse web sans https:// dans la signature seulement', () => {
    assert.match(linkify('https://www.centre.exemple/', { compact: true }), />www\.centre\.exemple<\/a>/)
    assert.match(linkify('https://www.centre.exemple/'), />https:\/\/www\.centre\.exemple\/<\/a>/)
  })

  it('échappe une adresse piégée', () => {
    assert.equal(escapeHtml(`"'<>&`), '&quot;&#39;&lt;&gt;&amp;')
    assert.doesNotMatch(linkify('https://x.exemple/a"onmouseover="alert(1)'), /"onmouseover=/)
  })
})

describe('tous les modèles du catalogue, présents et à venir', () => {
  const events = Object.keys(defaultTemplates) as NotificationEvent[]

  it('passent dans le gabarit, liens du site en boutons, signature complétée', () => {
    for (const event of events) {
      const rendered = renderMessage(
        defaultTemplates[event],
        exampleValuesFor(event, { centre: branding.centreName, origin: SITE }),
        notificationEventLabels[event],
      )
      const { text, html: page } = brandMessage({ subject: rendered.subject, text: rendered.body }, branding)
      assert.match(page, /^<!DOCTYPE html>/, event)
      assert.ok(page.includes(escapeHtml(rendered.subject)), event)
      assert.ok(text.startsWith(rendered.body.split('\n')[0]), event)
      assert.ok(text.includes('38000 Grenoble'), event)
      assert.ok(page.includes('38000 Grenoble'), event)
      // Aucune variable restée en accolades, aucune balise venue d'une valeur.
      assert.doesNotMatch(page, /\{\{|<script/, event)
    }
  })

  it('font un bouton des messages qui mènent à l’espace client', () => {
    for (const event of ['mail_batch_received', 'mail_scanned', 'request_received', 'member_invited'] as const) {
      const rendered = renderMessage(
        defaultTemplates[event],
        exampleValuesFor(event, { centre: branding.centreName, origin: SITE }),
        notificationEventLabels[event],
      )
      assert.match(html(rendered.body, rendered.subject), /mso-padding-alt:12px 24px/, event)
    }
  })
})
