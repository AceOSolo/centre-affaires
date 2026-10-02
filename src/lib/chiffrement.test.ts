import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'

import { openSecret, parseKey, sealSecret } from './chiffrement.ts'

const key = randomBytes(32)

describe('chiffrement des secrets', () => {
  it('rend le secret d’origine', () => {
    const sealed = sealSecret('1//0g-jeton-de-rafraichissement', key)
    assert.equal(openSecret(sealed, key), '1//0g-jeton-de-rafraichissement')
    assert.ok(!sealed.includes('jeton'))
  })

  it('ne produit jamais deux fois le même chiffré', () => {
    assert.notEqual(sealSecret('même secret', key), sealSecret('même secret', key))
  })

  it('refuse un chiffré altéré plutôt que de rendre un faux secret', () => {
    const [version, iv, tag, encrypted] = sealSecret('secret', key).split(':')
    const flipped = Buffer.from(encrypted, 'base64url')
    flipped[0] ^= 1
    assert.throws(() => openSecret([version, iv, tag, flipped.toString('base64url')].join(':'), key))
  })

  it('refuse la clé d’un autre environnement', () => {
    assert.throws(() => openSecret(sealSecret('secret', key), randomBytes(32)))
  })

  it('exige une clé de 32 octets', () => {
    assert.equal(parseKey(key.toString('base64')).length, 32)
    assert.throws(() => parseKey(undefined))
    assert.throws(() => parseKey(randomBytes(16).toString('base64')))
  })
})
