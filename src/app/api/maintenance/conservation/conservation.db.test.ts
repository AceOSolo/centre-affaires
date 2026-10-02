import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant } from '../../../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../../../db/tenants.ts'
import { runNightlyConservation } from '../../../../modules/rgpd/tache-de-nuit.ts'
import { POST } from './route.ts'

/**
 * Tâche nocturne de conservation (ADR 015, ADR 020, B4) : la route appelée
 * par le serveur efface aussi les coordonnées des demandes publiques échues.
 * Éprouvée telle que le serveur l'appelle, contre la base de test ; une panne
 * du stockage ne retient aucune des autres étapes.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('route de conservation', { skip: raison }, () => {
  // La route ouvre sa propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl
  const TOKEN = 'jeton-de-maintenance-de-test'

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')
  const SALLE = '01a00000-0000-7000-8000-000000200b01'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  const appeler = (authorization?: string) =>
    POST(
      new Request('http://127.0.0.1:3000/api/maintenance/conservation', {
        method: 'POST',
        headers: authorization ? { authorization } : {},
      }),
    )

  /** Une demande publique dont le créneau s'est terminé il y a `mois` mois. */
  let heure = 0
  const demande = async (titre: string, mois: number) => {
    heure += 1
    await asTenant((tx) =>
      tx.execute(sql`
        insert into bookings (
          resource_id, channel, status, title, requester_name, requester_email, requester_phone,
          starts_at, ends_at
        ) values (
          ${SALLE}, 'public', 'pending', ${titre}, 'Camille Rousseau', 'camille@exemple.fr', '06 12 34 56 78',
          now() - make_interval(months => ${mois}, hours => ${heure + 1}),
          now() - make_interval(months => ${mois}, hours => ${heure})
        )`),
    )
  }

  const demandeur = async (titre: string) => {
    const [row] = await owner.client`
      select requester_email, requester_anonymized_at from bookings where title = ${titre}`
    return row
  }

  const saved = process.env.MAINTENANCE_TOKEN

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    process.env.MAINTENANCE_TOKEN = TOKEN
    heure = 0
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`update tenants set public_request_retention_months = 12`
    await owner.client`update tenants set prospect_retention_months = 36, removed_member_retention_months = 12`
    await asTenant((tx) =>
      tx.execute(sql`
        insert into resources (id, resource_type, code, name) values (${SALLE}, 'salle', 'SAL-C', 'Salle')`),
    )
  })

  after(async () => {
    if (saved === undefined) delete process.env.MAINTENANCE_TOKEN
    else process.env.MAINTENANCE_TOKEN = saved
    await owner.client`update tenants set public_request_retention_months = 12`
    await owner.client`update tenants set prospect_retention_months = 36, removed_member_retention_months = 12`
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  it('efface les coordonnées des demandes publiques échues, et elles seules', async () => {
    await demande('Séminaire 2024', 24)
    await demande('Réunion récente', 2)

    const response = await appeler(`Bearer ${TOKEN}`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      scans: 0,
      views: 0,
      publicRequests: 1,
      anonymizedClients: { clients: 0, contacts: 0, accesses: 0, mailSenders: 0 },
      anonymizedMembers: { accesses: 0, staff: 0 },
      notificationDeliveries: 0,
      inspectionPhotos: 0,
      inspectionPhotoViews: 0,
      failed: [],
    })

    const echue = await demandeur('Demande publique anonymisée')
    assert.equal(echue.requester_email, null)
    assert.ok(echue.requester_anonymized_at)
    assert.equal((await demandeur('Réunion récente')).requester_email, 'camille@exemple.fr')
  })

  it('suit la durée réglée pour le centre', async () => {
    await demande('Il y a trois mois', 3)
    await owner.client`update tenants set public_request_retention_months = 2`
    const response = await appeler(`Bearer ${TOKEN}`)
    assert.equal((await response.json()).publicRequests, 1)
  })

  it('ne repasse pas sur une demande déjà anonymisée', async () => {
    await demande('Séminaire 2024', 24)
    await appeler(`Bearer ${TOKEN}`)
    const response = await appeler(`Bearer ${TOKEN}`)
    assert.equal((await response.json()).publicRequests, 0)
  })

  it('anonymise les entreprises et les personnes retirées au terme, et ne journalise que des nombres', async (t) => {
    const journal = t.mock.method(console, 'info', () => {})
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (name, status, created_at, email)
        values ('Prospect oublié', 'prospect', '2020-01-01T09:00:00Z', 'oublie@exemple.fr')`)
      await tx.execute(sql`
        insert into client_contacts (client_id, full_name, email)
        select id, 'Paul Prospect', 'paul@exemple.fr' from clients where name = 'Prospect oublié'`)
      await tx.execute(sql`
        insert into staff_members (email, full_name, deleted_at)
        values ('parti@centre.fr', 'Ancienne accueil', now() - interval '2 years')`)
    })

    const response = await appeler(`Bearer ${TOKEN}`)
    const bilan = await response.json()
    assert.deepEqual(bilan.anonymizedClients, { clients: 1, contacts: 1, accesses: 0, mailSenders: 0 })
    assert.deepEqual(bilan.anonymizedMembers, { accesses: 0, staff: 1 })

    const lignes = journal.mock.calls.map((call) => String(call.arguments[0]))
    assert.equal(lignes.length, 1)
    assert.match(lignes[0], /1 entreprise anonymisée \(1 contact, 0 accès, 0 pli\)/)
    assert.doesNotMatch(lignes[0], /Prospect|Paul|Ancienne|@/)

    // Le passage suivant ne trouve plus rien.
    const ensuite = await (await appeler(`Bearer ${TOKEN}`)).json()
    assert.deepEqual(ensuite.anonymizedClients, { clients: 0, contacts: 0, accesses: 0, mailSenders: 0 })
    assert.deepEqual(ensuite.anonymizedMembers, { accesses: 0, staff: 0 })
  })

  it('purge le journal des messages au terme de sa durée (ADR 038)', async () => {
    await owner.client`truncate table notification_deliveries`
    await owner.client`update tenants set notification_log_retention_months = 12`
    await asTenant((tx) =>
      tx.execute(sql`
        insert into notification_deliveries (event, audience, recipients, subject, status, sent_at) values
          ('mail_request_submitted', 'centre', '{accueil@centre.fr}', 'Ancienne', 'sent', now() - interval '13 months'),
          ('mail_request_submitted', 'centre', '{accueil@centre.fr}', 'Récente', 'sent', now() - interval '1 month')`),
    )
    const response = await appeler(`Bearer ${TOKEN}`)
    assert.equal((await response.json()).notificationDeliveries, 1)
    const restants = await owner.client`select subject from notification_deliveries`
    assert.deepEqual(
      restants.map((row) => row.subject),
      ['Récente'],
    )
    await owner.client`truncate table notification_deliveries`
  })

  it('mène les autres étapes à terme quand le stockage est injoignable, et le dit', async (t) => {
    const erreurs = t.mock.method(console, 'error', () => {})
    t.mock.method(console, 'info', () => {})
    const ACCUEIL = '01a00000-0000-7000-8000-000000200d01'
    await owner.client`truncate table notification_deliveries`
    await owner.client`
      update tenants set notification_log_retention_months = 12, mail_scan_retention_months = 12,
                         mail_access_log_retention_months = 12`
    await demande('Séminaire 2024', 24)
    const scanId = await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, full_name) values (${ACCUEIL}, 'accueil@centre.fr', 'Accueil')`)
      const [client] = await tx.execute(sql`insert into clients (name, status) values ('Atelier Durand', 'active') returning id`)
      const [pli] = await tx.execute(sql`insert into mail_items (client_id) values (${client.id as string}) returning id`)
      const [scan] = await tx.execute(sql`
        insert into mail_scans (mail_item_id, side, storage_key, content_type, byte_size, created_at)
        values (${pli.id as string}, 'content', 'courrier/test/conservation.pdf', 'application/pdf', 1200,
                now() - interval '13 months')
        returning id`)
      await tx.execute(sql`
        insert into mail_scan_views (mail_scan_id, viewer, staff_member_id, auth_user_id, viewed_at)
        values (${scan.id as string}, 'staff', ${ACCUEIL}, 'u-accueil', now() - interval '13 months')`)
      await tx.execute(sql`
        insert into notification_deliveries (event, audience, recipients, subject, status, sent_at)
        values ('mail_request_submitted', 'centre', '{accueil@centre.fr}', 'Ancienne', 'sent', now() - interval '13 months')`)
      return scan.id as string
    })

    const bilan = await runNightlyConservation(DEFAULT_TENANT_ID, async () => {
      throw new Error('Stockage injoignable')
    })
    assert.deepEqual(bilan.failed, ['scans'])
    assert.equal(bilan.scans, null)
    // Tout ce qui ne dépend que de la base a eu lieu, journal d'accès compris.
    assert.equal(bilan.publicRequests, 1)
    assert.equal(bilan.views, 1)
    assert.equal(bilan.notificationDeliveries, 1)
    assert.deepEqual(bilan.anonymizedMembers, { accesses: 0, staff: 0 })
    assert.equal(bilan.inspectionPhotoViews, 0)
    assert.equal(bilan.inspectionPhotos, 0)
    // La numérisation reste à reprendre : sa ligne n'est pas marquée.
    const [scan] = await owner.client`select deleted_at from mail_scans where id = ${scanId}`
    assert.equal(scan.deleted_at, null)
    // Le journal nomme l'étape, sans le détail de l'erreur.
    assert.equal(erreurs.mock.calls.length, 1)
    assert.match(String(erreurs.mock.calls[0].arguments[0]), /« scans » a échoué.*Stockage injoignable/)

    // La route le signale à la tâche du serveur : un 500, avec le bilan. Sans
    // point d'accès configuré, le stockage refuse de démarrer.
    const endpoint = process.env.AWS_ENDPOINT_URL_S3
    delete process.env.AWS_ENDPOINT_URL_S3
    try {
      const response = await appeler(`Bearer ${TOKEN}`)
      assert.equal(response.status, 500)
      assert.deepEqual((await response.json()).failed, ['scans'])
    } finally {
      if (endpoint !== undefined) process.env.AWS_ENDPOINT_URL_S3 = endpoint
    }
    await owner.client`truncate table notification_deliveries`
  })

  it('n’existe pas sans le bon jeton', async () => {
    await demande('Séminaire 2024', 24)
    for (const authorization of [undefined, 'Bearer mauvais', `Bearer ${TOKEN}x`, TOKEN.slice(1)]) {
      const response = await appeler(authorization)
      assert.equal(response.status, 404, String(authorization))
    }
    delete process.env.MAINTENANCE_TOKEN
    assert.equal((await appeler('Bearer ')).status, 404)
    assert.equal((await demandeur('Séminaire 2024')).requester_email, 'camille@exemple.fr')
  })
})
