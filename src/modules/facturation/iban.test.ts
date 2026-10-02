import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'

import { DocumentIntegrityError, type DocumentKeyring } from '../../lib/chiffrement-documents.ts'
import {
  InvalidIbanError,
  isValidIban,
  maskIban,
  normalizeIban,
  openIban,
  sealIban,
} from './iban.ts'

/** IBAN de démonstration publiés par les banques : aucune donnée réelle. */
const IBAN_FR = 'FR76 3000 6000 0112 3456 7890 189'
const IBAN_DE = 'DE89370400440532013000'

const MANDAT = { tenantId: '01999f00-0000-7000-8000-000000000001', reference: 'RUM-2026-0001' }
const cle = randomBytes(32)
const trousseau: DocumentKeyring = { currentVersion: 1, keys: new Map([[1, cle]]) }

describe('IBAN', () => {
  it('se normalise en majuscules, sans espace', () => {
    assert.equal(normalizeIban(' fr76 3000-6000 0112 3456 7890 189 '), 'FR7630006000011234567890189')
  })

  it('se contrôle par la clé modulo 97', () => {
    assert.equal(isValidIban(IBAN_FR), true)
    assert.equal(isValidIban(IBAN_DE), true)
    assert.equal(isValidIban('FR7630006000011234567890188'), false)
    assert.equal(isValidIban('FR76'), false)
    assert.equal(isValidIban('1234567890123456'), false)
  })

  it('se chiffre sans rien laisser de lisible, et se relit', () => {
    const sealed = sealIban(IBAN_FR, MANDAT, trousseau)
    assert.equal(sealed.keyVersion, 1)
    assert.equal(sealed.last4, '0189')
    assert.equal(sealed.ciphertext.subarray(0, 4).toString('ascii'), 'CAD1')
    assert.ok(!sealed.ciphertext.includes('FR76'))
    assert.ok(!sealed.ciphertext.includes('30006000011234567890'))
    assert.equal(openIban(sealed.ciphertext, sealed.keyVersion, MANDAT, trousseau), 'FR7630006000011234567890189')
  })

  it('refuse un IBAN invalide avant de le chiffrer', () => {
    assert.throws(() => sealIban('FR7630006000011234567890188', MANDAT, trousseau), InvalidIbanError)
  })

  it('ne se relit pas sur un autre mandat, ni dans un autre centre', () => {
    const sealed = sealIban(IBAN_FR, MANDAT, trousseau)
    assert.throws(
      () => openIban(sealed.ciphertext, 1, { ...MANDAT, reference: 'RUM-2026-0002' }, trousseau),
      DocumentIntegrityError,
    )
    assert.throws(
      () =>
        openIban(sealed.ciphertext, 1, { ...MANDAT, tenantId: '01999f00-0000-7000-8000-000000000002' }, trousseau),
      DocumentIntegrityError,
    )
  })

  it('ne s’affiche que masqué', () => {
    assert.equal(maskIban('0189'), '•••• 0189')
  })
})
