import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { cancelFutureSeries, insertBookingSeries, type BulkBookingInput } from './bulk-queries.ts'
import { bookings } from './schema.ts'

const ownerUrl = process.env.TEST_OWNER_DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

describe('création et annulation atomiques des séries', { skip: !ownerUrl || !appUrl ? 'Base de test jetable non configurée' : false }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')
  const resourceId = '01999f00-0000-7000-8000-0000000000b1'
  const otherResourceId = '01999f00-0000-7000-8000-0000000000b2'
  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) => withTenant(DEFAULT_TENANT_ID, run, app.db)
  const input = (overrides: Partial<BulkBookingInput> = {}): BulkBookingInput => ({
    resourceIds: [resourceId], kind: 'booking', title: 'Série test', startsOn: '2090-01-02', endsOn: '2090-01-15',
    slots: [{ weekdays: [1], startTime: '09:00', endTime: '10:00' }], ...overrides,
  })

  before(async () => { await migrate(owner.db, { migrationsFolder: './src/db/migrations' }) })
  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources cascade`
    await asTenant((tx) => tx.execute(sql`insert into resources (id, resource_type, code, name) values
      (${resourceId}, 'salle', 'S-BULK-1', 'Salle 1'), (${otherResourceId}, 'salle', 'S-BULK-2', 'Salle 2')`))
  })
  after(async () => { await Promise.all([owner.client.end(), app.client.end()]) })

  it('crée toutes les occurrences sur plusieurs ressources et les lie à une seule série', async () => {
    const result = await asTenant((tx) => insertBookingSeries(tx, input({ resourceIds: [resourceId, otherResourceId] }), 'Europe/Paris'))
    const rows = await asTenant((tx) => tx.select().from(bookings))
    assert.equal(result.count, 4)
    assert.equal(rows.length, 4)
    assert.ok(rows.every((row) => row.seriesId === result.seriesId && row.status === 'confirmed'))
  })
  it('refuse tout le lot si une seule occurrence est déjà occupée', async () => {
    await asTenant((tx) => tx.insert(bookings).values({ resourceId, startsAt: new Date('2090-01-09T08:00:00Z'), endsAt: new Date('2090-01-09T09:00:00Z'), title: 'Occupée' }))
    await assert.rejects(asTenant((tx) => insertBookingSeries(tx, input(), 'Europe/Paris')))
    const rows = await asTenant((tx) => tx.select().from(bookings))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].title, 'Occupée')
  })
  it('départage deux lots concurrents sans insertion partielle', async () => {
    const results = await Promise.allSettled([
      asTenant((tx) => insertBookingSeries(tx, input(), 'Europe/Paris')),
      asTenant((tx) => insertBookingSeries(tx, input(), 'Europe/Paris')),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal((await asTenant((tx) => tx.select().from(bookings))).length, 2)
  })
  it('les indisponibilités empêchent aussi une réservation ordinaire', async () => {
    await asTenant((tx) => insertBookingSeries(tx, input({ kind: 'unavailability', title: 'Entretien' }), 'Europe/Paris'))
    await assert.rejects(asTenant((tx) => tx.insert(bookings).values({ resourceId, startsAt: new Date('2090-01-09T08:30:00Z'), endsAt: new Date('2090-01-09T09:30:00Z'), title: 'Impossible' })))
  })
  it('annule seulement les occurrences futures de la série et libère leurs créneaux', async () => {
    const series = await asTenant((tx) => insertBookingSeries(tx, input(), 'Europe/Paris'))
    await asTenant((tx) => tx.insert(bookings).values({ resourceId, seriesId: series.seriesId, startsAt: new Date('2000-01-01T08:00:00Z'), endsAt: new Date('2000-01-01T09:00:00Z'), title: 'Passée' }))
    assert.equal((await asTenant((tx) => cancelFutureSeries(tx, series.seriesId))).length, 2)
    const rows = await asTenant((tx) => tx.select().from(bookings))
    assert.equal(rows.find((row) => row.title === 'Passée')?.status, 'confirmed')
    assert.equal(rows.filter((row) => row.status === 'cancelled').length, 2)
    await asTenant((tx) => insertBookingSeries(tx, input(), 'Europe/Paris'))
  })
  it('refuse les ressources absentes du centre et les lots dépassant la limite totale', async () => {
    await assert.rejects(asTenant((tx) => insertBookingSeries(tx, input({ resourceIds: ['01999f00-0000-7000-8000-0000000000ff'] }), 'Europe/Paris')))
    await assert.rejects(asTenant((tx) => insertBookingSeries(tx, input({ resourceIds: [resourceId, otherResourceId], endsOn: '2091-01-01', slots: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], startTime: '09:00', endTime: '10:00' }] }), 'Europe/Paris')), /500/)
    assert.equal((await asTenant((tx) => tx.select().from(bookings))).length, 0)
  })
})
