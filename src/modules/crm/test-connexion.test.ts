import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CrmCallError } from './adresse.ts'
import type { CrmHttp } from './connecteurs.ts'
import type { CrmConnectionView, CrmExchangeEntry, CrmExchangeRow } from './queries.ts'
import { runCrmConnectionTest, type CrmTestInput } from './test-connexion.ts'

/** « Tester la connexion » (ADR 065) : les deux sens, séparément. */
describe('test de connexion au CRM', () => {
  const vue: CrmConnectionView = {
    configured: true,
    connector: 'dolibarr',
    baseUrl: 'https://crm.exemple.fr',
    hasToken: false,
    tokenSetAt: null,
    tokenSetBy: null,
    hasKey: true,
    keySetAt: new Date('2026-11-04T09:00:00Z'),
    enabledFlows: ['quotes', 'products'],
    updatedAt: new Date('2026-11-04T09:00:00Z'),
  }
  const dernierAppel: CrmExchangeRow = {
    id: '0199a3c4-7d2e-7a10-9b1c-3f5e8a2d4c61',
    createdAt: new Date('2026-11-04T09:05:00Z'),
    connector: 'dolibarr',
    direction: 'inbound',
    flow: 'quotes',
    operation: 'GET /api/dolibarr/devis',
    statusCode: 200,
    ok: true,
    message: '0 devis au statut « ready ».',
    credential: 'server',
    durationMs: 12,
  }
  const lancer = async (input: Partial<CrmTestInput>) => {
    const journal: CrmExchangeEntry[] = []
    const lignes = await runCrmConnectionTest({
      view: vue,
      credentials: { baseUrl: 'https://crm.exemple.fr', key: 'cle', unreadable: false },
      lastInbound: dernierAppel,
      serverTokenSet: true,
      timeZone: 'Europe/Paris',
      record: async (entry) => {
        journal.push(entry)
      },
      ...input,
    })
    return { lignes, journal }
  }
  const repondre = (status: number, corps = ''): CrmHttp => async () => ({ status, text: async () => corps })

  it('dit quel jeton ouvre le site et quel est le dernier appel reçu', async () => {
    const { lignes } = await lancer({ http: repondre(200, '{"success":{"dolibarr_version":"20.0.2"}}') })
    assert.equal(lignes[0]!.ok, true)
    assert.match(lignes[0]!.text, /jeton du serveur \(DOLIBARR_API_TOKEN\)/)
    assert.match(lignes[1]!.text, /Dernier appel reçu le 4 nov\. 2026 à 10:05 : GET \/api\/dolibarr\/devis → 200/)
  })

  it('signale l’absence de tout jeton, et l’absence d’appel', async () => {
    const { lignes } = await lancer({ serverTokenSet: false, lastInbound: undefined, credentials: undefined })
    assert.equal(lignes[0]!.ok, false)
    assert.match(lignes[0]!.text, /Aucun jeton/)
    assert.equal(lignes[1]!.ok, null)
    assert.equal(lignes[2]!.ok, null)
    assert.match(lignes[2]!.text, /non éprouvé/)
  })

  it('appelle le CRM quand l’adresse et la clé sont réglées, et l’inscrit au journal', async () => {
    const { lignes, journal } = await lancer({
      view: { ...vue, hasToken: true },
      http: repondre(200, '{"success":{"dolibarr_version":"20.0.2"}}'),
    })
    assert.match(lignes[0]!.text, /jeton réglé ici/)
    assert.deepEqual(lignes[2], { ok: true, text: 'Dolibarr répond et accepte la clé (version 20.0.2).' })
    assert.equal(journal.length, 1)
    assert.equal(journal[0]!.direction, 'outbound')
    assert.equal(journal[0]!.flow, null)
    assert.equal(journal[0]!.credential, null)
    assert.equal(journal[0]!.statusCode, 200)
  })

  it('rapporte un appel refusé par la garde, sans code', async () => {
    const { lignes, journal } = await lancer({
      http: async () => {
        throw new CrmCallError('« crm.exemple.fr » mène à une adresse privée : appel refusé.')
      },
    })
    assert.equal(lignes[2]!.ok, false)
    assert.match(lignes[2]!.text, /adresse privée/)
    assert.equal(journal[0]!.statusCode, null)
    assert.equal(journal[0]!.ok, false)
  })

  it('demande de ressaisir une clé illisible, sans appeler', async () => {
    let appels = 0
    const { lignes, journal } = await lancer({
      credentials: { baseUrl: 'https://crm.exemple.fr', key: null, unreadable: true },
      http: async () => {
        appels++
        return { status: 200, text: async () => '' }
      },
    })
    assert.match(lignes[2]!.text, /illisible.*ressaisissez/)
    assert.equal(appels, 0)
    assert.deepEqual(journal, [])
  })
})
