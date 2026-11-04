import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { crmConnectors } from './catalogue.ts'
import { crmConnectorIds, type CrmHttp } from './connecteurs.ts'
import { dolibarrVersion } from './dolibarr.ts'
import { crmFlowDefinitions, crmFlows, defaultEnabledFlows, readEnabledFlows } from './flux.ts'

/** Le catalogue des CRM et de leurs flux (ADR 065). */
describe('catalogue des connecteurs', () => {
  it('a un connecteur par identifiant, Dolibarr d’abord', () => {
    assert.deepEqual(Object.keys(crmConnectors), [...crmConnectorIds])
    assert.equal(crmConnectorIds[0], 'dolibarr')
    for (const id of crmConnectorIds) assert.equal(crmConnectors[id].id, id)
  })

  it('ne sert que des flux du catalogue, et décrit les routes de chacun', () => {
    for (const connector of Object.values(crmConnectors)) {
      for (const flow of connector.flows) {
        assert.ok(crmFlows.includes(flow), flow)
        assert.ok((connector.routes[flow] ?? []).length > 0, `${connector.id} : ${flow} sans route`)
      }
      for (const flow of Object.keys(connector.routes)) {
        assert.ok(connector.flows.includes(flow as never), `${connector.id} : route d’un flux non servi`)
      }
    }
  })

  it('ouvre par défaut ce qui tournait avant l’écran ; la seconde tranche est servie, mais naît coupée', () => {
    assert.deepEqual(defaultEnabledFlows, ['quotes', 'products'])
    // ADR 066 : Dolibarr sert les trois flux ; la direction les ouvre à
    // l'écran, une fois le connecteur prêt.
    for (const flow of ['third_parties', 'contracts', 'consumptions'] as const) {
      assert.equal(crmFlowDefinitions[flow].enabledByDefault, false)
      assert.equal(crmConnectors.dolibarr.flows.includes(flow), true, `${flow} pas servi`)
      assert.ok((crmConnectors.dolibarr.routes[flow] ?? []).length > 0, `${flow} sans route`)
    }
  })

  it('relit les flux enregistrés dans l’ordre du catalogue, en ignorant l’inconnu', () => {
    assert.deepEqual(readEnabledFlows(undefined), ['quotes', 'products'])
    assert.deepEqual(readEnabledFlows(['products', 'inconnu', 'quotes']), ['quotes', 'products'])
    assert.deepEqual(readEnabledFlows([]), [])
    assert.deepEqual(readEnabledFlows('quotes'), ['quotes', 'products'])
  })
})

describe('Dolibarr : test de connexion', () => {
  const dolibarr = crmConnectors.dolibarr
  const appels: { url: string; headers: Record<string, string> }[] = []
  const repondre =
    (status: number, corps = ''): CrmHttp =>
    async (url, headers) => {
      appels.push({ url, headers })
      return { status, text: async () => corps }
    }
  const tester = (http: CrmHttp) => dolibarr.testConnection({ baseUrl: 'https://crm.exemple.fr', key: 'cle-api' }, http)

  it('appelle /status avec la clé en en-tête DOLAPIKEY', async () => {
    appels.length = 0
    const issue = await tester(
      repondre(200, '{"success":{"code":200,"dolibarr_version":"20.0.2","access_locked":"0"}}'),
    )
    assert.deepEqual(issue, { ok: true, statusCode: 200, message: 'Dolibarr répond et accepte la clé (version 20.0.2).' })
    assert.equal(appels[0]!.url, 'https://crm.exemple.fr/api/index.php/status')
    assert.equal(appels[0]!.headers.DOLAPIKEY, 'cle-api')
  })

  it('dit quoi corriger : clé refusée, pas d’API, redirection, réponse d’autre chose', async () => {
    assert.match((await tester(repondre(401))).message, /refuse la clé \(401\)/)
    assert.match((await tester(repondre(403))).message, /refuse la clé \(403\)/)
    assert.match((await tester(repondre(404))).message, /module « API REST »/)
    assert.match((await tester(repondre(302))).message, /redirige ailleurs \(302\)/)
    assert.match((await tester(repondre(500))).message, /inattendue de Dolibarr \(500\)/)
    const autre = await tester(repondre(200, '<html>Bienvenue</html>'))
    assert.equal(autre.ok, false)
    assert.match(autre.message, /pas comme l’API de Dolibarr/)
  })

  it('ne recopie de la réponse qu’une version lisible', () => {
    assert.equal(dolibarrVersion('{"success":{"dolibarr_version":"19.0.3"}}'), '19.0.3')
    assert.equal(dolibarrVersion('{"success":{"dolibarr_version":20}}'), '20')
    assert.equal(dolibarrVersion('{"success":{"dolibarr_version":"<script>"}}'), undefined)
    assert.equal(dolibarrVersion('{"success":{}}'), undefined)
    assert.equal(dolibarrVersion('pas du json'), undefined)
  })
})
