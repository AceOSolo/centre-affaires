import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DB_CHECK_VIOLATION,
  DB_CONTRACT_OCCUPATION_LOCKED,
  DB_EXCLUSION_VIOLATION,
  DB_FOREIGN_KEY_VIOLATION,
  DB_INSUFFICIENT_PRIVILEGE,
  DB_NOT_NULL_VIOLATION,
  DB_TENANT_MISMATCH,
  DB_UNIQUE_VIOLATION,
  dbConstraintName,
  dbErrorCode,
} from './errors.ts'

/** Erreur du driver, telle que `mysql2` la lève : `errno` et `sqlMessage`. */
const erreurDriver = (errno: number, sqlMessage = 'erreur base') =>
  Object.assign(new Error(sqlMessage), { errno, sqlMessage, code: 'ER_X', sqlState: '23000' })

/** Erreur levée par un trigger : `SIGNAL SQLSTATE '45000'` (errno 1644). */
const erreurRegle = (message: string) => erreurDriver(1644, message)

/** Enveloppe façon Drizzle : l'erreur d'origine descend d'un cran. */
const enveloppe = (cause: unknown, message = 'Failed query') =>
  Object.assign(new Error(message), { cause })

describe('lecture du code d’erreur MySQL', () => {
  it('traduit le numéro d’erreur en code normalisé', () => {
    assert.equal(dbErrorCode(erreurDriver(1062)), DB_UNIQUE_VIOLATION)
    assert.equal(dbErrorCode(erreurDriver(1452)), DB_FOREIGN_KEY_VIOLATION)
    assert.equal(dbErrorCode(erreurDriver(1451)), DB_FOREIGN_KEY_VIOLATION)
    assert.equal(dbErrorCode(erreurDriver(3819)), DB_CHECK_VIOLATION)
    assert.equal(dbErrorCode(erreurDriver(1048)), DB_NOT_NULL_VIOLATION)
    assert.equal(dbErrorCode(erreurDriver(1142)), DB_INSUFFICIENT_PRIVILEGE)
    assert.equal(dbErrorCode(erreurDriver(1213)), '40P01')
  })

  it('lit un code propre à l’application, préfixe du message d’un trigger', () => {
    // `CA001` : occupation de contrat écrite en direct.
    const erreur = erreurRegle('CA001: une occupation de contrat se modifie à travers son contrat.')
    assert.equal(dbErrorCode(erreur), DB_CONTRACT_OCCUPATION_LOCKED)
    assert.equal(dbErrorCode(erreurRegle('CA000: créneau déjà pris.')), DB_EXCLUSION_VIOLATION)
    assert.equal(dbErrorCode(erreurRegle('CA014: autre centre.')), DB_TENANT_MISMATCH)
  })

  it('déroule l’enveloppe de Drizzle', () => {
    // Drizzle enveloppe l'erreur du driver : sans ce déroulage, un conflit de
    // créneau serait indiscernable d'une panne.
    assert.equal(dbErrorCode(enveloppe(erreurDriver(1062))), DB_UNIQUE_VIOLATION)
    assert.equal(dbErrorCode(enveloppe(erreurRegle('CA000: créneau.'))), 'CA000')
  })

  it('descend plusieurs enveloppes', () => {
    const empile = enveloppe(enveloppe(enveloppe(erreurDriver(3819))))
    assert.equal(dbErrorCode(empile), DB_CHECK_VIOLATION)
  })

  it('rend le premier code rencontré, du plus extérieur au plus profond', () => {
    // Une enveloppe qui porterait elle-même un numéro fait autorité.
    const melange = Object.assign(new Error('surcouche'), {
      errno: 1452,
      cause: erreurDriver(1062),
    })
    assert.equal(dbErrorCode(melange), DB_FOREIGN_KEY_VIOLATION)
  })

  describe('ce qui n’est pas une erreur de règle ou de contrainte', () => {
    it('ignore une erreur sans numéro', () => {
      assert.equal(dbErrorCode(new Error('panne réseau')), undefined)
    })

    it('ignore un numéro inconnu', () => {
      assert.equal(dbErrorCode(erreurDriver(9999)), undefined)
    })

    it('ignore un message de signal qui n’a pas la forme CAnnn:', () => {
      assert.equal(dbErrorCode(erreurRegle('Numérotation impossible hors du contexte.')), undefined)
      assert.equal(dbErrorCode(erreurRegle('ca001: minuscules')), undefined)
      assert.equal(dbErrorCode(erreurRegle('CA01: trop court')), undefined)
      // Le préfixe doit commencer le message : un `CA001:` cité plus loin n'en est pas un.
      assert.equal(dbErrorCode(erreurRegle('voir CA001: ailleurs')), undefined)
    })

    it('ignore un numéro qui n’est pas un nombre', () => {
      assert.equal(dbErrorCode(Object.assign(new Error('x'), { errno: '1062' })), undefined)
    })

    it('encaisse ce qui n’est pas une erreur', () => {
      assert.equal(dbErrorCode(undefined), undefined)
      assert.equal(dbErrorCode(null), undefined)
      assert.equal(dbErrorCode('CA000: texte'), undefined)
    })
  })

  describe('chaînes de causes dégénérées', () => {
    it('ne boucle pas sur une chaîne circulaire', () => {
      const a: { cause?: unknown } = new Error('a')
      const b = Object.assign(new Error('b'), { cause: a })
      a.cause = b
      // Sans borne, la page entière se bloquerait si un driver en produisait une.
      assert.equal(dbErrorCode(a), undefined)
    })

    it('abandonne au-delà de la profondeur bornée', () => {
      let erreur: unknown = erreurDriver(1062)
      for (let i = 0; i < 12; i++) erreur = enveloppe(erreur)
      assert.equal(dbErrorCode(erreur), undefined)
    })

    it('trouve encore un code à la limite de la profondeur', () => {
      let erreur: unknown = erreurDriver(1062)
      for (let i = 0; i < 9; i++) erreur = enveloppe(erreur)
      assert.equal(dbErrorCode(erreur), DB_UNIQUE_VIOLATION)
    })
  })

  describe('nom de la contrainte en cause', () => {
    it('lit l’index d’une unicité, sous l’enveloppe de Drizzle', () => {
      const erreur = erreurDriver(
        1062,
        "Duplicate entry 'SAL-1' for key 'resources.resources_tenant_locker_numero_key'",
      )
      assert.equal(dbConstraintName(enveloppe(erreur)), 'resources_tenant_locker_numero_key')
    })

    it('lit un index cité sans nom de table', () => {
      const erreur = erreurDriver(1062, "Duplicate entry 'x' for key 'staff_members_auth_user_key'")
      assert.equal(dbConstraintName(erreur), 'staff_members_auth_user_key')
    })

    it('lit le nom d’un check', () => {
      const erreur = erreurDriver(3819, "Check constraint 'bookings_valid_range' is violated.")
      assert.equal(dbConstraintName(erreur), 'bookings_valid_range')
    })

    it('lit le nom d’une clé étrangère', () => {
      const erreur = erreurDriver(
        1452,
        'Cannot add or update a child row: a foreign key constraint fails (`db`.`bookings`, CONSTRAINT `bookings_resource_fk` FOREIGN KEY (`resource_id`) REFERENCES `resources` (`id`))',
      )
      assert.equal(dbConstraintName(erreur), 'bookings_resource_fk')
    })

    it('ne rend rien pour une erreur sans contrainte', () => {
      assert.equal(dbConstraintName(enveloppe(erreurDriver(1048, 'Column is null'))), undefined)
      assert.equal(dbConstraintName(new Error('panne réseau')), undefined)
      assert.equal(dbConstraintName(undefined), undefined)
    })
  })

  it('donne des constantes distinctes', () => {
    const codes = [
      DB_EXCLUSION_VIOLATION,
      DB_UNIQUE_VIOLATION,
      DB_CHECK_VIOLATION,
      DB_FOREIGN_KEY_VIOLATION,
      DB_NOT_NULL_VIOLATION,
      DB_INSUFFICIENT_PRIVILEGE,
      DB_TENANT_MISMATCH,
    ]
    assert.equal(new Set(codes).size, codes.length)
  })
})
