import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { guardedRequest, type CrmRequest } from './adresse.ts'
import { DolibarrApiError, dolibarrClient } from './dolibarr-api.ts'

/**
 * Le client de l'API REST de Dolibarr (ADR 073) : ce qu'il demande, ce qu'il
 * comprend des réponses, et ce qu'il refuse d'envoyer.
 */

type Seen = { url: string; method: string; headers: Record<string, string>; json?: unknown }

function scripted(replies: Record<string, { status: number; body?: unknown }>) {
  const seen: Seen[] = []
  const request: CrmRequest = async ({ url, method, headers, json }) => {
    seen.push({ url, method, headers, json })
    const key = Object.keys(replies).find((pattern) => `${method} ${url}`.includes(pattern))
    const reply = (key && replies[key]) || { status: 500, body: 'rien de prévu' }
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? null)
    return { status: reply.status, text: async () => text }
  }
  return { seen, client: dolibarrClient({ baseUrl: 'https://crm.exemple.fr', key: 'cle-secrete', request }) }
}

describe('client Dolibarr', () => {
  it('envoie la clé dans DOLAPIKEY et passe par /api/index.php', async () => {
    const { seen, client } = scripted({ '/products/ref/': { status: 200, body: { id: '14221', ref: 'tarif.salle.heure' } } })
    assert.equal(await client.findProductId('tarif.salle.heure'), '14221')
    assert.equal(seen[0]!.url, 'https://crm.exemple.fr/api/index.php/products/ref/tarif.salle.heure')
    assert.equal(seen[0]!.headers.DOLAPIKEY, 'cle-secrete')
  })

  it('un 404 sur une recherche veut dire « rien trouvé », pas une panne', async () => {
    const { client } = scripted({
      '/products/ref/': { status: 404, body: { error: { code: 404, message: 'Not Found: Product not found' } } },
      '/thirdparties': { status: 404, body: { error: { code: 404, message: 'Not Found: No thirdparties found' } } },
      '/proposals': { status: 404, body: { error: { code: 404 } } },
    })
    assert.equal(await client.findProductId('tarif.salle.inconnu'), undefined)
    assert.equal(await client.findThirdparty({ siret: '12345678900012' }), undefined)
    assert.equal(await client.findProposalByClientRef('DV-2026-0001'), undefined)
  })

  it('cherche le tiers par SIRET, puis SIREN, puis adresse, et s’arrête au premier trouvé', async () => {
    const { seen, client } = scripted({
      't.siret': { status: 404 },
      't.siren': { status: 200, body: [{ id: '1173', name: 'Martin SAS' }] },
    })
    assert.equal(await client.findThirdparty({ siret: '12345678900012', siren: '123456789', email: 'a@b.fr' }), '1173')
    assert.equal(seen.length, 2)
    assert.match(decodeURIComponent(seen[0]!.url), /sqlfilters=\(t\.siret:=:'12345678900012'\)/)
    assert.match(decodeURIComponent(seen[1]!.url), /sqlfilters=\(t\.siren:=:'123456789'\)/)
  })

  it('ne met jamais dans un filtre une valeur qui pourrait en sortir', async () => {
    const { seen, client } = scripted({})
    assert.equal(await client.findThirdparty({ email: "x') or (1=1" }), undefined)
    assert.equal(await client.findContact('5', "a'b@c.fr"), undefined)
    assert.equal(await client.findProposalByClientRef("DV'--"), undefined)
    assert.equal(seen.length, 0)
  })

  it('cherche le contact parmi ceux du tiers', async () => {
    const { seen, client } = scripted({ '/contacts': { status: 200, body: [{ id: 55953 }] } })
    assert.equal(await client.findContact('1173', 'Claire@Exemple.fr'), '55953')
    const url = decodeURIComponent(seen[0]!.url)
    assert.match(url, /thirdparty_ids=1173/)
    assert.match(url, /\(t\.email:=:'claire@exemple\.fr'\)/)
  })

  it('retrouve une proposition par sa référence client', async () => {
    const { client } = scripted({ '/proposals': { status: 200, body: [{ id: '77', ref: 'PR2611-0003' }] } })
    assert.deepEqual(await client.findProposalByClientRef('DV-2026-0001'), { id: '77', ref: 'PR2611-0003' })
  })

  it('lit l’identifiant rendu à la création, nu ou entre guillemets', async () => {
    const nu = scripted({ 'POST https://crm.exemple.fr/api/index.php/proposals': { status: 200, body: 412 } })
    assert.equal(await nu.client.createProposal({ socid: '1' }), '412')
    assert.deepEqual(nu.seen[0]!.json, { socid: '1' })
    const texte = scripted({ '/thirdparties': { status: 200, body: '1173' } })
    assert.equal(await texte.client.createThirdparty({ name: 'X' }), '1173')
  })

  it('refuse une création qui ne rend pas d’identifiant', async () => {
    const { client } = scripted({ '/proposals': { status: 200, body: { warning: 'rien' } } })
    await assert.rejects(client.createProposal({}), /n’a pas rendu l’identifiant de la proposition/)
  })

  it('rattache le contact comme interlocuteur CUSTOMER', async () => {
    const { seen, client } = scripted({ '/contact/': { status: 200, body: { success: true } } })
    await client.linkProposalContact('412', '55953')
    assert.equal(seen[0]!.method, 'POST')
    assert.equal(seen[0]!.url, 'https://crm.exemple.fr/api/index.php/proposals/412/contact/55953/CUSTOMER')
  })

  it('lit la référence que Dolibarr a donnée à la proposition', async () => {
    const { client } = scripted({ '/proposals/412': { status: 200, body: { id: '412', ref: '(PROV412)' } } })
    assert.equal(await client.proposalRef('412'), '(PROV412)')
  })

  it('dit quelle étape a échoué, avec le message de Dolibarr', async () => {
    const { client } = scripted({
      '/proposals': { status: 400, body: { error: { code: 400, message: 'Bad Request: Field options_typage_devis is mandatory' } } },
    })
    await assert.rejects(client.createProposal({}), (error: unknown) => {
      assert.ok(error instanceof DolibarrApiError)
      assert.equal(error.status, 400)
      assert.match(error.message, /^Création de la proposition : réponse 400 de Dolibarr — Bad Request: Field options_typage_devis is mandatory\.$/)
      return true
    })
  })

  it('une clé refusée est dite en toutes lettres', async () => {
    const { client } = scripted({ '/proposals': { status: 401, body: { error: { code: 401 } } } })
    await assert.rejects(client.createProposal({}), /Dolibarr refuse la clé \(401\)/)
  })

  it('une page d’erreur du frontal ne casse pas la lecture', async () => {
    const { client } = scripted({ '/proposals': { status: 502, body: '<html>Bad gateway</html>' } })
    await assert.rejects(client.createProposal({}), /réponse 502 de Dolibarr — <html>Bad gateway<\/html>/)
  })
})

describe('appel sortant qui écrit', () => {
  const reponse = (status: number, corps = '') => new Response(corps, { status })

  it('envoie le corps en JSON, sans suivre de redirection', async () => {
    const vus: { url: string; init: RequestInit }[] = []
    const request = guardedRequest({
      resolve: async () => ['93.184.216.34'],
      fetchImpl: (async (url: URL, init: RequestInit) => {
        vus.push({ url: String(url), init })
        return reponse(200, '412')
      }) as unknown as typeof fetch,
    })
    const rendu = await request({
      url: 'https://crm.exemple.fr/api/index.php/proposals',
      method: 'POST',
      headers: { DOLAPIKEY: 'cle' },
      json: { socid: '1' },
    })
    assert.equal(await rendu.text(), '412')
    assert.equal(vus[0]!.init.method, 'POST')
    assert.equal(vus[0]!.init.redirect, 'manual')
    assert.equal(vus[0]!.init.body, '{"socid":"1"}')
    assert.deepEqual(vus[0]!.init.headers, { DOLAPIKEY: 'cle', 'content-type': 'application/json' })
  })

  it('garde la même garde que la lecture : https, adresse publique', async () => {
    const request = guardedRequest({ resolve: async () => ['10.0.0.5'], fetchImpl: (async () => reponse(200)) as typeof fetch })
    await assert.rejects(request({ url: 'http://crm.exemple.fr', method: 'POST', headers: {}, json: {} }), /https seulement/)
    await assert.rejects(request({ url: 'https://127.0.0.1', method: 'POST', headers: {}, json: {} }), /locale ou privée/)
    await assert.rejects(request({ url: 'https://crm.exemple.fr', method: 'POST', headers: {}, json: {} }), /adresse privée/)
  })

  it('lit jusqu’à 64 Kio de réponse', async () => {
    const request = guardedRequest({
      resolve: async () => ['93.184.216.34'],
      fetchImpl: (async () => reponse(200, 'x'.repeat(100_000))) as typeof fetch,
    })
    const texte = await (await request({ url: 'https://crm.exemple.fr', method: 'GET', headers: {} })).text()
    assert.equal(texte.length, 64 * 1024)
  })
})
