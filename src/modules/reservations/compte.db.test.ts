import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { cancelRequestForAccounts, listBookingsForAccounts } from './compte-queries.ts'

/**
 * Réservations vues depuis l'espace client (ADR 015), contre la base : une
 * entreprise ne voit ni n'annule les réservations d'une autre.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('réservations de l’espace client', { skip: raison }, () => {
  // Les requêtes ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const SALLE = '01a00000-0000-7000-8000-00000000e5a1'
  const DURAND = '01a00000-0000-7000-8000-00000000e5c1'
  const PETIT = '01a00000-0000-7000-8000-00000000e5c2'
  const JEANNE = '01a00000-0000-7000-8000-00000000e5d1'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  /** Réservation qui commence dans `jours` jours (négatif : passée). */
  const reserver = async (
    clientId: string | null,
    jours: number,
    { status = 'confirmed', kind = 'booking' } = {},
  ): Promise<string> => {
    const [row] = await asTenant((tx) =>
      tx.execute(sql`
        insert into bookings (resource_id, client_id, kind, channel, status, title, starts_at, ends_at)
        values (${SALLE}, ${clientId}, ${kind}, 'staff', ${status}, 'Réunion',
                now() + make_interval(days => ${jours}),
                now() + make_interval(days => ${jours}, hours => 1))
        returning id`),
    )
    return row.id as string
  }

  const statut = async (id: string) => {
    const [row] = await asTenant((tx) => tx.execute(sql`select status from bookings where id = ${id}`))
    return row.status
  }

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, clients, resources cascade`
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values (${SALLE}, 'salle', 'S-CPT', 'Salle Europe')`)
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Boulangerie Petit', 'active')`)
    })
  })

  after(async () => {
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  it('ne montre que les réservations des entreprises du compte', async () => {
    const sienne = await reserver(DURAND, 3)
    await reserver(PETIT, 4)
    await reserver(null, 5)
    const rows = await listBookingsForAccounts(durand)
    assert.deepEqual(
      rows.map((row) => row.id),
      [sienne],
    )
    assert.equal(rows[0].resourceName, 'Salle Europe')
  })

  it('ne montre pas les indisponibilités', async () => {
    await reserver(DURAND, 3, { kind: 'unavailability' })
    assert.deepEqual(await listBookingsForAccounts(durand), [])
  })

  it('laisse annuler une demande en attente, à venir', async () => {
    const id = await reserver(DURAND, 3, { status: 'pending' })
    assert.equal(await cancelRequestForAccounts(id, durand), true)
    assert.equal(await statut(id), 'cancelled')
  })

  it('refuse d’annuler une réservation confirmée', async () => {
    const id = await reserver(DURAND, 3)
    assert.equal(await cancelRequestForAccounts(id, durand), false)
    assert.equal(await statut(id), 'confirmed')
  })

  it('refuse d’annuler une demande passée', async () => {
    const id = await reserver(DURAND, -2, { status: 'pending' })
    assert.equal(await cancelRequestForAccounts(id, durand), false)
  })

  it('refuse d’annuler la demande d’une autre entreprise', async () => {
    const id = await reserver(PETIT, 3, { status: 'pending' })
    assert.equal(await cancelRequestForAccounts(id, durand), false)
    assert.equal(await statut(id), 'pending')
  })

  it('libère le créneau à l’annulation', async () => {
    // La contrainte d'exclusion ne compte plus la demande annulée : le même
    // créneau se réserve de nouveau (décision 3).
    const id = await reserver(DURAND, 3, { status: 'pending' })
    await cancelRequestForAccounts(id, durand)
    await assert.doesNotReject(reserver(PETIT, 3))
  })
})
