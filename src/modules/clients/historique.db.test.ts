import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { listClientBookingHistory } from './historique.ts'

/**
 * Historique des réservations sur la fiche client (R07), contre la base et
 * sous `app_centre`.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('historique des réservations d’un client', { skip: raison }, () => {
  // Les requêtes du module ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const SALLE = '01a00000-0000-7000-8000-0000000d1a01'
  const SALON = '01a00000-0000-7000-8000-0000000d1a02'
  const BUREAU = '01a00000-0000-7000-8000-0000000d1a03'
  const DURAND = '01a00000-0000-7000-8000-0000000d1c01'
  const PETIT = '01a00000-0000-7000-8000-0000000d1c02'

  /** L'instant présent des tests : le jeudi 15 octobre 2026 à 10h00 UTC. */
  const NOW = new Date('2026-10-15T10:00:00Z')

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  const reserver = (
    title: string,
    startsAt: string,
    endsAt: string,
    { clientId = DURAND as string | null, resourceId = SALLE, status = 'confirmed' } = {},
  ) =>
    asTenant((tx) =>
      tx.execute(sql`
        insert into bookings (resource_id, client_id, channel, status, cancelled_at, title, starts_at, ends_at)
        values (${resourceId}, ${clientId}, 'staff', ${status},
                ${status === 'cancelled' ? sql`now()` : sql`null`},
                ${title}, ${startsAt}, ${endsAt})`),
    )

  const titles = (rows: { title: string }[]) => rows.map((row) => row.title)

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources cascade`
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${SALLE}, 'salle', 'S-HIS', 'Salle Europe'),
          (${SALON}, 'salle', 'S-HIS2', 'Salon Atlas'),
          (${BUREAU}, 'bureau', 'B-HIS', 'Bureau 12')`)
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Boulangerie Petit', 'active')`)
    })

    await reserver('Bilan annuel', '2026-10-01T07:00:00Z', '2026-10-01T09:00:00Z')
    await reserver('Formation', '2026-10-10T07:00:00Z', '2026-10-10T09:00:00Z', { status: 'cancelled' })
    await reserver('Comité', '2026-10-14T07:00:00Z', '2026-10-14T09:00:00Z')
    // Finit pile à l'instant présent : passée, en `[)` comme la contrainte.
    await reserver('Point d’équipe', '2026-10-15T09:00:00Z', '2026-10-15T10:00:00Z')
    // Commencée, pas finie : elle compte encore, avec ce qui vient.
    await reserver('Atelier', '2026-10-15T09:30:00Z', '2026-10-15T11:00:00Z', { resourceId: SALON })
    await reserver('Entretiens', '2026-10-20T07:00:00Z', '2026-10-20T09:00:00Z', { status: 'pending' })
    await reserver('Recrutement', '2026-10-16T07:00:00Z', '2026-10-16T09:00:00Z')

    // Ni l'autre client, ni la réservation sans client.
    await reserver('Dégustation', '2026-10-18T07:00:00Z', '2026-10-18T09:00:00Z', { clientId: PETIT })
    await reserver('Réunion interne', '2026-10-19T07:00:00Z', '2026-10-19T09:00:00Z', { clientId: null })
  })

  after(async () => {
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  it('sépare l’à venir du passé, dans l’ordre où on les lit', async () => {
    const history = await listClientBookingHistory(DURAND, { now: NOW })

    assert.deepEqual(titles(history.upcoming), ['Atelier', 'Recrutement', 'Entretiens'])
    assert.deepEqual(titles(history.past), ['Point d’équipe', 'Comité', 'Formation', 'Bilan annuel'])
    assert.equal(history.upcomingTotal, 3)
    assert.equal(history.pastTotal, 4)
  })

  it('garde les annulées et les demandes, avec leur état', async () => {
    const history = await listClientBookingHistory(DURAND, { now: NOW })
    const statuses = Object.fromEntries(
      [...history.upcoming, ...history.past].map((row) => [row.title, row.status]),
    )
    assert.equal(statuses['Formation'], 'cancelled')
    assert.equal(statuses['Entretiens'], 'pending')
    assert.equal(statuses['Comité'], 'confirmed')
  })

  it('nomme la ressource de chaque réservation', async () => {
    const history = await listClientBookingHistory(DURAND, { now: NOW })
    const atelier = history.upcoming.find((row) => row.title === 'Atelier')
    assert.equal(atelier?.resourceName, 'Salon Atlas')
    assert.equal(atelier?.resourceCode, 'S-HIS2')
  })

  it('borne les listes sans fausser les totaux', async () => {
    const history = await listClientBookingHistory(DURAND, { now: NOW, pastLimit: 2, upcomingLimit: 1 })

    assert.deepEqual(titles(history.past), ['Point d’équipe', 'Comité'])
    assert.deepEqual(titles(history.upcoming), ['Atelier'])
    assert.equal(history.pastTotal, 4)
    assert.equal(history.upcomingTotal, 3)
  })

  it('laisse de côté l’occupation d’un contrat, déjà montrée avec les contrats', async () => {
    await asTenant((tx) =>
      tx.execute(sql`
        insert into contracts (client_id, contract_type, status, starts_on, amount_cents, resource_id)
        values (${DURAND}, 'bureau', 'active', '2026-09-01', 45000, ${BUREAU})`),
    )
    // Le contrat occupe bien son bureau au nom du client (ADR 018)…
    const [occupation] = await owner.client`
      select count(*)::int as n from bookings where kind = 'contract' and client_id = ${DURAND}`
    assert.equal(occupation.n, 1)

    // … mais l'historique des réservations ne le répète pas.
    const history = await listClientBookingHistory(DURAND, { now: NOW })
    assert.equal(history.upcomingTotal, 3)
    assert.ok(!titles(history.upcoming).some((title) => title.startsWith('Contrat')))
  })

  it('ne rend rien pour un client sans réservation', async () => {
    await owner.client`delete from bookings where client_id = ${PETIT}`
    assert.deepEqual(await listClientBookingHistory(PETIT, { now: NOW }), {
      upcoming: [],
      upcomingTotal: 0,
      past: [],
      pastTotal: 0,
    })
  })
})
