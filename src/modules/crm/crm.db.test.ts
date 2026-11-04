import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test'

import { eq } from 'drizzle-orm'

import { DB_TENANT_MISMATCH, DB_UNIQUE_VIOLATION, dbErrorCode } from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { runForTenant } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { crmTokenHash } from './jeton.ts'
import {
  CRM_EXCHANGE_RETENTION_DAYS,
  crmAccessStore,
  crmConnectionView,
  crmOutboundCredentials,
  lastInboundExchange,
  listCrmExchanges,
  recordCrmExchange,
  removeCrmToken,
  saveCrmFlows,
  saveCrmSettings,
  setCrmToken,
  type CrmExchangeEntry,
} from './queries.ts'
import { crmConnections } from './schema.ts'

/**
 * Connexion au CRM en base (ADR 065) : un réglage par centre, le jeton
 * gardé par son empreinte et unique sur toute la base, la clé chiffrée, le
 * journal par centre et purgé.
 */
describe('connexion au CRM, en base', { skip: raisonDeSaut }, () => {
  const AUTRE = '01999f00-0000-7000-8000-0000000000c9'
  const CLE = Buffer.alloc(32, 7).toString('base64')
  const savedKey = process.env.SECRETS_ENCRYPTION_KEY
  let bases: TestDatabases
  let direction: string
  let directionAutre: string

  const brut = async <T>(requete: string, params: unknown[] = []) =>
    ((await bases.owner.client.query(requete, params)) as unknown as [T[]])[0]

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
    await bases.owner.client.query(
      `insert into tenants (id, name, slug) values (?, 'Centre de Lyon', 'centre-de-lyon') on duplicate key update id = id`,
      [AUTRE],
    )
    direction = uuidv7()
    directionAutre = uuidv7()
    await bases.owner.client.query(
      `insert into staff_members (id, tenant_id, email, full_name, role) values (?, ?, 'direction@exemple.fr', 'Camille Direction', 'super_admin'), (?, ?, 'direction@lyon.exemple.fr', null, 'super_admin')`,
      [direction, DEFAULT_TENANT_ID, directionAutre, AUTRE],
    )
  })

  beforeEach(async () => {
    process.env.SECRETS_ENCRYPTION_KEY = CLE
    await viderTables(bases.owner, 'crm_exchanges', 'crm_connections')
  })

  afterEach(() => {
    process.env.SECRETS_ENCRYPTION_KEY = savedKey
    mock.restoreAll()
  })

  after(async () => {
    await viderTables(bases.owner, 'crm_exchanges', 'crm_connections', 'staff_members')
    await bases.owner.client.query('delete from tenants where id = ?', [AUTRE])
    delete (globalThis as { database?: unknown }).database
    await bases?.fermer()
  })

  const appel = (overrides: Partial<CrmExchangeEntry> = {}): CrmExchangeEntry => ({
    connector: 'dolibarr',
    direction: 'inbound',
    flow: 'quotes',
    operation: 'GET /api/dolibarr/devis',
    statusCode: 200,
    ok: true,
    message: '0 devis au statut « ready ».',
    credential: 'server',
    durationMs: 4,
    ...overrides,
  })

  it('sans réglage : Dolibarr, aucun jeton, aucune clé, devis et produits ouverts', async () => {
    const vue = await crmConnectionView()
    assert.equal(vue.configured, false)
    assert.equal(vue.connector, 'dolibarr')
    assert.equal(vue.hasToken, false)
    assert.equal(vue.hasKey, false)
    assert.deepEqual(vue.enabledFlows, ['quotes', 'products'])
    assert.equal(await crmAccessStore.forTenant(DEFAULT_TENANT_ID), undefined)
  })

  it('garde la clé chiffrée, jamais en clair, et la relit seulement pour le test', async () => {
    await saveCrmSettings(
      { connector: 'dolibarr', baseUrl: 'https://crm.exemple.fr', key: 'cle-api-secrete-123' },
      direction,
    )
    const [ligne] = await brut<{ outbound_key_sealed: string; updated_by: string; base_url: string }>(
      'select outbound_key_sealed, updated_by, base_url from crm_connections where tenant_id = ?',
      [DEFAULT_TENANT_ID],
    )
    assert.match(ligne!.outbound_key_sealed, /^v1:/)
    assert.doesNotMatch(ligne!.outbound_key_sealed, /cle-api-secrete/)
    assert.equal(ligne!.updated_by, direction)
    assert.equal(ligne!.base_url, 'https://crm.exemple.fr')

    const vue = await crmConnectionView()
    assert.equal(vue.hasKey, true)
    assert.ok(vue.keySetAt)
    assert.equal(JSON.stringify(vue).includes('cle-api-secrete'), false)
    assert.equal((await crmOutboundCredentials())?.key, 'cle-api-secrete-123')

    // Sans clé saisie, elle reste ; `null` l'efface.
    await saveCrmSettings({ connector: 'dolibarr', baseUrl: 'https://crm2.exemple.fr' }, direction)
    assert.equal((await crmOutboundCredentials())?.key, 'cle-api-secrete-123')
    await saveCrmSettings({ connector: 'dolibarr', baseUrl: 'https://crm2.exemple.fr', key: null }, direction)
    assert.equal((await crmConnectionView()).hasKey, false)
  })

  it('dit d’une clé chiffrée par un autre serveur qu’elle est illisible', async () => {
    await saveCrmSettings({ connector: 'dolibarr', baseUrl: 'https://crm.exemple.fr', key: 'cle-api-secrete-123' }, direction)
    process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
    const lue = await crmOutboundCredentials()
    assert.equal(lue?.key, null)
    assert.equal(lue?.unreadable, true)
  })

  it('trouve le centre d’un jeton sur toute la base, et ne garde que son empreinte', async () => {
    await setCrmToken(crmTokenHash('crm_unique'), direction)
    await runForTenant(AUTRE, () => setCrmToken(crmTokenHash('crm_lyon'), directionAutre))

    assert.equal((await crmAccessStore.byTokenHash(crmTokenHash('crm_lyon')))?.tenantId, AUTRE)
    assert.equal((await crmAccessStore.byTokenHash(crmTokenHash('crm_unique')))?.tenantId, DEFAULT_TENANT_ID)
    assert.equal(await crmAccessStore.byTokenHash(crmTokenHash('crm_inconnu')), undefined)

    const lignes = await brut<{ inbound_token_hash: string }>('select inbound_token_hash from crm_connections')
    assert.equal(lignes.length, 2)
    for (const { inbound_token_hash } of lignes) assert.match(inbound_token_hash, /^[0-9a-f]{64}$/)

    const vue = await crmConnectionView()
    assert.equal(vue.hasToken, true)
    assert.equal(vue.tokenSetBy, 'Camille Direction')
    assert.equal(JSON.stringify(vue).includes(crmTokenHash('crm_unique')), false)
  })

  it('refuse le même jeton à deux centres', async () => {
    await setCrmToken(crmTokenHash('crm_double'), direction)
    let code: string | undefined
    try {
      await runForTenant(AUTRE, () => setCrmToken(crmTokenHash('crm_double'), directionAutre))
    } catch (error) {
      code = dbErrorCode(error)
    }
    // L'index unique joue avant l'insertion ; sur la ligne de l'autre centre,
    // la mise à jour de repli est refusée par la garde de centre.
    assert.ok(code === DB_UNIQUE_VIOLATION || code === DB_TENANT_MISMATCH, String(code))
    assert.equal((await crmAccessStore.byTokenHash(crmTokenHash('crm_double')))?.tenantId, DEFAULT_TENANT_ID)
  })

  it('refuse d’écrire le réglage d’un autre centre (CA014)', async () => {
    await runForTenant(AUTRE, () => setCrmToken(crmTokenHash('crm_lyon'), directionAutre))
    let code: string | undefined
    try {
      await withTenant(DEFAULT_TENANT_ID, (tx) =>
        tx
          .update(crmConnections)
          .set({ baseUrl: 'https://autre-crm.exemple.fr' })
          .where(eq(crmConnections.tenantId, AUTRE)),
      )
    } catch (error) {
      code = dbErrorCode(error)
    }
    assert.equal(code, DB_TENANT_MISMATCH)
  })

  it('retire le jeton : le réglage reste, sans empreinte', async () => {
    await setCrmToken(crmTokenHash('crm_unique'), direction)
    await removeCrmToken(direction)
    const reglage = await crmAccessStore.forTenant(DEFAULT_TENANT_ID)
    assert.equal(reglage?.tokenHash, null)
    assert.equal((await crmConnectionView()).hasToken, false)
  })

  it('enregistre les flux du centre, sans toucher à ceux d’un autre', async () => {
    await saveCrmFlows(['products'], direction)
    await runForTenant(AUTRE, () => saveCrmFlows([], directionAutre))
    assert.deepEqual((await crmAccessStore.forTenant(DEFAULT_TENANT_ID))?.enabledFlows, ['products'])
    assert.deepEqual((await crmAccessStore.forTenant(AUTRE))?.enabledFlows, [])
    assert.deepEqual((await crmConnectionView()).enabledFlows, ['products'])
  })

  it('tient un journal par centre, le plus récent d’abord, purgé au-delà de la durée', async () => {
    const ancien = (tenantId: string) =>
      bases.owner.client.query(
        `insert into crm_exchanges (id, tenant_id, connector, direction, flow, operation, status_code, ok, credential, created_at)
         values (?, ?, 'dolibarr', 'inbound', 'quotes', 'GET /api/dolibarr/devis', 200, true, 'server',
                 current_timestamp(3) - interval ${CRM_EXCHANGE_RETENTION_DAYS + 1} day)`,
        [uuidv7(), tenantId],
      )
    await ancien(DEFAULT_TENANT_ID)
    await ancien(AUTRE)

    await recordCrmExchange(DEFAULT_TENANT_ID, appel())
    await recordCrmExchange(
      DEFAULT_TENANT_ID,
      appel({ direction: 'outbound', flow: null, credential: null, operation: 'Test de connexion', statusCode: 401, ok: false }),
    )
    const autres = async () =>
      Number(
        (await brut<{ n: number }>('select count(*) as n from crm_exchanges where tenant_id = ?', [AUTRE]))[0]!.n,
      )
    // La purge du centre unique ne touche pas à la ligne ancienne d'un autre centre…
    assert.equal(await autres(), 1)
    await recordCrmExchange(AUTRE, appel({ message: 'du centre de Lyon' }))
    // … qui part à la première écriture de ce centre-là.
    assert.equal(await autres(), 1)

    const lignes = await listCrmExchanges()
    assert.deepEqual(
      lignes.map((ligne) => ligne.operation),
      ['Test de connexion', 'GET /api/dolibarr/devis'],
    )
    assert.equal(lignes.some((ligne) => ligne.message === 'du centre de Lyon'), false)
    assert.equal((await lastInboundExchange())?.operation, 'GET /api/dolibarr/devis')
  })

  it('ne fait pas échouer l’appel quand le journal refuse une ligne', async () => {
    const erreurs: unknown[] = []
    mock.method(console, 'error', (...args: unknown[]) => erreurs.push(args))
    // Un appel reçu sans jeton : contraire à `crm_exchanges_inbound_complete`.
    await recordCrmExchange(DEFAULT_TENANT_ID, appel({ credential: null }))
    assert.equal(erreurs.length, 1)
    assert.deepEqual(await listCrmExchanges(), [])
  })
})
