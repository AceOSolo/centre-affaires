import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { hasBearerOrQueryToken, hasBearerToken } from './maintenance.ts'

/** Jeton des routes de maintenance et de Dolibarr (ADR 043, ADR 049). */
const JETON = 'a+b/c=='
const requete = (url: string, authorization?: string) =>
  new Request(url, authorization ? { headers: { authorization } } : undefined)

describe('jeton des routes protégées', () => {
  it('accepte l’en-tête Bearer, refuse le reste', () => {
    assert.equal(hasBearerToken(requete('https://x.fr/api', `Bearer ${JETON}`), JETON), true)
    assert.equal(hasBearerToken(requete('https://x.fr/api', 'Bearer autre'), JETON), false)
    assert.equal(hasBearerToken(requete(`https://x.fr/api?jeton=${JETON}`), JETON), false)
  })

  it('accepte aussi le jeton dans l’adresse, « + » collé tel quel compris', () => {
    assert.equal(hasBearerOrQueryToken(requete(`https://x.fr/api?jeton=${JETON}`), JETON), true)
    assert.equal(hasBearerOrQueryToken(requete(`https://x.fr/api?jeton=${encodeURIComponent(JETON)}`), JETON), true)
    assert.equal(hasBearerOrQueryToken(requete('https://x.fr/api', `Bearer ${JETON}`), JETON), true)
    assert.equal(hasBearerOrQueryToken(requete('https://x.fr/api?jeton=faux'), JETON), false)
  })

  it('reste fermé sans jeton configuré', () => {
    assert.equal(hasBearerOrQueryToken(requete('https://x.fr/api?jeton='), undefined), false)
    assert.equal(hasBearerOrQueryToken(requete('https://x.fr/api?jeton='), ''), false)
  })
})
