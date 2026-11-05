import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'

import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { runForTenant } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { googleClientStatus, loadGoogleConfig, saveGoogleClient } from './agenda-google-queries.ts'

/**
 * Identifiants Google Cloud réglés à l'écran (ADR 069) : un jeu par centre,
 * le code secret chiffré, préférés aux variables du serveur.
 */
describe('identifiants Google Cloud, en base', { skip: raisonDeSaut }, () => {
  const AUTRE = '01999f00-0000-7000-8000-0000000000ca'
  const CLE = Buffer.alloc(32, 7).toString('base64')
  const AUTRE_CLE = Buffer.alloc(32, 9).toString('base64')
  const ENV = ['SECRETS_ENCRYPTION_KEY', 'APP_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]))
  const ecran = { clientId: '123-ecran.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret-ecran' }
  let bases: TestDatabases
  let admin: string
  let adminAutre: string

  const brut = async <T>(requete: string, params: unknown[] = []) =>
    ((await bases.owner.client.query(requete, params)) as unknown as [T[]])[0]

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
    await bases.owner.client.query(
      `insert into tenants (id, name, slug) values (?, 'Centre de Grenoble', 'centre-de-grenoble') on duplicate key update id = id`,
      [AUTRE],
    )
    admin = uuidv7()
    adminAutre = uuidv7()
    await bases.owner.client.query(
      `insert into staff_members (id, tenant_id, email, full_name, role) values (?, ?, 'admin@exemple.fr', 'Admin', 'admin'), (?, ?, 'admin@grenoble.exemple.fr', null, 'admin')`,
      [admin, DEFAULT_TENANT_ID, adminAutre, AUTRE],
    )
  })

  beforeEach(async () => {
    process.env.SECRETS_ENCRYPTION_KEY = CLE
    process.env.APP_URL = 'https://centre.exemple.fr'
    delete process.env.GOOGLE_CLIENT_ID
    delete process.env.GOOGLE_CLIENT_SECRET
    await viderTables(bases.owner, 'google_oauth_clients')
  })

  afterEach(() => {
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  })

  after(async () => {
    await viderTables(bases.owner, 'google_oauth_clients', 'staff_members')
    await bases.owner.client.query('delete from tenants where id = ?', [AUTRE])
    delete (globalThis as { database?: unknown }).database
    await bases?.fermer()
  })

  it('n’est réglé ni à l’écran ni sur le serveur au départ', async () => {
    assert.deepEqual(await googleClientStatus(), { source: 'aucune' })
    assert.equal(await loadGoogleConfig(), undefined)
  })

  it('garde le code secret chiffré et le relit pour se connecter', async () => {
    await saveGoogleClient(ecran, admin)

    const [ligne] = await brut<{ client_id: string; client_secret_sealed: string }>(
      'select client_id, client_secret_sealed from google_oauth_clients',
    )
    assert.equal(ligne?.client_id, ecran.clientId)
    assert.ok(!ligne?.client_secret_sealed.includes(ecran.clientSecret))

    const config = await loadGoogleConfig()
    assert.equal(config?.clientId, ecran.clientId)
    assert.equal(config?.clientSecret, ecran.clientSecret)
    assert.equal(config?.redirectUri, 'https://centre.exemple.fr/ressources/agendas/retour')

    const status = await googleClientStatus()
    assert.equal(status.source, 'ecran')
    assert.ok(status.source === 'ecran' && status.readable && status.clientId === ecran.clientId)
  })

  it('remplace les identifiants du centre au lieu d’en ajouter', async () => {
    await saveGoogleClient(ecran, admin)
    await saveGoogleClient({ clientId: '456-autre.apps.googleusercontent.com', clientSecret: 'GOCSPX-nouveau' }, admin)
    assert.equal((await brut('select id from google_oauth_clients')).length, 1)
    assert.equal((await loadGoogleConfig())?.clientSecret, 'GOCSPX-nouveau')
  })

  it('préfère l’écran au serveur, et se replie sur le serveur sans réglage à l’écran', async () => {
    process.env.GOOGLE_CLIENT_ID = '789-serveur.apps.googleusercontent.com'
    process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-serveur'
    assert.deepEqual(await googleClientStatus(), { source: 'serveur', clientId: process.env.GOOGLE_CLIENT_ID })
    assert.equal((await loadGoogleConfig())?.clientSecret, 'GOCSPX-serveur')

    await saveGoogleClient(ecran, admin)
    assert.equal((await loadGoogleConfig())?.clientSecret, ecran.clientSecret)
  })

  it('demande de ressaisir un code secret chiffré par une autre clé, sans se rabattre sur le serveur', async () => {
    await saveGoogleClient(ecran, admin)
    process.env.SECRETS_ENCRYPTION_KEY = AUTRE_CLE
    process.env.GOOGLE_CLIENT_ID = '789-serveur.apps.googleusercontent.com'
    process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-serveur'

    const status = await googleClientStatus()
    assert.ok(status.source === 'ecran' && !status.readable)
    assert.equal(await loadGoogleConfig(), undefined)
  })

  it('tient un jeu d’identifiants par centre', async () => {
    await saveGoogleClient(ecran, admin)
    await runForTenant(AUTRE, async () => {
      assert.deepEqual(await googleClientStatus(), { source: 'aucune' })
      await saveGoogleClient({ clientId: '999-grenoble.apps.googleusercontent.com', clientSecret: 'GOCSPX-grenoble' }, adminAutre)
      assert.equal((await loadGoogleConfig())?.clientSecret, 'GOCSPX-grenoble')
    })
    assert.equal((await loadGoogleConfig())?.clientSecret, ecran.clientSecret)
  })
})
