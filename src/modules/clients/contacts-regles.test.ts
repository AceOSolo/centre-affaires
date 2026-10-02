import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  isValidEmail,
  normaliseEmail,
  normalisePhone,
  phoneHref,
  readContactForm,
} from './contacts-regles.ts'

const form = (fields: Record<string, string>) => {
  const data = new FormData()
  for (const [key, value] of Object.entries(fields)) data.set(key, value)
  return data
}

/** Ce qui serait écrit en base, ou `undefined` si le formulaire est refusé. */
const inputOf = (read: ReturnType<typeof readContactForm>) =>
  'input' in read ? read.input : undefined

describe('normaliseEmail et isValidEmail', () => {
  it('range l’adresse en minuscules, sans espaces autour', () => {
    assert.equal(normaliseEmail('  Alice.Martin@Acme.FR '), 'alice.martin@acme.fr')
  })

  it('accepte une adresse plausible', () => {
    for (const email of ['alice@acme.fr', 'a.b+compta@cabinet-roy.co.uk', 'x@y.io']) {
      assert.ok(isValidEmail(email), email)
    }
  })

  it('refuse ce qui n’a pas la forme d’une adresse', () => {
    for (const email of ['alice', 'alice@', '@acme.fr', 'alice@acme', 'alice martin@acme.fr', 'a@b@c.fr']) {
      assert.equal(isValidEmail(email), false, email)
    }
  })

  it('refuse une adresse plus longue que la norme', () => {
    assert.equal(isValidEmail(`${'a'.repeat(250)}@acme.fr`), false)
  })
})

describe('normalisePhone', () => {
  it('laisse un numéro vide sans erreur', () => {
    assert.deepEqual(normalisePhone('   '), { phone: null })
  })

  it('range un numéro français à 10 chiffres par paires, quels que soient les séparateurs', () => {
    for (const saisie of ['0123456789', '01 23 45 67 89', '01.23.45.67.89', '01-23-45-67-89', ' 06 12 34 56 78 ']) {
      const { phone, error } = normalisePhone(saisie)
      assert.equal(error, undefined, saisie)
      assert.match(phone ?? '', /^0\d( \d{2}){4}$/, saisie)
    }
    assert.equal(normalisePhone('01.23.45.67.89').phone, '01 23 45 67 89')
  })

  it('range un numéro en +33 sous une forme unique', () => {
    for (const saisie of [
      '+33 1 23 45 67 89',
      '+33123456789',
      '+33 (0)1 23 45 67 89',
      '+33 01 23 45 67 89',
      '0033 1 23 45 67 89',
      '0033 (0)1 23 45 67 89',
    ]) {
      assert.deepEqual(normalisePhone(saisie), { phone: '+33 1 23 45 67 89' }, saisie)
    }
  })

  it('garde le découpage d’un numéro étranger, séparateurs ramenés à une espace', () => {
    assert.deepEqual(normalisePhone('+32 2 123 45 67'), { phone: '+32 2 123 45 67' })
    assert.deepEqual(normalisePhone('+1 (415) 555-0100'), { phone: '+1 415 555 0100' })
    assert.deepEqual(normalisePhone('0032.2.123.45.67'), { phone: '+32 2 123 45 67' })
    // Le 0 de la notation « (0) » ne se compose pas, à l'étranger non plus.
    assert.deepEqual(normalisePhone('+32 (0)2 123 45 67'), { phone: '+32 2 123 45 67' })
  })

  it('refuse les lettres et les caractères étrangers à un numéro', () => {
    for (const saisie of ['01 23 45 67 8a', 'standard', '01 23 45 67 89 poste 12', '06*12*34*56*78', '01 23 + 45']) {
      assert.ok(normalisePhone(saisie).error, saisie)
      assert.equal(normalisePhone(saisie).phone, null, saisie)
    }
  })

  it('refuse un numéro national incomplet ou trop long', () => {
    for (const saisie of ['01 23 45 67', '123456789', '01234567890', '1234567890']) {
      assert.ok(normalisePhone(saisie).error, saisie)
    }
  })

  it('refuse un numéro international hors des longueurs E.164', () => {
    assert.ok(normalisePhone('+33 1 23 45 67').error, '+33 à 8 chiffres')
    assert.ok(normalisePhone('+33 1 23 45 67 89 0').error, '+33 à 10 chiffres')
    assert.ok(normalisePhone('+44 12 34').error, 'trop court')
    assert.ok(normalisePhone('+49 1234 5678 9012 3456').error, 'trop long')
  })
})

describe('phoneHref', () => {
  it('ne garde que les chiffres et le +', () => {
    assert.equal(phoneHref('01 23 45 67 89'), 'tel:0123456789')
    assert.equal(phoneHref('+33 1 23 45 67 89'), 'tel:+33123456789')
  })
})

describe('readContactForm', () => {
  it('normalise un contact complet', () => {
    const read = readContactForm(
      form({
        fullName: '  Alice   Martin ',
        jobTitle: ' Gérante ',
        email: 'Alice@Acme.fr',
        phone: '01.23.45.67.89',
        isPrimary: 'on',
        notes: '  Préfère le matin. ',
      }),
    )
    assert.equal(read.fieldErrors, undefined)
    assert.deepEqual(inputOf(read), {
      fullName: 'Alice Martin',
      jobTitle: 'Gérante',
      email: 'alice@acme.fr',
      phone: '01 23 45 67 89',
      isPrimary: true,
      isBilling: false,
      notes: 'Préfère le matin.',
    })
  })

  it('n’exige que le nom', () => {
    const read = readContactForm(form({ fullName: 'Cabinet Roy', isBilling: 'on' }))
    assert.deepEqual(inputOf(read), {
      fullName: 'Cabinet Roy',
      jobTitle: null,
      email: null,
      phone: null,
      isPrimary: false,
      isBilling: true,
      notes: null,
    })
  })

  it('rend toutes les erreurs d’un coup, avec la saisie à réafficher', () => {
    const read = readContactForm(form({ fullName: '   ', email: 'alice@', phone: '01 23' }))
    assert.deepEqual(Object.keys(read.fieldErrors ?? {}).sort(), ['email', 'fullName', 'phone'])
    assert.equal(inputOf(read), undefined)
    // La saisie est rendue telle quelle, pour que la personne la corrige.
    assert.equal(read.values.email, 'alice@')
    assert.equal(read.values.phone, '01 23')
  })

  it('lit une case décochée comme fausse', () => {
    const read = readContactForm(form({ fullName: 'Alice Martin' }))
    assert.equal(read.values.isPrimary, false)
    assert.equal(read.values.isBilling, false)
  })
})
