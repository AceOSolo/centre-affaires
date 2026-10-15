import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { listClients } from './queries.ts'
import { searchClients } from './recherche.ts'
import { toutVider } from './test-support.ts'

/**
 * Recherche dans la liste des clients (R07) : raison sociale, SIRET, nom d'un
 * contact, combinée au filtre par statut. Contre la base, sous l'identité
 * applicative. La collation de la base (`utf8mb4_0900_as_ci`) est insensible à
 * la casse et sensible aux accents : `like` fait ce que faisait `ilike`.
 */
describe('recherche de clients', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const ACME = '01a00000-0000-7000-8000-0000000e5a01'
  const BETA = '01a00000-0000-7000-8000-0000000e5a02'
  const GAMMA = '01a00000-0000-7000-8000-0000000e5a03'
  const ARCHIVE = '01a00000-0000-7000-8000-0000000e5a04'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const names = (rows: { name: string }[]) => rows.map((row) => row.name)

  before(async () => {
    bases = await ouvrirBasesDeTest()
    // Les requêtes du module passent par la base du processus : celle des tests.
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (id, name, siret, city, status, deleted_at) values
          (${ACME}, 'Acme SAS', '12345678900012', 'Lyon', 'active', null),
          (${BETA}, 'Beta 100% Conseil', '98765432100034', 'Paris', 'prospect', null),
          (${GAMMA}, 'Gamma Immobilier', null, 'Lyon', 'inactive', null),
          (${ARCHIVE}, 'Acme Ancienne', '11122233300045', 'Lyon', 'inactive', now(3))`)
      await tx.execute(sql`
        insert into client_contacts (client_id, full_name, job_title, email, is_primary, deleted_at) values
          (${ACME}, 'Alice Martin', 'Gérante', 'alice@acme.fr', true, null),
          (${ACME}, 'Bruno Leroy', 'Comptable', null, false, null),
          (${BETA}, 'Chloé Martinez', null, null, false, null),
          (${GAMMA}, 'Denis Martel', null, null, false, now(3)),
          (${ARCHIVE}, 'Alice Martin', null, null, true, null)`)
    })
  })

  after(async () => {
    await toutVider(bases.owner)
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
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
