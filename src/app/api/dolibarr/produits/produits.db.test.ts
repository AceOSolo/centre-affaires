import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test'

import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../../../db/test-support.ts'
import { receiveDolibarrProduct } from './recevoir.ts'

/**
 * Webhook des produits de Dolibarr (ADR 049), tel que la route l'appelle,
 * contre la base de test : ce qui s'écrit répond 200 et demande un
 * rafraîchissement des pages, ce que le site ne peut pas poser répond 400 avec
 * son explication.
 */
describe('webhook des produits Dolibarr, en base', { skip: raisonDeSaut }, () => {
  const JETON = 'jeton-de-test'
  const saved = process.env.DOLIBARR_API_TOKEN
  let bases: TestDatabases
  let journal: string[]

  const appeler = (object: Record<string, unknown>, triggercode = 'PRODUCT_MODIFY') =>
    receiveDolibarrProduct(
      new Request(`http://127.0.0.1:3100/api/dolibarr/produits?jeton=${JETON}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ triggercode, object: { type: '1', status: '1', tva_tx: '20', ...object } }),
      }),
    )

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    process.env.DOLIBARR_API_TOKEN = JETON
    journal = []
    for (const niveau of ['info', 'warn', 'error'] as const) {
      mock.method(console, niveau, (ligne: string) => journal.push(ligne))
    }
    await viderTables(bases.owner, 'offer_items', 'offers', 'services', 'rate_plan_items', 'rate_plans')
  })

  afterEach(() => {
    process.env.DOLIBARR_API_TOKEN = saved
    mock.restoreAll()
  })

  after(async () => {
    delete (globalThis as { database?: unknown }).database
    await bases?.fermer()
  })

  it('crée le service, puis ne change rien au même envoi', async () => {
    const premier = await appeler({ ref: 'courrier.ouverture', label: 'Ouverture', price: '3.5' })
    assert.equal(premier.response.status, 200)
    assert.equal((await premier.response.json()).resultat, 'cree')
    assert.equal(premier.changed, true)

    const second = await appeler({ ref: 'courrier.ouverture', label: 'Ouverture', price: '3.5' })
    assert.equal((await second.response.json()).resultat, 'inchange')
    assert.equal(second.changed, false)

    assert.match(journal[0]!, /PRODUCT_MODIFY « courrier\.ouverture » → 200 cree/)
  })

  it('répond 400, message compris, quand aucune grille par défaut n’accueille le prix', async () => {
    const { response, changed } = await appeler({ ref: 'tarif.salle.journee', price: '130' })
    assert.equal(response.status, 400)
    assert.equal(changed, false)
    assert.match((await response.json()).erreur, /Aucune grille tarifaire par défaut/)
    assert.match(journal[0]!, /→ 400 Aucune grille tarifaire par défaut/)
  })
})
