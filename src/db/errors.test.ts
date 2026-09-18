import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PG_CHECK_VIOLATION,
  PG_EXCLUSION_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
} from './errors.ts'

/** Erreur du driver, telle que `postgres` la lève. */
const erreurDriver = (code: string) => Object.assign(new Error('erreur base'), { code })

/** Enveloppe façon Drizzle : le code d'origine descend d'un cran. */
const enveloppe = (cause: unknown, message = 'Failed query') =>
  Object.assign(new Error(message), { cause })

describe('lecture du code d’erreur Postgres', () => {
  it('lit le code posé directement sur l’erreur', () => {
    assert.equal(pgErrorCode(erreurDriver(PG_EXCLUSION_VIOLATION)), '23P01')
  })

  it('déroule l’enveloppe de Drizzle', () => {
    // Depuis la 0.44, Drizzle enveloppe l'erreur du driver : sans ce déroulage,
    // un conflit de créneau serait indiscernable d'une panne.
    assert.equal(pgErrorCode(enveloppe(erreurDriver(PG_UNIQUE_VIOLATION))), '23505')
  })

  it('descend plusieurs enveloppes', () => {
    const empile = enveloppe(enveloppe(enveloppe(erreurDriver(PG_CHECK_VIOLATION))))
    assert.equal(pgErrorCode(empile), '23514')
  })

  it('rend le premier code rencontré, du plus extérieur au plus profond', () => {
    // Une enveloppe qui porterait elle-même un code fait autorité : c'est celui
    // que le code appelant voit.
    const melange = Object.assign(new Error('surcouche'), {
      code: PG_FOREIGN_KEY_VIOLATION,
      cause: erreurDriver(PG_EXCLUSION_VIOLATION),
    })
    assert.equal(pgErrorCode(melange), '23503')
  })

  describe('ce qui n’est pas un SQLSTATE', () => {
    it('ignore une erreur sans code', () => {
      assert.equal(pgErrorCode(new Error('panne réseau')), undefined)
    })

    it('ignore un code qui n’a pas la forme d’un SQLSTATE', () => {
      // Cinq caractères exactement, chiffres et majuscules : « ECONNREFUSED »
      // n'en est pas un, et ne doit pas être pris pour une violation.
      assert.equal(pgErrorCode(erreurDriver('ECONNREFUSED')), undefined)
      assert.equal(pgErrorCode(erreurDriver('23P0')), undefined)
      assert.equal(pgErrorCode(erreurDriver('23p01')), undefined)
    })

    it('ignore un code qui n’est pas une chaîne', () => {
      assert.equal(pgErrorCode(Object.assign(new Error('x'), { code: 23514 })), undefined)
    })

    it('encaisse ce qui n’est pas une erreur', () => {
      assert.equal(pgErrorCode(undefined), undefined)
      assert.equal(pgErrorCode(null), undefined)
      assert.equal(pgErrorCode('23P01'), undefined)
    })

    it('laisse passer un code système de cinq majuscules, sans conséquence', () => {
      // « EPIPE » a la forme d'un SQLSTATE et ressort tel quel. Sans gravité :
      // le code appelant compare à des valeurs précises — il ne le prendra
      // jamais pour un conflit de créneau, il le traitera comme une erreur
      // inconnue et la relèvera. Ce test fige ce comportement.
      const code = pgErrorCode(erreurDriver('EPIPE'))
      assert.equal(code, 'EPIPE')
      assert.notEqual(code, PG_EXCLUSION_VIOLATION)
    })
  })

  describe('chaînes de causes dégénérées', () => {
    it('ne boucle pas sur une chaîne circulaire', () => {
      const a: { cause?: unknown } = new Error('a')
      const b = Object.assign(new Error('b'), { cause: a })
      a.cause = b
      // Aucun driver ne produit ça aujourd'hui ; sans borne, la page entière se
      // bloquerait si l'un s'y mettait.
      assert.equal(pgErrorCode(a), undefined)
    })

    it('abandonne au-delà de la profondeur bornée', () => {
      let erreur: unknown = erreurDriver(PG_EXCLUSION_VIOLATION)
      for (let i = 0; i < 12; i++) erreur = enveloppe(erreur)
      assert.equal(pgErrorCode(erreur), undefined)
    })

    it('trouve encore un code à la limite de la profondeur', () => {
      let erreur: unknown = erreurDriver(PG_EXCLUSION_VIOLATION)
      for (let i = 0; i < 9; i++) erreur = enveloppe(erreur)
      assert.equal(pgErrorCode(erreur), '23P01')
    })
  })

  it('donne des constantes distinctes', () => {
    const codes = [
      PG_EXCLUSION_VIOLATION,
      PG_UNIQUE_VIOLATION,
      PG_CHECK_VIOLATION,
      PG_FOREIGN_KEY_VIOLATION,
    ]
    assert.equal(new Set(codes).size, codes.length)
  })
})
