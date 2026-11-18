import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  addressTitle,
  domiciliationLines,
  MAX_FORWARD_ADDRESSES,
  nextDefault,
  placeNewAddress,
  readAddressBookInput,
  readForwardChoice,
  sortAddressBook,
  type AddressBookEntry,
} from './carnet-adresses-regles.ts'
import type { ForwardAddress } from './demandes-regles.ts'

const ID = (n: number) => `01a00000-0000-7000-8000-00000000ad${String(n).padStart(2, '0')}`

const siege: ForwardAddress = {
  recipient: 'Atelier Durand',
  line1: '3 rue des Lilas',
  line2: null,
  postalCode: '69003',
  city: 'Lyon',
  country: 'FR',
}
const entry = (n: number, address: ForwardAddress, extra: Partial<AddressBookEntry> = {}): AddressBookEntry => ({
  id: ID(n),
  clientId: 'c',
  label: null,
  address,
  isDefault: false,
  ...extra,
})

describe('adresse saisie dans le carnet (ADR 078)', () => {
  it('reprend les règles de la réexpédition, avec un nom court facultatif', () => {
    const read = readAddressBookInput({
      adresseNom: '  Siège  ',
      forwardRecipient: 'Atelier Durand',
      forwardAddressLine1: '3 rue des Lilas',
      forwardPostalCode: '69003',
      forwardCity: 'Lyon',
      forwardCountry: 'FR',
      parDefaut: 'on',
    })
    assert.deepEqual(read.input, { label: 'Siège', address: siege, isDefault: true })
  })

  it('dit chaque champ manquant ou trop long', () => {
    const read = readAddressBookInput({ adresseNom: 'x'.repeat(61), forwardPostalCode: '6900', forwardCountry: 'FR' })
    assert.ok(read.fieldErrors)
    assert.match(read.fieldErrors.adresseNom, /60 caractères/)
    assert.ok(read.fieldErrors.forwardRecipient)
    assert.ok(read.fieldErrors.forwardAddressLine1)
    assert.match(read.fieldErrors.forwardPostalCode, /cinq chiffres/)
  })
})

describe('place d’une adresse dans le carnet', () => {
  it('la première adresse devient celle par défaut', () => {
    assert.deepEqual(placeNewAddress([], { label: null, address: siege, isDefault: false }), { isDefault: true })
    assert.deepEqual(placeNewAddress([entry(1, { ...siege, city: 'Paris' })], { label: null, address: siege, isDefault: false }), {
      isDefault: false,
    })
  })

  it('refuse un doublon à la casse et aux espaces près, sauf l’adresse elle-même', () => {
    const book = [entry(1, siege)]
    const twin = { ...siege, recipient: 'ATELIER  DURAND ' }
    assert.match(placeNewAddress(book, { label: null, address: twin, isDefault: false }).error ?? '', /déjà dans votre carnet/)
    assert.deepEqual(placeNewAddress(book, { label: 'Siège', address: twin, isDefault: false }, ID(1)), { isDefault: false })
  })

  it('vingt adresses au plus', () => {
    const full = Array.from({ length: MAX_FORWARD_ADDRESSES }, (_, n) => entry(n, { ...siege, line1: `${n} rue` }))
    assert.match(placeNewAddress(full, { label: null, address: siege, isDefault: false }).error ?? '', /20 adresses/)
    // Modifier une adresse d'un carnet plein reste possible.
    assert.ok(!placeNewAddress(full, { label: null, address: { ...siege, line1: '0 rue' }, isDefault: false }, ID(0)).error)
  })

  it('celle par défaut retirée, la première restante prend sa place', () => {
    const book = [
      entry(1, siege, { label: 'Zénith', isDefault: true }),
      entry(2, siege, { label: 'Bureau' }),
      entry(3, siege, { label: 'Atelier' }),
    ]
    assert.equal(nextDefault(book, ID(1)), ID(3))
    assert.equal(nextDefault(book, ID(2)), undefined)
    assert.equal(nextDefault([book[0]], ID(1)), undefined)
  })

  it('range l’adresse par défaut d’abord, puis par nom', () => {
    const sorted = sortAddressBook([
      entry(1, siege, { label: 'Bureau' }),
      entry(2, { ...siege, recipient: 'Albert' }),
      entry(3, siege, { label: 'Zénith', isDefault: true }),
    ])
    assert.deepEqual(
      sorted.map((item) => item.id),
      [ID(3), ID(2), ID(1)],
    )
    assert.equal(addressTitle(sorted[1]), 'Albert, Lyon')
  })
})

describe('choix d’adresse d’une demande d’envoi', () => {
  it('carnet, réexpédition passée, ou saisie', () => {
    assert.deepEqual(readForwardChoice(`carnet:${ID(1)}`), { source: 'carnet', id: ID(1) })
    assert.deepEqual(readForwardChoice(ID(2)), { source: 'precedente', requestId: ID(2) })
    assert.deepEqual(readForwardChoice('nouvelle'), { source: 'nouvelle' })
    assert.deepEqual(readForwardChoice('carnet:pas-un-id'), { source: 'nouvelle' })
    assert.deepEqual(readForwardChoice(undefined), { source: 'nouvelle' })
  })
})

describe('adresse de domiciliation', () => {
  const pays = (code: string) => (code === 'BE' ? 'Belgique' : code)

  it('la raison sociale à l’adresse du centre, sans le pays en France', () => {
    assert.deepEqual(
      domiciliationLines(
        'Atelier Durand',
        { addressLine1: '12 avenue Foch', addressLine2: 'Bâtiment B', postalCode: '69006', city: 'Lyon', country: 'FR' },
        pays,
      ),
      ['Atelier Durand', '12 avenue Foch', 'Bâtiment B', '69006 Lyon'],
    )
    assert.deepEqual(
      domiciliationLines('Durand', { addressLine1: '1 rue Neuve', addressLine2: null, postalCode: '1000', city: 'Bruxelles', country: 'BE' }, pays),
      ['Durand', '1 rue Neuve', '1000 Bruxelles', 'Belgique'],
    )
  })

  it('rien tant que le centre n’a pas d’adresse', () => {
    assert.equal(
      domiciliationLines('Durand', { addressLine1: null, addressLine2: null, postalCode: '69006', city: 'Lyon', country: 'FR' }, pays),
      null,
    )
  })
})
