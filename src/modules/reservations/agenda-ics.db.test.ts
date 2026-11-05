import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'

import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { runForTenant } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import {
  calendarForToken,
  createFeeds,
  listResourceFeeds,
  regenerateFeed,
  removeFeeds,
} from './agenda-ics-queries.ts'

/**
 * Liens d'agenda en base (ADR 071) : un par ressource, servi sans session au
 * seul détenteur du jeton, avec les réservations confirmées de la ressource.
 */
describe('liens d’agenda, en base', { skip: raisonDeSaut }, () => {
  const AUTRE = '01999f00-0000-7000-8000-0000000000cb'
  const SALLE = uuidv7()
  const CAMION = uuidv7()
  const SALLE_AUTRE = uuidv7()
  const ENV = ['AUTH_SECRET', 'APP_URL'] as const
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]))
  let bases: TestDatabases
  let admin: string
  let adminAutre: string

  const brut = async <T>(requete: string, params: unknown[] = []) =>
    ((await bases.owner.client.query(requete, params)) as unknown as [T[]])[0]

  /** Le jeton est la fin de l'adresse, sans `.ics`. */
  const jetonDe = (url: string | undefined) => url?.match(/\/api\/agendas\/([0-9a-f]{72})\.ics$/)?.[1]
  const lienDe = async (resourceId: string) => (await listResourceFeeds()).find((feed) => feed.id === resourceId)?.url

  const reservation = (resourceId: string, titre: string, statut: string, debut: string, fin: string, tenant = DEFAULT_TENANT_ID) =>
    bases.owner.client.query(
      `insert into bookings (id, tenant_id, resource_id, channel, status, title, requester_name, requester_email, starts_at, ends_at, cancelled_at)
       values (?, ?, ?, 'public', ?, ?, 'Camille Rousseau', 'camille@exemple.fr', ?, ?, if(? = 'cancelled', current_timestamp(3), null))`,
      [uuidv7(), tenant, resourceId, statut, titre, debut, fin, statut],
    )

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
    await bases.owner.client.query(
      `insert into tenants (id, name, slug) values (?, 'Centre de Nantes', 'centre-de-nantes') on duplicate key update id = id`,
      [AUTRE],
    )
    admin = uuidv7()
    adminAutre = uuidv7()
    await bases.owner.client.query(
      `insert into staff_members (id, tenant_id, email, full_name, role) values (?, ?, 'admin@exemple.fr', 'Admin', 'admin'), (?, ?, 'admin@nantes.exemple.fr', null, 'admin')`,
      [admin, DEFAULT_TENANT_ID, adminAutre, AUTRE],
    )
    await bases.owner.client.query(
      `insert into resources (id, tenant_id, resource_type, code, name) values
         (?, ?, 'salle', 'SAL-1', 'Salle Mont-Blanc'), (?, ?, 'vehicule', 'CAM-1', 'Camion'), (?, ?, 'salle', 'SAL-N', 'Salle de Nantes')`,
      [SALLE, DEFAULT_TENANT_ID, CAMION, DEFAULT_TENANT_ID, SALLE_AUTRE, AUTRE],
    )
    const demain = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    await reservation(SALLE, 'Réunion de cadrage', 'confirmed', `${demain} 08:00:00`, `${demain} 10:00:00`)
    await reservation(SALLE, 'Demande en attente', 'pending', `${demain} 11:00:00`, `${demain} 12:00:00`)
    await reservation(SALLE, 'Annulée', 'cancelled', `${demain} 13:00:00`, `${demain} 14:00:00`)
    await reservation(SALLE, 'Il y a longtemps', 'confirmed', '2020-01-06 08:00:00', '2020-01-06 10:00:00')
    await reservation(CAMION, 'Déménagement', 'confirmed', `${demain} 06:00:00`, `${demain} 17:00:00`)
    await reservation(SALLE_AUTRE, 'Réunion à Nantes', 'confirmed', `${demain} 08:00:00`, `${demain} 10:00:00`, AUTRE)
  })

  beforeEach(async () => {
    process.env.AUTH_SECRET = 'secret-de-test'
    process.env.APP_URL = 'https://centre.exemple.fr'
    await viderTables(bases.owner, 'calendar_feeds')
  })

  afterEach(() => {
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  })

  after(async () => {
    await viderTables(bases.owner, 'calendar_feeds', 'bookings', 'resources', 'staff_members')
    await bases.owner.client.query('delete from tenants where id = ?', [AUTRE])
    delete (globalThis as { database?: unknown }).database
    await bases?.fermer()
  })

  it('crée le lien des ressources choisies, une fois chacune', async () => {
    assert.equal(await createFeeds([SALLE, CAMION], admin), 2)
    assert.equal(await createFeeds([SALLE, CAMION], admin), 0)
    assert.equal((await brut('select id from calendar_feeds')).length, 2)
    assert.match((await lienDe(SALLE)) ?? '', /^https:\/\/centre\.exemple\.fr\/api\/agendas\/[0-9a-f]{72}\.ics$/)
  })

  it('ne crée pas de lien pour la ressource d’un autre centre', async () => {
    assert.equal(await createFeeds([SALLE_AUTRE], admin), 0)
  })

  it('sert les réservations confirmées de la ressource, et elles seules', async () => {
    await createFeeds([SALLE, CAMION], admin)
    const ics = (await calendarForToken(jetonDe(await lienDe(SALLE))!))?.replace(/\r\n /g, '')
    assert.ok(ics)
    assert.ok(ics.includes('SUMMARY:Réunion de cadrage'))
    for (const absent of ['Demande en attente', 'Annulée', 'Il y a longtemps', 'Déménagement', 'Nantes', 'Camille', 'camille@']) {
      assert.ok(!ics.includes(absent), `${absent} ne doit pas figurer dans l’agenda de la salle`)
    }
    assert.ok(ics.includes('X-WR-CALNAME:Salle Mont-Blanc — '))
  })

  it('note la lecture du lien, pour montrer que l’abonnement marche', async () => {
    await createFeeds([SALLE], admin)
    assert.equal((await listResourceFeeds()).find((feed) => feed.id === SALLE)?.lastFetchedAt, null)
    await calendarForToken(jetonDe(await lienDe(SALLE))!)
    assert.ok((await listResourceFeeds()).find((feed) => feed.id === SALLE)?.lastFetchedAt instanceof Date)
  })

  it('régénérer coupe l’ancien lien et en donne un nouveau', async () => {
    await createFeeds([SALLE], admin)
    const ancien = jetonDe(await lienDe(SALLE))!
    assert.ok(await regenerateFeed(SALLE, admin))
    const nouveau = jetonDe(await lienDe(SALLE))!
    assert.notEqual(nouveau, ancien)
    assert.equal(await calendarForToken(ancien), undefined)
    assert.ok(await calendarForToken(nouveau))
    assert.equal(await regenerateFeed(CAMION, admin), false)
  })

  it('désactiver coupe le lien', async () => {
    await createFeeds([SALLE], admin)
    const jeton = jetonDe(await lienDe(SALLE))!
    assert.equal(await removeFeeds([SALLE]), 1)
    assert.equal(await lienDe(SALLE), undefined)
    assert.equal(await calendarForToken(jeton), undefined)
  })

  it('refuse un jeton signé par une autre clé de serveur, ou inventé', async () => {
    await createFeeds([SALLE], admin)
    const jeton = jetonDe(await lienDe(SALLE))!
    process.env.AUTH_SECRET = 'autre-secret'
    assert.equal(await calendarForToken(jeton), undefined)
    assert.equal(await calendarForToken('0'.repeat(72)), undefined)
    assert.equal(await calendarForToken('pas-un-jeton'), undefined)
  })

  it('sert le lien d’un autre centre avec les réservations de ce centre', async () => {
    const lienNantes = await runForTenant(AUTRE, async () => {
      assert.equal(await createFeeds([SALLE_AUTRE], adminAutre), 1)
      return lienDe(SALLE_AUTRE)
    })
    // Lu sans session : c'est le jeton qui désigne le centre.
    const ics = (await calendarForToken(jetonDe(lienNantes)!))?.replace(/\r\n /g, '')
    assert.ok(ics?.includes('SUMMARY:Réunion à Nantes'))
    assert.ok(!ics?.includes('Réunion de cadrage'))
    assert.equal((await listResourceFeeds()).some((feed) => feed.id === SALLE_AUTRE), false)
  })
})
