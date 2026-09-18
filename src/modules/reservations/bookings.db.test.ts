import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'

/**
 * Vérifie ce que le code ne peut pas garantir : les contraintes de la base.
 *
 * Demande un Postgres jetable, jamais la base de développement — les migrations
 * y sont appliquées et les tables vidées entre les tests.
 *
 *   docker compose up -d
 *   createdb centre_affaires_test
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/centre_affaires_test npm test
 */
const url = process.env.TEST_DATABASE_URL

describe('contraintes de la table bookings', { skip: url ? false : 'TEST_DATABASE_URL non défini' }, () => {
  const client = postgres(url ?? '', { max: 1, prepare: false })
  const db = drizzle(client)

  const asTenant = async <T>(run: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${DEFAULT_TENANT_ID}, true)`)
      return run(tx)
    })

  const RESOURCE_ID = '01999f00-0000-7000-8000-0000000000a1'

  const book = (start: string, end: string, title = 'Réunion') =>
    asTenant((tx) =>
      tx.execute(sql`
        insert into bookings (resource_id, starts_at, ends_at, title)
        values (${RESOURCE_ID}, ${start}, ${end}, ${title})
      `),
    )

  /** SQLSTATE renvoyé par Postgres, pas un message traduisible. */
  const errorCode = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return (error as { code?: string }).code
    }
    return undefined
  }

  before(async () => {
    await migrate(db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await client`truncate table bookings, resources`
    await asTenant((tx) =>
      tx.execute(sql`
        insert into resources (id, resource_type, code, name, capacity)
        values (${RESOURCE_ID}, 'salle', 'S-101', 'Salle Europe', 8)
      `),
    )
  })

  after(async () => {
    await client.end()
  })

  it('accepte deux réservations jointives — bornes [)', async () => {
    await book('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z')
    await book('2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z')

    const rows = await asTenant((tx) => tx.execute(sql`select count(*)::int as n from bookings`))
    assert.equal(rows[0].n, 2)
  })

  it('refuse un chevauchement, quelle que soit la logique applicative', async () => {
    await book('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z')

    // 23P01 = exclusion_violation
    assert.equal(await errorCode(() => book('2026-10-01T09:30:00Z', '2026-10-01T10:30:00Z')), '23P01')
  })

  it('libère le créneau après annulation', async () => {
    await book('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z')
    await asTenant((tx) =>
      tx.execute(sql`update bookings set status = 'cancelled', cancelled_at = now()`),
    )

    await book('2026-10-01T09:30:00Z', '2026-10-01T10:30:00Z')
    const rows = await asTenant((tx) =>
      tx.execute(sql`select count(*)::int as n from bookings where status = 'confirmed'`),
    )
    assert.equal(rows[0].n, 1)
  })

  it('refuse un intervalle vide', async () => {
    // 23514 = check_violation
    assert.equal(await errorCode(() => book('2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z')), '23514')
  })

  it('refuse une annulation sans date d\'annulation', async () => {
    await book('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z')
    const code = await errorCode(() =>
      asTenant((tx) => tx.execute(sql`update bookings set status = 'cancelled'`)),
    )
    assert.equal(code, '23514')
  })

  it('attribue le centre unique et un identifiant ordonné', async () => {
    await book('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', 'Première')
    await book('2026-10-01T11:00:00Z', '2026-10-01T12:00:00Z', 'Seconde')

    const rows = await asTenant((tx) =>
      tx.execute(sql`select id, tenant_id, title from bookings order by id`),
    )
    assert.deepEqual(
      rows.map((r) => r.title),
      ['Première', 'Seconde'],
    )
    assert.equal(rows[0].tenant_id, DEFAULT_TENANT_ID)
    // Version 7 : 13e caractère hexadécimal de l'uuid.
    assert.equal(String(rows[0].id)[14], '7')
  })

  it('ne renvoie rien hors contexte de centre — RLS fermée par défaut', async () => {
    await book('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z')

    const sansContexte = await db.execute(sql`select count(*)::int as n from bookings`)
    assert.equal(sansContexte[0].n, 0)

    const avecContexte = await asTenant((tx) =>
      tx.execute(sql`select count(*)::int as n from bookings`),
    )
    assert.equal(avecContexte[0].n, 1)
  })

  it('refuse une réservation sur une ressource d\'un autre centre', async () => {
    const autreTenant = '01999f00-0000-7000-8000-0000000000ff'
    await client`insert into tenants (id, name, slug) values (${autreTenant}, 'Autre centre', 'autre-centre')`

    const code = await errorCode(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${autreTenant}, true)`)
        return tx.execute(sql`
          insert into bookings (resource_id, starts_at, ends_at, title)
          values (${RESOURCE_ID}, '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', 'Fuite')
        `)
      }),
    )
    // 23503 = foreign_key_violation : la ressource n'existe pas pour ce centre.
    assert.equal(code, '23503')
  })
})
