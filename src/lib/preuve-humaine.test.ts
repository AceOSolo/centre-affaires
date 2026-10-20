import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { solveChallenge, type Challenge } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2'

import { creerPreuveHumaine } from './preuve-humaine.ts'

/** Réglage minuscule : on vérifie la règle, pas la difficulté. */
const REGLAGES = { secret: 'secret-de-test', cout: 10, tentatives: [1, 20], validiteMinutes: 30 } as const

/** Ce que le widget envoie : le défi et sa solution, en JSON encodé en base 64. */
async function resoudre(challenge: Challenge): Promise<string> {
  const solution = await solveChallenge({ challenge, deriveKey })
  assert.ok(solution)
  return btoa(JSON.stringify({ challenge, solution }))
}

describe('preuve humaine (ALTCHA)', () => {
  it('accepte un défi résolu', async () => {
    const preuve = creerPreuveHumaine(REGLAGES)
    assert.equal(await preuve.verifier(await resoudre(await preuve.defi())), true)
  })

  it('refuse une réponse déjà servie', async () => {
    const preuve = creerPreuveHumaine(REGLAGES)
    const reponse = await resoudre(await preuve.defi())
    assert.equal(await preuve.verifier(reponse), true)
    assert.equal(await preuve.verifier(reponse), false)
  })

  it('refuse un défi signé par un autre serveur', async () => {
    const ailleurs = creerPreuveHumaine({ ...REGLAGES, secret: 'autre-secret' })
    const preuve = creerPreuveHumaine(REGLAGES)
    assert.equal(await preuve.verifier(await resoudre(await ailleurs.defi())), false)
  })

  it('refuse un défi expiré', async () => {
    const preuve = creerPreuveHumaine({ ...REGLAGES, validiteMinutes: -1 })
    assert.equal(await preuve.verifier(await resoudre(await preuve.defi())), false)
  })

  it('ne laisse pas une réponse forgée consommer le défi d’une vraie', async () => {
    const preuve = creerPreuveHumaine(REGLAGES)
    const defi = await preuve.defi()
    const forgee = btoa(JSON.stringify({ challenge: { ...defi, signature: 'f'.repeat(64) }, solution: { counter: 1, derivedKey: '00' } }))
    assert.equal(await preuve.verifier(forgee), false)
    assert.equal(await preuve.verifier(await resoudre(defi)), true)
  })

  it('garde en mémoire une réponse servie malgré un flot de réponses forgées', async () => {
    const preuve = creerPreuveHumaine(REGLAGES)
    const reponse = await resoudre(await preuve.defi())
    assert.equal(await preuve.verifier(reponse), true)
    // Plus de réponses forgées que la mémoire n'en tient (10 000), chacune
    // avec son propre aléa : aucune n'y entre, la vraie n'en sort pas.
    for (let i = 0; i < 10_001; i++) {
      const parameters = { algorithm: 'PBKDF2/SHA-256', nonce: i.toString(16).padStart(32, '0'), salt: '00', cost: 1, keyLength: 32, keyPrefix: '00' }
      await preuve.verifier(btoa(JSON.stringify({ challenge: { parameters, signature: 'f'.repeat(64) }, solution: { counter: 0, derivedKey: '00' } })))
    }
    assert.equal(await preuve.verifier(reponse), false)
  })

  it('refuse une réponse au format d’un service ALTCHA hébergé', async () => {
    const preuve = creerPreuveHumaine(REGLAGES)
    const reponse = btoa(JSON.stringify({ algorithm: 'SHA-256', signature: 'f'.repeat(64), verificationData: 'verified=true', verified: true }))
    assert.equal(await preuve.verifier(reponse), false)
  })

  it('refuse une réponse absente ou illisible', async () => {
    const preuve = creerPreuveHumaine(REGLAGES)
    assert.equal(await preuve.verifier(null), false)
    assert.equal(await preuve.verifier(''), false)
    assert.equal(await preuve.verifier('pas du base64 !'), false)
    assert.equal(await preuve.verifier(btoa('{"challenge":{}}')), false)
  })
})
