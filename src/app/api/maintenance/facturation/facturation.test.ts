import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { POST } from './route.ts'

/**
 * Le lot planifié est arrêté (ADR 046) : la tâche du 1er du mois, si elle
 * tourne encore, ne prépare plus aucune facture.
 */
describe('lot de facturation planifié, arrêté', () => {
  const saved = process.env.MAINTENANCE_TOKEN
  afterEach(() => {
    process.env.MAINTENANCE_TOKEN = saved
  })

  const appeler = (authorization?: string) =>
    POST(
      new Request('http://127.0.0.1:3000/api/maintenance/facturation', {
        method: 'POST',
        headers: authorization ? { authorization } : {},
      }),
    )

  it('répond 410 avec le jeton, sans rien préparer', async () => {
    process.env.MAINTENANCE_TOKEN = 'jeton-de-test'
    const response = await appeler('Bearer jeton-de-test')
    assert.equal(response.status, 410)
    assert.match((await response.json()).error, /Dolibarr/)
  })

  it('reste introuvable sans jeton', async () => {
    process.env.MAINTENANCE_TOKEN = 'jeton-de-test'
    assert.equal((await appeler()).status, 404)
  })
})
