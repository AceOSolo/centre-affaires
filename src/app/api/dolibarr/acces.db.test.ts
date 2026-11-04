import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test'

import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../../db/tenants.ts'
import { runForTenant } from '../../../lib/tenant.ts'
import { uuidv7 } from '../../../lib/uuid.ts'
import { crmTokenHash } from '../../../modules/crm/jeton.ts'
import { removeCrmToken, saveCrmFlows, setCrmToken } from '../../../modules/crm/queries.ts'
import { GET as listeDesDevis } from './devis/route.ts'
import { receiveDolibarrProduct } from './produits/recevoir.ts'

/**
 * L'API de Dolibarr et ses jetons (ADR 065), routes telles que Next les
 * appelle, contre la base de test :
 *
 * - l'ancien jeton (`DOLIBARR_API_TOKEN`) vaut tant que rien n'est réglé à
 *   l'écran : la production ne voit rien changer ;
 * - le jeton réglé à l'écran ouvre l'API pour son centre, et ferme l'ancien ;
 * - le jeton d'un autre centre est servi pour cet autre centre seulement ;
 * - sans jeton, ou avec un jeton faux, les routes n'existent pas (404) ;
 * - un flux coupé est refusé, et chaque appel au jeton valide va au journal
 *   de son centre.
 *
 * `/transmis` et `/issue` importent `next/cache`, que Node ne charge pas hors
 * de Next : ils passent par la même porte (`serveCrmCall`), éprouvée seule
 * dans `modules/crm/appels.test.ts`.
 */
describe('API Dolibarr : jetons et centres', { skip: raisonDeSaut }, () => {
  const ANCIEN = 'ancien+jeton/du=serveur'
  const NOUVEAU = 'crm_nouveau-jeton-du-centre-unique'
  const LYON = 'crm_jeton-du-centre-de-lyon'
  const AUTRE = '01999f00-0000-7000-8000-0000000000d4'
  const saved = process.env.DOLIBARR_API_TOKEN
  let bases: TestDatabases
  let direction: string
  let directionLyon: string

  const brut = async <T>(requete: string, params: unknown[] = []) =>
    ((await bases.owner.client.query(requete, params)) as unknown as [T[]])[0]

  const devis = (jeton?: string) =>
    listeDesDevis(
      new Request('http://127.0.0.1:3100/api/dolibarr/devis', jeton ? { headers: { authorization: `Bearer ${jeton}` } } : {}),
    )
  const produit = (jeton: string, ref = 'courrier.ouverture') =>
    receiveDolibarrProduct(
      new Request(`http://127.0.0.1:3100/api/dolibarr/produits?jeton=${encodeURIComponent(jeton)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          triggercode: 'PRODUCT_MODIFY',
          object: { ref, label: 'Ouverture', type: '1', status: '1', price: '3.5', tva_tx: '20' },
        }),
      }),
    )
  const journal = (tenantId: string) =>
    brut<{ operation: string; status_code: number; ok: number; credential: string; message: string | null }>(
      'select operation, status_code, ok, credential, message from crm_exchanges where tenant_id = ? order by created_at, id',
      [tenantId],
    )

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
    await bases.owner.client.query(
      `insert into tenants (id, name, slug) values (?, 'Centre de Lyon', 'centre-de-lyon-api') on duplicate key update id = id`,
      [AUTRE],
    )
    direction = uuidv7()
    directionLyon = uuidv7()
    await bases.owner.client.query(
      `insert into staff_members (id, tenant_id, email, role) values (?, ?, 'direction@exemple.fr', 'super_admin'), (?, ?, 'direction@lyon.exemple.fr', 'super_admin')`,
      [direction, DEFAULT_TENANT_ID, directionLyon, AUTRE],
    )
  })

  beforeEach(async () => {
    process.env.DOLIBARR_API_TOKEN = ANCIEN
    // Le webhook écrit une ligne au journal du serveur à chaque appel.
    for (const niveau of ['info', 'warn'] as const) mock.method(console, niveau, () => {})
    await viderTables(bases.owner, 'crm_exchanges', 'crm_connections', 'services')
  })

  afterEach(() => {
    process.env.DOLIBARR_API_TOKEN = saved
    mock.restoreAll()
  })

  after(async () => {
    await viderTables(bases.owner, 'crm_exchanges', 'crm_connections', 'services', 'staff_members')
    await bases.owner.client.query('delete from tenants where id = ?', [AUTRE])
    delete (globalThis as { database?: unknown }).database
    await bases?.fermer()
  })

  it('n’existe pas sans jeton ni avec un jeton faux, et n’en garde rien au journal', async () => {
    assert.equal((await devis()).status, 404)
    assert.equal((await devis('faux')).status, 404)
    assert.equal((await produit('faux')).response.status, 404)
    process.env.DOLIBARR_API_TOKEN = ''
    assert.equal((await devis('')).status, 404)
    assert.deepEqual(await brut('select id from crm_exchanges'), [])
  })

  it('répond à l’ancien jeton comme avant l’écran, tant que rien n’y est réglé', async () => {
    const reponse = await devis(ANCIEN)
    assert.equal(reponse.status, 200)
    assert.deepEqual(await reponse.json(), { devis: [] })
    assert.equal((await produit(ANCIEN)).response.status, 200)

    const lignes = await journal(DEFAULT_TENANT_ID)
    assert.deepEqual(
      lignes.map((ligne) => [ligne.operation, ligne.status_code, ligne.credential]),
      [
        ['GET /api/dolibarr/devis', 200, 'server'],
        ['POST /api/dolibarr/produits', 200, 'server'],
      ],
    )
    assert.equal(lignes[1]!.message, 'Service « courrier.ouverture » créé.')
  })

  it('ouvre au jeton réglé à l’écran, et ferme aussitôt l’ancien', async () => {
    await setCrmToken(crmTokenHash(NOUVEAU), direction)
    assert.equal((await devis(NOUVEAU)).status, 200)
    assert.equal((await produit(NOUVEAU)).response.status, 200)
    assert.equal((await devis(ANCIEN)).status, 404)
    assert.equal((await produit(ANCIEN)).response.status, 404)
    assert.deepEqual(
      (await journal(DEFAULT_TENANT_ID)).map((ligne) => ligne.credential),
      ['screen', 'screen'],
    )
  })

  it('rend la main à l’ancien jeton quand celui de l’écran est retiré', async () => {
    await setCrmToken(crmTokenHash(NOUVEAU), direction)
    await removeCrmToken(direction)
    assert.equal((await devis(ANCIEN)).status, 200)
    assert.equal((await devis(NOUVEAU)).status, 404)
  })

  it('sert le jeton d’un autre centre pour ce centre seulement', async () => {
    await runForTenant(AUTRE, () => setCrmToken(crmTokenHash(LYON), directionLyon))
    const { response } = await produit(LYON)
    assert.equal(response.status, 200)

    const services = await brut<{ tenant_id: string }>("select tenant_id from services where code = 'courrier.ouverture'")
    assert.deepEqual(services, [{ tenant_id: AUTRE }])
    assert.equal((await journal(AUTRE)).length, 1)
    assert.deepEqual(await journal(DEFAULT_TENANT_ID), [])

    // L'ancien jeton reste celui du centre unique : le centre de Lyon n'y a
    // rien changé.
    assert.equal((await devis(ANCIEN)).status, 200)
    assert.equal((await journal(DEFAULT_TENANT_ID))[0]!.credential, 'server')
  })

  it('refuse un flux coupé à l’écran : 403 sur les devis, 400 au webhook, au journal', async () => {
    await saveCrmFlows([], direction)
    const reponse = await devis(ANCIEN)
    assert.equal(reponse.status, 403)
    assert.match((await reponse.json()).erreur, /Flux « Devis » désactivé/)
    const { response } = await produit(ANCIEN)
    assert.equal(response.status, 400)
    assert.match((await response.json()).erreur, /Flux « Produits et tarifs » désactivé/)
    assert.deepEqual(await brut('select id from services'), [])
    assert.deepEqual(
      (await journal(DEFAULT_TENANT_ID)).map((ligne) => [ligne.status_code, Boolean(ligne.ok)]),
      [
        [403, false],
        [400, false],
      ],
    )
  })

  it('inscrit au journal l’erreur rendue au connecteur', async () => {
    const reponse = await listeDesDevis(
      new Request('http://127.0.0.1:3100/api/dolibarr/devis?limite=9999', { headers: { authorization: `Bearer ${ANCIEN}` } }),
    )
    assert.equal(reponse.status, 400)
    assert.equal((await journal(DEFAULT_TENANT_ID))[0]!.message, 'La limite est un entier de 1 à 500.')
  })
})
