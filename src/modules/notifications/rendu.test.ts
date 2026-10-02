import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  TEMPLATE_BODY_MAX,
  placeholdersOf,
  renderBody,
  renderMessage,
  renderSubject,
  validateTemplate,
} from './rendu.ts'

/**
 * Rendu des modèles de messages (R26, ADR 038) : variables nommées remplacées
 * en une passe, valeurs manquantes, objet sur une ligne, vérification à
 * l'enregistrement.
 */
describe('rendu des modèles', () => {
  it('remplace les variables nommées, espaces autour du nom compris', () => {
    assert.equal(
      renderBody('Bonjour {{client}}, de la part de {{ centre }}.', { client: 'Atelier Durand', centre: 'Handfield' }),
      'Bonjour Atelier Durand, de la part de Handfield.',
    )
  })

  it('cite plusieurs fois la même variable', () => {
    assert.equal(renderSubject('{{client}} — {{client}}', { client: 'Durand' }), 'Durand — Durand')
  })

  it('ne réinterprète jamais une valeur comme une variable', () => {
    // Un nom de société, un motif saisi par l'équipe : du texte, pas un modèle.
    const body = renderBody('Motif : {{motif}}', { motif: '{{lien}} {{centre}}', lien: 'https://piege', centre: 'X' })
    assert.equal(body, 'Motif : {{lien}} {{centre}}')
  })

  it('retire la ligne qui cite une variable manquante, et elle seule', () => {
    const body = renderBody('Bonjour,\n\nVotre boîte aux lettres : {{lien}}\n\nPar confidentialité, rien de joint.', {
      lien: undefined,
    })
    assert.equal(body, 'Bonjour,\n\nPar confidentialité, rien de joint.')
  })

  it('tient pour manquante une valeur nulle ou blanche', () => {
    assert.equal(renderBody('A\nMotif : {{motif}}\nB', { motif: null }), 'A\nB')
    assert.equal(renderBody('A\nMotif : {{motif}}\nB', { motif: '   ' }), 'A\nB')
  })

  it('réduit les lignes vides qui se suivent après un retrait', () => {
    const body = renderBody('Bonjour,\n\n{{remarques}}\n\nAu revoir.', {})
    assert.equal(body, 'Bonjour,\n\nAu revoir.')
  })

  it('garde les sauts de ligne d’une valeur dans le corps', () => {
    assert.equal(renderBody('{{lettre}}', { lettre: 'Madame,\r\n\r\nVotre facture.' }), 'Madame,\n\nVotre facture.')
  })

  it('met l’objet sur une ligne : ni saut ni caractère de contrôle', () => {
    assert.equal(
      renderSubject('Courrier pour {{client}}', { client: 'Atelier\nDurand\u0007\r\nBcc: pirate@exemple.fr' }),
      'Courrier pour Atelier Durand Bcc: pirate@exemple.fr',
    )
  })

  it('remplace par rien une variable manquante de l’objet', () => {
    assert.equal(renderSubject('Réservation {{ressource}} confirmée', {}), 'Réservation confirmée')
  })

  it('donne un objet de secours quand tout l’objet manque', () => {
    assert.equal(renderMessage({ subject: '{{objet}}', body: 'Texte' }, {}, 'Relance d’impayé').subject, 'Relance d’impayé')
  })

  it('borne l’objet à 200 caractères', () => {
    const subject = renderMessage({ subject: '{{objet}}', body: 'x' }, { objet: 'a'.repeat(300) }, 'Secours').subject
    assert.equal(subject.length, 200)
    assert.ok(subject.endsWith('…'))
  })

  it('liste les variables citées, sans doublon', () => {
    assert.deepEqual(placeholdersOf('{{client}} {{ lien }} {{client}}'), ['client', 'lien'])
  })
})

describe('vérification d’un modèle', () => {
  it('accepte un modèle qui ne cite que les variables de l’événement', () => {
    assert.deepEqual(
      validateTemplate('mail_received', {
        subject: 'Courrier pour {{client}}',
        body: 'Bonjour,\n\nUn {{nature}} est arrivé le {{date}}.\n\n{{lien}}\n\n{{centre}}',
      }),
      {},
    )
  })

  it('refuse une variable d’un autre événement, en donnant les variables possibles', () => {
    const errors = validateTemplate('mail_received', { subject: 'Facture {{numero}}', body: 'Texte' })
    assert.match(errors.subject ?? '', /Variable inconnue pour ce message : \{\{numero\}\}/)
    assert.match(errors.subject ?? '', /\{\{client\}\}/)
  })

  it('refuse des accolades mal fermées', () => {
    for (const body of ['Bonjour {{client}', 'Bonjour {client}}', 'Bonjour {{client', '{{}} vide']) {
      const errors = validateTemplate('mail_received', { subject: 'Objet', body })
      assert.ok(errors.body, body)
    }
  })

  it('refuse un objet vide, sur plusieurs lignes ou trop long', () => {
    assert.ok(validateTemplate('mail_received', { subject: '  ', body: 'Texte' }).subject)
    assert.ok(validateTemplate('mail_received', { subject: 'Ligne\nautre', body: 'Texte' }).subject)
    assert.ok(validateTemplate('mail_received', { subject: 'a'.repeat(201), body: 'Texte' }).subject)
  })

  it('refuse un texte vide ou trop long', () => {
    assert.ok(validateTemplate('mail_received', { subject: 'Objet', body: '\n ' }).body)
    assert.ok(validateTemplate('mail_received', { subject: 'Objet', body: 'a'.repeat(TEMPLATE_BODY_MAX + 1) }).body)
  })
})
