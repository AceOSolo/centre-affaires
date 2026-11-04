import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'

import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../../db/tenants.ts'
import { uuidv7 } from '../../../lib/uuid.ts'
import { toutVider } from '../../../modules/clients/test-support.ts'
import { saveCrmFlows } from '../../../modules/crm/queries.ts'
import { POST as transmis } from './consommations/[id]/transmis/route.ts'
import { GET as consommations } from './consommations/route.ts'
import { listContrats, receiveContrat } from './contrats/recevoir.ts'
import { listTiers, receiveTiers } from './tiers/recevoir.ts'

/**
 * La seconde tranche de l'API Dolibarr (ADR 066), routes telles que Next les
 * appelle, contre la base de test :
 *
 * - sans jeton valide, les routes n'existent pas (404) ;
 * - chaque flux naît coupé : 403, avec le message qui dit où l'ouvrir ;
 * - ouverts à l'écran, tiers, contrats et consommations répondent dans leur
 *   format, et chaque appel va au journal du centre ;
 * - un envoi illisible est refusé (400) avec ce qu'il faut corriger.
 */
describe('API Dolibarr : tiers, contrats, consommations', { skip: raisonDeSaut }, () => {
  const JETON = 'jeton+du/serveur=lot10'
  const saved = process.env.DOLIBARR_API_TOKEN
  let bases: TestDatabases
  let direction: string

  const brut = async <T>(requete: string, params: unknown[] = []) =>
    ((await bases.owner.client.query(requete, params)) as unknown as [T[]])[0]

  const appel = (chemin: string, options: { method?: string; body?: unknown; jeton?: string | null } = {}) =>
    new Request(`http://127.0.0.1:3100${chemin}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.jeton === null ? {} : { authorization: `Bearer ${options.jeton ?? JETON}` }),
        'content-type': 'application/json',
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })

  const tiers = {
    dolibarrId: '412',
    statut: 'client',
    nom: 'Atelier Martin',
    siret: '12345678900012',
  }
  const contrat = {
    dolibarrId: '57',
    reference: 'CT2611-0003',
    tiersDolibarrId: '412',
    type: 'domiciliation',
    statut: 'en_cours',
    debut: '2026-11-01',
    prix: { montantHtCentimes: 3000, periodicite: 'mensuel' },
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    process.env.DOLIBARR_API_TOKEN = JETON
    await toutVider(bases.owner)
    direction = uuidv7()
    await bases.owner.client.query(
      `insert into staff_members (id, tenant_id, email, role) values (?, ?, 'direction@exemple.fr', 'super_admin')`,
      [direction, DEFAULT_TENANT_ID],
    )
  })

  afterEach(() => {
    process.env.DOLIBARR_API_TOKEN = saved
  })

  after(async () => {
    await viderTables(bases.owner, 'crm_exchanges', 'crm_connections', 'staff_members')
    await toutVider(bases.owner)
    delete (globalThis as { database?: unknown }).database
    await bases?.fermer()
  })

  it('n’existe pas sans jeton valide', async () => {
    assert.equal((await receiveTiers(appel('/api/dolibarr/tiers', { method: 'POST', body: tiers, jeton: null }))).response.status, 404)
    assert.equal((await consommations(appel('/api/dolibarr/consommations', { jeton: 'faux' }))).status, 404)
    assert.deepEqual(await brut('select id from crm_exchanges'), [])
  })

  it('chaque flux naît coupé, et le refus dit où l’ouvrir', async () => {
    const reponses = [
      (await receiveTiers(appel('/api/dolibarr/tiers', { method: 'POST', body: tiers }))).response,
      await listTiers(appel('/api/dolibarr/tiers')),
      (await receiveContrat(appel('/api/dolibarr/contrats', { method: 'POST', body: contrat }))).response,
      await listContrats(appel('/api/dolibarr/contrats')),
      await consommations(appel('/api/dolibarr/consommations')),
      await transmis(appel(`/api/dolibarr/consommations/${uuidv7()}/transmis`, { method: 'POST', body: { dolibarrId: '1' } }), {
        params: Promise.resolve({ id: uuidv7() }),
      }),
    ]
    assert.deepEqual(reponses.map((r) => r.status), [403, 403, 403, 403, 403, 403])
    assert.match(((await reponses[0]!.json()) as { erreur: string }).erreur, /Flux « Tiers » désactivé.*Connexion au CRM/)
    assert.deepEqual(await brut('select id from clients'), [])
    const journal = await brut<{ flow: string; status_code: number }>('select flow, status_code from crm_exchanges order by created_at, id')
    assert.deepEqual(
      journal.map((ligne) => [ligne.flow, ligne.status_code]),
      [
        ['third_parties', 403],
        ['third_parties', 403],
        ['contracts', 403],
        ['contracts', 403],
        ['consumptions', 403],
        ['consumptions', 403],
      ],
    )
  })

  it('ouverts à l’écran, répondent dans leur format et vont au journal', async () => {
    await saveCrmFlows(['quotes', 'products', 'third_parties', 'contracts', 'consumptions'], direction, '2026-01-01')

    const recu = await receiveTiers(appel('/api/dolibarr/tiers', { method: 'POST', body: tiers }))
    assert.equal(recu.response.status, 200)
    assert.equal(recu.changed, true)
    const corps = (await recu.response.json()) as { ok: boolean; resultat: string; clientId: string; avertissements: string[] }
    assert.deepEqual([corps.ok, corps.resultat, corps.avertissements], [true, 'cree', []])

    const liste = (await (await listTiers(appel('/api/dolibarr/tiers?rapproche=oui'))).json()) as { tiers: { clientId: string; dolibarrId: string }[] }
    assert.deepEqual(liste.tiers.map((t) => [t.clientId, t.dolibarrId]), [[corps.clientId, '412']])

    const contratRecu = await receiveContrat(appel('/api/dolibarr/contrats', { method: 'POST', body: contrat }))
    assert.equal(contratRecu.response.status, 200)
    assert.equal(((await contratRecu.response.json()) as { resultat: string }).resultat, 'cree')

    const conso = await consommations(appel('/api/dolibarr/consommations'))
    assert.equal(conso.status, 200)
    assert.deepEqual(await conso.json(), { consommations: [], depuisLe: '2026-01-01', enAttente: { reexpeditionsSansFrais: 0 } })

    const inconnue = uuidv7()
    const ack = await transmis(appel(`/api/dolibarr/consommations/${inconnue}/transmis`, { method: 'POST', body: { dolibarrId: '1834' } }), {
      params: Promise.resolve({ id: inconnue }),
    })
    assert.equal(ack.status, 404)

    const journal = await brut<{ operation: string; status_code: number; message: string | null }>(
      `select operation, status_code, message from crm_exchanges where flow <> 'quotes' order by created_at, id`,
    )
    assert.deepEqual(
      journal.map((ligne) => [ligne.operation, ligne.status_code]),
      [
        ['POST /api/dolibarr/tiers', 200],
        ['GET /api/dolibarr/tiers', 200],
        ['POST /api/dolibarr/contrats', 200],
        ['GET /api/dolibarr/consommations', 200],
        ['POST /api/dolibarr/consommations/{id}/transmis', 404],
      ],
    )
    // Le journal ne porte ni raison sociale ni corps reçu.
    assert.ok(journal.every((ligne) => !ligne.message?.includes('Atelier')))
  })

  it('refuse un envoi illisible, et dit quoi corriger', async () => {
    await saveCrmFlows(['third_parties', 'contracts', 'consumptions'], direction, '2026-01-01')
    const sansNom = await receiveTiers(appel('/api/dolibarr/tiers', { method: 'POST', body: { dolibarrId: '1', statut: 'client' } }))
    assert.equal(sansNom.response.status, 400)
    assert.match(((await sansNom.response.json()) as { erreur: string }).erreur, /nom/)
    const sansPrix = await receiveContrat(appel('/api/dolibarr/contrats', { method: 'POST', body: { ...contrat, prix: undefined } }))
    assert.equal(sansPrix.response.status, 400)
    assert.equal((await consommations(appel('/api/dolibarr/consommations?statut=paid'))).status, 400)
    assert.equal((await consommations(appel('/api/dolibarr/consommations?depuis=hier'))).status, 400)
    assert.equal((await listTiers(appel('/api/dolibarr/tiers?rapproche=peut-etre'))).status, 400)
    const id = uuidv7()
    assert.equal(
      (await transmis(appel(`/api/dolibarr/consommations/${id}/transmis`, { method: 'POST', body: {} }), { params: Promise.resolve({ id }) })).status,
      400,
    )
  })
})
