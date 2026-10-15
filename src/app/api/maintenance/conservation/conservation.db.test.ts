import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { withTenant } from '../../../../db/index.ts'
import {
  ouvrirBasesDeTest,
  raisonDeSaut,
  viderTables,
  type TestDatabases,
} from '../../../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../../../db/tenants.ts'
import { uuidv7 } from '../../../../lib/uuid.ts'
import { runNightlyConservation } from '../../../../modules/rgpd/tache-de-nuit.ts'
import { POST } from './route.ts'

/**
 * Tâche nocturne de conservation (ADR 015, ADR 020, B4) : la route appelée
 * par le serveur efface aussi les coordonnées des demandes publiques échues.
 * Éprouvée telle que le serveur l'appelle, contre la base de test ; une panne
 * du stockage ne retient aucune des autres étapes.
 */
describe('route de conservation', { skip: raisonDeSaut }, () => {
  const TOKEN = 'jeton-de-maintenance-de-test'
  const SALLE = '01a00000-0000-7000-8000-000000200b01'

  let bases: TestDatabases
  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const lire = async (requete: string, params: unknown[] = []) => {
    const [rows] = await bases.owner.client.query(requete, params)
    return rows as Record<string, unknown>[]
  }

  const appeler = (authorization?: string) =>
    POST(
      new Request('http://127.0.0.1:3000/api/maintenance/conservation', {
        method: 'POST',
        headers: authorization ? { authorization } : {},
      }),
    )

  /** Toutes les tables métier : les clés étrangères entre elles rendent un vidage partiel inutilisable. */
  const toutVider = async () => {
    const tables = await lire(
      `select table_name as name from information_schema.tables
        where table_schema = database() and table_type = 'BASE TABLE'
          and table_name not in ('tenants', '__migrations') and table_name not like 'auth\\_%'`,
    )
    await viderTables(bases.owner, ...tables.map((table) => String(table.name)))
  }

  /** Une demande publique dont le créneau s'est terminé il y a `mois` mois. */
  let heure = 0
  const demande = async (titre: string, mois: number) => {
    heure += 1
    await asTenant((tx) =>
      tx.execute(sql`
        insert into bookings (
          id, resource_id, channel, status, title, requester_name, requester_email, requester_phone,
          starts_at, ends_at
        ) values (
          ${uuidv7()}, ${SALLE}, 'public', 'pending', ${titre}, 'Camille Rousseau', 'camille@exemple.fr', '06 12 34 56 78',
          CURRENT_TIMESTAMP(3) - interval ${mois} month - interval ${heure + 1} hour,
          CURRENT_TIMESTAMP(3) - interval ${mois} month - interval ${heure} hour
        )`),
    )
  }

  const demandeur = async (titre: string) => {
    const [row] = await lire(
      'select requester_email, requester_anonymized_at from bookings where title = ?',
      [titre],
    )
    return row
  }

  const reglerDurees = () =>
    bases.owner.client.query(
      `update tenants set public_request_retention_months = 12, prospect_retention_months = 36,
                          removed_member_retention_months = 12`,
    )

  const saved = process.env.MAINTENANCE_TOKEN

  before(async () => {
    bases = await ouvrirBasesDeTest()
    // La route ouvre sa propre connexion, par `DB_*` : on la pointe sur la
    // base de test, sous l'identité applicative.
    const e = process.env
    e.DB_HOST = e.TEST_DB_HOST ?? e.DB_HOST ?? '127.0.0.1'
    e.DB_PORT = e.TEST_DB_PORT ?? e.DB_PORT ?? '3306'
    e.DB_NAME = e.TEST_DB_NAME
    e.DB_USER = e.TEST_DB_USER ?? e.TEST_DB_ADMIN_USER ?? e.DB_ADMIN_USER ?? 'root'
    e.DB_PASSWORD = e.TEST_DB_USER
      ? (e.TEST_DB_PASSWORD ?? '')
      : (e.TEST_DB_ADMIN_PASSWORD ?? e.DB_ADMIN_PASSWORD ?? '')
  })

  beforeEach(async () => {
    process.env.MAINTENANCE_TOKEN = TOKEN
    heure = 0
    await toutVider()
    await reglerDurees()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into resources (id, resource_type, code, name) values (${SALLE}, 'salle', 'SAL-C', 'Salle')`),
    )
  })

  after(async () => {
    if (saved === undefined) delete process.env.MAINTENANCE_TOKEN
    else process.env.MAINTENANCE_TOKEN = saved
    await reglerDurees()
    await toutVider()
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([bases.fermer(), global.database?.client.end()])
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
    await bases.owner.client.query('update tenants set public_request_retention_months = 2')
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
      const prospect = uuidv7()
      await tx.execute(sql`
        insert into clients (id, name, status, created_at, email)
        values (${prospect}, 'Prospect oublié', 'prospect', '2020-01-01 09:00:00.000', 'oublie@exemple.fr')`)
      await tx.execute(sql`
        insert into client_contacts (id, client_id, full_name, email)
        values (${uuidv7()}, ${prospect}, 'Paul Prospect', 'paul@exemple.fr')`)
      await tx.execute(sql`
        insert into staff_members (id, email, full_name, deleted_at)
        values (${uuidv7()}, 'parti@centre.fr', 'Ancienne accueil', CURRENT_TIMESTAMP(3) - interval 2 year)`)
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
    await bases.owner.client.query('update tenants set notification_log_retention_months = 12')
    // `recipients` est une colonne JSON : la liste des adresses.
    await asTenant((tx) =>
      tx.execute(sql`
        insert into notification_deliveries (id, event, audience, recipients, subject, status, sent_at) values
          (${uuidv7()}, 'mail_request_submitted', 'centre', ${JSON.stringify(['accueil@centre.fr'])}, 'Ancienne', 'sent',
           CURRENT_TIMESTAMP(3) - interval 13 month),
          (${uuidv7()}, 'mail_request_submitted', 'centre', ${JSON.stringify(['accueil@centre.fr'])}, 'Récente', 'sent',
           CURRENT_TIMESTAMP(3) - interval 1 month)`),
    )
    const response = await appeler(`Bearer ${TOKEN}`)
    assert.equal((await response.json()).notificationDeliveries, 1)
    const restants = await lire('select subject from notification_deliveries')
    assert.deepEqual(
      restants.map((row) => row.subject),
      ['Récente'],
    )
  })

  it('mène les autres étapes à terme quand le stockage est injoignable, et le dit', async (t) => {
    const erreurs = t.mock.method(console, 'error', () => {})
    t.mock.method(console, 'info', () => {})
    const ACCUEIL = '01a00000-0000-7000-8000-000000200d01'
    await bases.owner.client.query(
      `update tenants set notification_log_retention_months = 12, mail_scan_retention_months = 12,
                          mail_access_log_retention_months = 12`,
    )
    await demande('Séminaire 2024', 24)
    const scanId = await asTenant(async (tx) => {
      const clientId = uuidv7()
      const pliId = uuidv7()
      const scanId = uuidv7()
      await tx.execute(sql`insert into staff_members (id, email, full_name) values (${ACCUEIL}, 'accueil@centre.fr', 'Accueil')`)
      await tx.execute(sql`insert into clients (id, name, status) values (${clientId}, 'Atelier Durand', 'active')`)
      await tx.execute(sql`insert into mail_items (id, client_id) values (${pliId}, ${clientId})`)
      await tx.execute(sql`
        insert into mail_scans (id, mail_item_id, side, storage_key, content_type, byte_size, created_at)
        values (${scanId}, ${pliId}, 'content', 'courrier/test/conservation.pdf', 'application/pdf', 1200,
                CURRENT_TIMESTAMP(3) - interval 13 month)`)
      await tx.execute(sql`
        insert into mail_scan_views (id, mail_scan_id, viewer, staff_member_id, auth_user_id, viewed_at)
        values (${uuidv7()}, ${scanId}, 'staff', ${ACCUEIL}, 'u-accueil', CURRENT_TIMESTAMP(3) - interval 13 month)`)
      await tx.execute(sql`
        insert into notification_deliveries (id, event, audience, recipients, subject, status, sent_at)
        values (${uuidv7()}, 'mail_request_submitted', 'centre', ${JSON.stringify(['accueil@centre.fr'])}, 'Ancienne', 'sent',
                CURRENT_TIMESTAMP(3) - interval 13 month)`)
      return scanId
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
    const [scan] = await lire('select deleted_at from mail_scans where id = ?', [scanId])
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
