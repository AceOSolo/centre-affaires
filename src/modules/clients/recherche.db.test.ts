import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { listClients } from './queries.ts'
import { searchClients } from './recherche.ts'

/**
 * Recherche dans la liste des clients (R07) : raison sociale, SIRET, nom d'un
 * contact, combinée au filtre par statut. Contre la base, sous `app_centre`.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('recherche de clients', { skip: raison }, () => {
  // Les requêtes du module ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const ACME = '01a00000-0000-7000-8000-0000000e5a01'
  const BETA = '01a00000-0000-7000-8000-0000000e5a02'
  const GAMMA = '01a00000-0000-7000-8000-0000000e5a03'
  const ARCHIVE = '01a00000-0000-7000-8000-0000000e5a04'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  const names = (rows: { name: string }[]) => rows.map((row) => row.name)

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources cascade`
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (id, name, siret, city, status, deleted_at) values
          (${ACME}, 'Acme SAS', '12345678900012', 'Lyon', 'active', null),
          (${BETA}, 'Beta 100% Conseil', '98765432100034', 'Paris', 'prospect', null),
          (${GAMMA}, 'Gamma Immobilier', null, 'Lyon', 'inactive', null),
          (${ARCHIVE}, 'Acme Ancienne', '11122233300045', 'Lyon', 'inactive', now())`)
      await tx.execute(sql`
        insert into client_contacts (client_id, full_name, job_title, email, is_primary, deleted_at) values
          (${ACME}, 'Alice Martin', 'Gérante', 'alice@acme.fr', true, null),
          (${ACME}, 'Bruno Leroy', 'Comptable', null, false, null),
          (${BETA}, 'Chloé Martinez', null, null, false, null),
          (${GAMMA}, 'Denis Martel', null, null, false, now()),
          (${ARCHIVE}, 'Alice Martin', null, null, true, null)`)
    })
  })

  after(async () => {
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  it('liste toutes les fiches vivantes sans recherche, par raison sociale', async () => {
    assert.deepEqual(names(await searchClients()), ['Acme SAS', 'Beta 100% Conseil', 'Gamma Immobilier'])
  })

  it('trouve par raison sociale, sans tenir compte de la casse', async () => {
    assert.deepEqual(names(await searchClients({ search: 'aCmE' })), ['Acme SAS'])
  })

  it('trouve par SIRET, saisi d’un bloc ou par groupes', async () => {
    assert.deepEqual(names(await searchClients({ search: '12345678900012' })), ['Acme SAS'])
    assert.deepEqual(names(await searchClients({ search: '987 654 321' })), ['Beta 100% Conseil'])
  })

  it('trouve par nom de contact, et dit lequel correspond', async () => {
    const rows = await searchClients({ search: 'leroy' })
    assert.deepEqual(names(rows), ['Acme SAS'])
    assert.equal(rows[0].matchedContactNames, 'Bruno Leroy')

    // « mart » : Alice Martin chez Acme, Chloé Martinez chez Beta.
    const both = await searchClients({ search: 'mart' })
    assert.deepEqual(names(both), ['Acme SAS', 'Beta 100% Conseil'])
    assert.deepEqual(
      both.map((row) => row.matchedContactNames),
      ['Alice Martin', 'Chloé Martinez'],
    )
  })

  it('ne trouve plus une fiche par un contact retiré', async () => {
    assert.deepEqual(names(await searchClients({ search: 'Martel' })), [])
  })

  it('ne remonte jamais une fiche archivée', async () => {
    // « Acme Ancienne » a le nom, le SIRET et un contact qui correspondent.
    assert.deepEqual(names(await searchClients({ search: 'Ancienne' })), [])
    assert.deepEqual(names(await searchClients({ search: '111222333' })), [])
    assert.deepEqual(names(await searchClients({ search: 'Alice' })), ['Acme SAS'])
  })

  it('combine la recherche et le filtre par statut', async () => {
    assert.deepEqual(names(await searchClients({ search: 'Lyon' })), ['Acme SAS', 'Gamma Immobilier'])
    assert.deepEqual(names(await searchClients({ search: 'Lyon', status: 'inactive' })), [
      'Gamma Immobilier',
    ])
    assert.deepEqual(names(await searchClients({ status: 'prospect' })), ['Beta 100% Conseil'])
  })

  it('prend un % saisi au pied de la lettre', async () => {
    assert.deepEqual(names(await searchClients({ search: '100%' })), ['Beta 100% Conseil'])
    assert.deepEqual(names(await searchClients({ search: '%' })), ['Beta 100% Conseil'])
  })

  it('rend le contact principal de chaque fiche, sans dupliquer de ligne', async () => {
    const rows = await searchClients()
    assert.equal(rows.length, 3)
    assert.deepEqual(
      rows.map((row) => row.primaryContact?.fullName ?? null),
      ['Alice Martin', null, null],
    )
    assert.equal(rows[0].primaryContact?.jobTitle, 'Gérante')
    assert.equal(rows[0].matchedContactNames, null)
  })

  it('partage la même recherche avec listClients', async () => {
    assert.deepEqual(names(await listClients({ search: 'leroy' })), ['Acme SAS'])
    assert.deepEqual(names(await listClients({ search: '987 654 321' })), ['Beta 100% Conseil'])
  })
})
