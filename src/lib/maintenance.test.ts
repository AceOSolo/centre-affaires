import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { hasBearerToken } from './maintenance.ts'

/** Jeton des routes de maintenance. Celui de Dolibarr : `modules/crm/jeton.test.ts` (ADR 065). */
const JETON = 'a+b/c=='
const requete = (url: string, authorization?: string) =>
  new Request(url, authorization ? { headers: { authorization } } : undefined)

describe('jeton des routes protégées', () => {
  it('accepte l’en-tête Bearer, refuse le reste', () => {
    assert.equal(hasBearerToken(requete('https://x.fr/api', `Bearer ${JETON}`), JETON), true)
    assert.equal(hasBearerToken(requete('https://x.fr/api', 'Bearer autre'), JETON), false)
    assert.equal(hasBearerToken(requete(`https://x.fr/api?jeton=${JETON}`), JETON), false)
  })

  it('reste fermé sans jeton configuré', () => {
    assert.equal(hasBearerToken(requete('https://x.fr/api', 'Bearer '), undefined), false)
    assert.equal(hasBearerToken(requete('https://x.fr/api', 'Bearer '), ''), false)
  })
})
