import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'

import { receiveDolibarrProduct, webhookLogLine } from './recevoir.ts'

/**
 * Webhook des produits de Dolibarr (ADR 049), pour ce qui se décide avant la
 * base : jeton, envoi illisible, produit sans place sur le site. Les écritures
 * sont éprouvées dans `produits.db.test.ts`.
 */
describe('webhook des produits Dolibarr', () => {
  const JETON = 'jeton+de/test='
  const saved = process.env.DOLIBARR_API_TOKEN
  let journal: { niveau: string; ligne: string }[]

  beforeEach(() => {
    process.env.DOLIBARR_API_TOKEN = JETON
    journal = []
    for (const niveau of ['info', 'warn', 'error'] as const) {
      mock.method(console, niveau, (ligne: string) => journal.push({ niveau, ligne }))
    }
  })

  afterEach(() => {
    process.env.DOLIBARR_API_TOKEN = saved
    mock.restoreAll()
  })

  const appeler = (corps: unknown, jeton: string | null = JETON) =>
    receiveDolibarrProduct(
      new Request(
        `http://127.0.0.1:3100/api/dolibarr/produits${jeton === null ? '' : `?jeton=${encodeURIComponent(jeton)}`}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corps) },
      ),
    )

  const service = (object: Record<string, unknown>, triggercode = 'PRODUCT_MODIFY') => ({
    triggercode,
    object: { ref: 'courrier.ouverture', label: 'Ouverture', type: '1', price: '3.5', tva_tx: '20', status: '1', ...object },
  })

  it('n’existe pas sans le jeton, et n’en écrit rien au journal', async () => {
    const { response, changed } = await appeler(service({}), 'jeton-invente-42')
    assert.equal(response.status, 404)
    assert.equal(changed, false)
    assert.equal((await appeler(service({}), null)).response.status, 404)
    assert.equal(journal.length, 2)
    assert.equal(journal[0]!.ligne.replace(/\(\d+ ms\)$/, ''), 'Webhook Dolibarr, produits : → 404 jeton absent ou faux ')
    assert.doesNotMatch(journal[0]!.ligne, /invente|courrier/)
  })

  it('répond 400 avec le message à corriger, que Dolibarr garde', async () => {
    const { response } = await appeler(service({ ref: 'tarif.salle.quinzaine' }))
    assert.equal(response.status, 400)
    assert.match((await response.json()).erreur, /Unité « quinzaine » inconnue/)
  })

  it('refuse une référence trop longue au lieu d’échouer à l’écriture', async () => {
    const { response } = await appeler(service({ ref: 'a'.repeat(101) }))
    assert.equal(response.status, 400)
    assert.match((await response.json()).erreur, /64 caractères au plus/)
  })

  it('refuse un envoi qui n’est pas du JSON', async () => {
    const { response } = await receiveDolibarrProduct(
      new Request(`http://127.0.0.1:3100/api/dolibarr/produits?jeton=${encodeURIComponent(JETON)}`, {
        method: 'POST',
        body: 'triggercode=PRODUCT_MODIFY',
      }),
    )
    assert.equal(response.status, 400)
  })

  it('répond 200 sans rien changer pour un produit physique', async () => {
    const { response, changed } = await appeler(service({ ref: 'ramette', type: '0' }))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).resultat, 'ignore')
    assert.equal(changed, false)
  })

  it('laisse une ligne par appel : déclencheur, référence, code, issue, durée — jamais le jeton', async () => {
    await appeler(service({ ref: 'tarif.salle.quinzaine', description: 'Texte confidentiel' }))
    assert.equal(journal.length, 1)
    const { niveau, ligne } = journal[0]!
    assert.equal(niveau, 'warn')
    assert.match(ligne, /^Webhook Dolibarr, produits : PRODUCT_MODIFY « tarif\.salle\.quinzaine » → 400 Unité « quinzaine » inconnue.* \(\d+ ms\)$/)
    assert.doesNotMatch(ligne, /jeton\+de|confidentiel/)
  })
})

describe('ligne de journal du webhook', () => {
  it('tient sur une ligne quoi que contienne la référence', () => {
    const ligne = webhookLogLine({
      body: { triggercode: 'PRODUCT_MODIFY', object: { ref: 'a\nWebhook Dolibarr, produits : faux\r' } },
      status: 200,
      outcome: 'cree',
      durationMs: 3.4,
    })
    assert.equal(ligne, 'Webhook Dolibarr, produits : PRODUCT_MODIFY « a Webhook Dolibarr, produits : faux » → 200 cree (3 ms)')
  })

  it('coupe une référence trop longue', () => {
    const ligne = webhookLogLine({
      body: { triggercode: 'PRODUCT_MODIFY', object: { ref: 'x'.repeat(500) } },
      status: 400,
      outcome: 'refusé',
      durationMs: 1,
    })
    assert.match(ligne, /« x{100}… »/)
  })

  it('se passe du déclencheur et de la référence quand l’envoi n’en a pas', () => {
    assert.equal(
      webhookLogLine({ body: null, status: 400, outcome: 'Envoi illisible.', durationMs: 0 }),
      'Webhook Dolibarr, produits : → 400 Envoi illisible. (0 ms)',
    )
  })
})
