import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import {
  PG_CHECK_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
} from '../../db/errors.ts'
import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'

/**
 * Contacts des entreprises clientes (R07) : contraintes et isolation, sous
 * `app_centre` comme l'application les écrit.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('contacts des clients', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const ACME = '01a00000-0000-7000-8000-0000000f0c01'
  const BETA = '01a00000-0000-7000-8000-0000000f0c02'
  const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000f4'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1], tenant = DEFAULT_TENANT_ID) =>
    withTenant(tenant, run, app.db)

  const errorCode = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return pgErrorCode(error)
    }
    return undefined
  }

  const contact = (
    clientId: string,
    fullName: string,
    { isPrimary = false, isBilling = false } = {},
    tenant = DEFAULT_TENANT_ID,
  ) =>
    asTenant(
      (tx) =>
        tx.execute(sql`
          insert into client_contacts (client_id, full_name, job_title, email, is_primary, is_billing)
          values (${clientId}, ${fullName}, 'Gérante', 'contact@exemple.fr', ${isPrimary}, ${isBilling})
          returning id`),
      tenant,
    )

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources cascade`
    await owner.client`delete from tenants where id <> ${DEFAULT_TENANT_ID}`
    await asTenant((tx) =>
      tx.execute(sql`insert into clients (id, name) values (${ACME}, 'Acme SAS'), (${BETA}, 'Beta SARL')`),
    )
  })

  after(async () => {
    await Promise.all([owner.client.end(), app.client.end()])
  })

  it('n’admet qu’un contact principal actif par entreprise', async () => {
    await contact(ACME, 'Alice Martin', { isPrimary: true })
    assert.equal(
      await errorCode(() => contact(ACME, 'Bruno Leroy', { isPrimary: true })),
      PG_UNIQUE_VIOLATION,
    )
    // Chaque entreprise a le sien.
    await contact(BETA, 'Chloé Petit', { isPrimary: true })
  })

  it('libère la place du principal quand il est archivé', async () => {
    await contact(ACME, 'Alice Martin', { isPrimary: true })
    await asTenant((tx) => tx.execute(sql`update client_contacts set deleted_at = now()`))
    await contact(ACME, 'Bruno Leroy', { isPrimary: true })
    const rows = await asTenant((tx) =>
      tx.execute(sql`select full_name from client_contacts where is_primary and deleted_at is null`),
    )
    assert.deepEqual(
      rows.map((row) => row.full_name),
      ['Bruno Leroy'],
    )
  })

  it('accepte plusieurs destinataires des factures et des contacts ordinaires', async () => {
    await contact(ACME, 'Alice Martin', { isPrimary: true, isBilling: true })
    await contact(ACME, 'Cabinet Comptable', { isBilling: true })
    await contact(ACME, 'Dominique Roy')
    await contact(ACME, 'Eva Roy')
    const [row] = await asTenant((tx) =>
      tx.execute(sql`select count(*) filter (where is_billing)::int as facturation,
                            count(*)::int as total from client_contacts`),
    )
    assert.deepEqual({ ...row }, { facturation: 2, total: 4 })
  })

  it('refuse un contact sans nom', async () => {
    assert.equal(await errorCode(() => contact(ACME, '   ')), PG_CHECK_VIOLATION)
  })

  it('refuse le client d’un autre centre', async () => {
    await owner.client`
      insert into tenants (id, name, slug) values (${AUTRE_CENTRE}, 'Autre centre', 'autre-centre-contacts')`
    assert.equal(
      await errorCode(() => contact(ACME, 'Fuite', {}, AUTRE_CENTRE)),
      PG_FOREIGN_KEY_VIOLATION,
    )
  })

  it('ne renvoie rien hors contexte de centre', async () => {
    await contact(ACME, 'Alice Martin')
    const rows = await app.db.execute(sql`select count(*)::int as n from client_contacts`)
    assert.equal(rows[0].n, 0)
  })

  it('date la modification sans que le code y pense', async () => {
    const [cree] = await contact(ACME, 'Alice Martin')
    const [avant] = await owner.client`select updated_at from client_contacts`
    await asTenant((tx) =>
      tx.execute(sql`update client_contacts set phone = '01 02 03 04 05' where id = ${cree.id as string}`),
    )
    const [apres] = await owner.client`select updated_at from client_contacts`
    assert.ok(apres.updated_at > avant.updated_at)
  })
})
