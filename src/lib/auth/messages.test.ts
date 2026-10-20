import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MOT_DE_PASSE_MIN, messageRefusAuth, tropDeTentatives } from './messages.ts'

/**
 * Les refus de Better Auth arrivent en anglais : l'écran les dit en français,
 * choisis par leur code.
 */
const repli = 'La connexion a échoué.'

describe('messages des refus d’authentification', () => {
  it('connexion : ne dit pas lequel de l’adresse ou du mot de passe est faux', () => {
    const refus = { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password', status: 401 }
    assert.deepEqual(messageRefusAuth(refus, repli), { message: 'Adresse ou mot de passe incorrect.' })
  })

  it('inscription : un compte existe déjà, quelle que soit la variante du code', () => {
    for (const code of ['USER_ALREADY_EXISTS', 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL']) {
      const { message, champ } = messageRefusAuth({ code, message: 'User already exists.', status: 422 }, repli)
      assert.match(message, /^Un compte existe déjà avec cette adresse/)
      assert.equal(champ, 'email')
    }
  })

  it('adresse non confirmée', () => {
    const { message } = messageRefusAuth({ code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified', status: 403 }, repli)
    assert.match(message, /^Adresse non confirmée/)
  })

  it('mot de passe trop court : rattaché au champ, avec la longueur exigée', () => {
    const resultat = messageRefusAuth({ code: 'PASSWORD_TOO_SHORT', message: 'Password too short', status: 400 }, repli)
    assert.equal(resultat.champ, 'password')
    assert.ok(resultat.message.includes(`${MOT_DE_PASSE_MIN} caractères`))
  })

  it('trop de tentatives, quel que soit le code', () => {
    assert.deepEqual(messageRefusAuth({ status: 429, message: 'Too many requests' }, repli), { message: tropDeTentatives })
    assert.deepEqual(
      messageRefusAuth({ code: 'INVALID_EMAIL_OR_PASSWORD', status: 429 }, repli),
      { message: tropDeTentatives },
    )
  })

  it('lien de réinitialisation périmé', () => {
    for (const code of ['INVALID_TOKEN', 'TOKEN_EXPIRED']) {
      assert.match(messageRefusAuth({ code, message: 'Invalid token', status: 400 }, repli).message, /plus valable/)
    }
  })

  it('garde tel quel le message des codes du projet, déjà en français', () => {
    const banni = 'Ce compte est suspendu. Pour en savoir plus, contactez l’équipe du centre.'
    assert.deepEqual(messageRefusAuth({ code: 'BANNED_USER', message: banni, status: 403 }, repli), { message: banni })
    const preuve = { code: 'PREUVE_HUMAINE', message: 'La vérification anti-robot n’a pas abouti.', status: 400 }
    assert.deepEqual(messageRefusAuth(preuve, repli), { message: preuve.message })
    // Sans message, celui du projet par défaut.
    assert.match(messageRefusAuth({ code: 'BANNED_USER', status: 403 }, repli).message, /suspendu/)
  })

  it('n’affiche jamais le message brut d’un code inconnu : le repli du formulaire', () => {
    const refus = { code: 'FAILED_TO_CREATE_USER', message: 'Failed to create user', status: 422 }
    assert.deepEqual(messageRefusAuth(refus, repli), { message: repli })
    assert.deepEqual(messageRefusAuth({ message: 'Something went wrong', status: 500 }, repli), { message: repli })
    assert.deepEqual(messageRefusAuth(null, repli), { message: repli })
  })
})
