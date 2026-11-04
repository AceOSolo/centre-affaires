import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { crmTokenHash, generateCrmToken, presentedTokens, sameHash, sameSecret } from './jeton.ts'

/** Jeton que le CRM présente au site (ADR 065). */
describe('jeton du CRM', () => {
  it('se tire au hasard, passe tel quel dans une adresse, ne se répète pas', () => {
    const jetons = new Set(Array.from({ length: 50 }, generateCrmToken))
    assert.equal(jetons.size, 50)
    for (const jeton of jetons) {
      assert.match(jeton, /^crm_[A-Za-z0-9_-]{43}$/)
      assert.equal(encodeURIComponent(jeton), jeton)
    }
  })

  it('n’est gardé que par son empreinte SHA-256', () => {
    const jeton = generateCrmToken()
    const empreinte = crmTokenHash(jeton)
    assert.match(empreinte, /^[0-9a-f]{64}$/)
    assert.equal(crmTokenHash(jeton), empreinte)
    assert.notEqual(crmTokenHash(`${jeton}x`), empreinte)
    assert.doesNotMatch(empreinte, new RegExp(jeton.slice(4, 12)))
  })

  it('compare à temps constant, longueurs différentes comprises', () => {
    assert.equal(sameSecret('a+b/c==', 'a+b/c=='), true)
    assert.equal(sameSecret('a+b/c=', 'a+b/c=='), false)
    assert.equal(sameSecret('', ''), false)
    assert.equal(sameSecret('x', ''), false)
    const empreinte = crmTokenHash('jeton')
    assert.equal(sameHash(empreinte, empreinte), true)
    assert.equal(sameHash(empreinte, crmTokenHash('autre')), false)
    assert.equal(sameHash('zz', empreinte), false)
  })

  describe('lu dans la requête comme avant l’écran', () => {
    const requete = (url: string, authorization?: string) =>
      new Request(url, authorization ? { headers: { authorization } } : undefined)

    it('prend l’en-tête Bearer, et l’en-tête nu comme l’ancienne lecture', () => {
      assert.deepEqual(presentedTokens(requete('https://x.fr/api', 'Bearer abc')), ['abc'])
      assert.deepEqual(presentedTokens(requete('https://x.fr/api', 'abc')), ['abc'])
      assert.deepEqual(presentedTokens(requete('https://x.fr/api')), [])
    })

    it('ne lit l’adresse que pour les routes qui l’admettent', () => {
      assert.deepEqual(presentedTokens(requete('https://x.fr/api?jeton=abc')), [])
      assert.deepEqual(presentedTokens(requete('https://x.fr/api?jeton=abc'), true), ['abc'])
    })

    it('rend le « + » d’un jeton collé tel quel dans l’adresse', () => {
      assert.deepEqual(presentedTokens(requete('https://x.fr/api?jeton=a+b/c=='), true), ['a+b/c=='])
      assert.deepEqual(presentedTokens(requete(`https://x.fr/api?jeton=${encodeURIComponent('a+b/c==')}`), true), [
        'a+b/c==',
      ])
    })

    it('essaie l’en-tête puis l’adresse, sans doublon', () => {
      assert.deepEqual(presentedTokens(requete('https://x.fr/api?jeton=bon', 'Bearer faux'), true), ['faux', 'bon'])
      assert.deepEqual(presentedTokens(requete('https://x.fr/api?jeton=bon', 'Bearer bon'), true), ['bon'])
    })
  })
})
