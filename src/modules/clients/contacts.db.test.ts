import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'

import { sql } from 'drizzle-orm'

import {
  DB_CHECK_VIOLATION,
  DB_FOREIGN_KEY_VIOLATION,
  DB_TENANT_MISMATCH,
  DB_UNIQUE_VIOLATION,
  dbErrorCode,
} from '../../db/errors.ts'
import { withClientScope, withTenant } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { lire, toutVider } from './test-support.ts'

/**
 * Contacts des entreprises clientes (R07) : contraintes et isolation, sous
 * l'identité applicative comme l'application les écrit.
 */
describe('contacts des clients', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const ACME = '01a00000-0000-7000-8000-0000000f0c01'
  const BETA = '01a00000-0000-7000-8000-0000000f0c02'
  const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000f4'
  /** Écriture sous portée client hors de ses entreprises (`30-clients.sql`). */
  const CLIENT_SCOPE_REFUSED = 'CA015'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1], tenant = DEFAULT_TENANT_ID) =>
    withTenant(tenant, run, bases.app.db)

  const errorCode = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  const contact = (
    clientId: string,
    fullName: string,
    { isPrimary = false, isBilling = false } = {},
    tenant = DEFAULT_TENANT_ID,
  ) => {
    const id = uuidv7()
    return asTenant(
      async (tx) => {
        await tx.execute(sql`
          insert into client_contacts (id, tenant_id, client_id, full_name, job_title, email, is_primary, is_billing)
          values (${id}, ${tenant}, ${clientId}, ${fullName}, 'Gérante', 'contact@exemple.fr', ${isPrimary}, ${isBilling})`)
        return id
      },
      tenant,
    )
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query('delete from tenants where id <> ?', [DEFAULT_TENANT_ID])
    await asTenant((tx) =>
      tx.execute(sql`insert into clients (id, name) values (${ACME}, 'Acme SAS'), (${BETA}, 'Beta SARL')`),
    )
  })

  after(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query('delete from tenants where id <> ?', [DEFAULT_TENANT_ID])
    await bases.fermer()
  })

  it('n’admet qu’un contact principal actif par entreprise', async () => {
    await contact(ACME, 'Alice Martin', { isPrimary: true })
    assert.equal(
      await errorCode(() => contact(ACME, 'Bruno Leroy', { isPrimary: true })),
      DB_UNIQUE_VIOLATION,
    )
    // Chaque entreprise a le sien.
    await contact(BETA, 'Chloé Petit', { isPrimary: true })
  })

  it('libère la place du principal quand il est archivé', async () => {
    await contact(ACME, 'Alice Martin', { isPrimary: true })
    await asTenant((tx) => tx.execute(sql`update client_contacts set deleted_at = now(3)`))
    await contact(ACME, 'Bruno Leroy', { isPrimary: true })
    const rows = await asTenant((tx) =>
      lire(tx, sql`select full_name from client_contacts where is_primary and deleted_at is null`),
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
      lire(
        tx,
        sql`select sum(is_billing) as facturation, count(*) as total from client_contacts`,
      ),
    )
    assert.deepEqual(
      { facturation: Number(row.facturation), total: Number(row.total) },
      { facturation: 2, total: 4 },
    )
  })

  it('refuse un contact sans nom', async () => {
    assert.equal(await errorCode(() => contact(ACME, '   ')), DB_CHECK_VIOLATION)
  })

  it('refuse le client d’un autre centre', async () => {
    await bases.owner.client.query(
      `insert into tenants (id, name, slug) values (?, 'Autre centre', 'autre-centre-contacts')`,
      [AUTRE_CENTRE],
    )
    assert.equal(
      await errorCode(() => contact(ACME, 'Fuite', {}, AUTRE_CENTRE)),
      DB_FOREIGN_KEY_VIOLATION,
    )
  })

  it('refuse d’écrire pour un autre centre que celui du contexte', async () => {
    await bases.owner.client.query(
      `insert into tenants (id, name, slug) values (?, 'Autre centre', 'autre-centre-contacts')`,
      [AUTRE_CENTRE],
    )
    // Garde `<table>_guard_tenant_insert` du migrateur : remplace le WITH CHECK de la RLS.
    assert.equal(
      await errorCode(() =>
        asTenant((tx) =>
          tx.execute(sql`
            insert into client_contacts (tenant_id, client_id, full_name)
            values (${AUTRE_CENTRE}, ${ACME}, 'Fuite')`),
        ),
      ),
      DB_TENANT_MISMATCH,
    )
  })

  it('sous la portée d’un client, n’écrit que les contacts de ses entreprises', async () => {
    const sousPortee = <T>(run: Parameters<typeof withClientScope<T>>[2]) =>
      withClientScope(DEFAULT_TENANT_ID, [ACME], run, bases.app.db)
    await sousPortee((tx) =>
      tx.execute(sql`insert into client_contacts (client_id, full_name) values (${ACME}, 'Chez Acme')`),
    )
    assert.equal(
      await errorCode(() =>
        sousPortee((tx) =>
          tx.execute(sql`insert into client_contacts (client_id, full_name) values (${BETA}, 'Chez Beta')`),
        ),
      ),
      CLIENT_SCOPE_REFUSED,
    )
    // Un contact de Beta, posé par le centre : ni modifiable ni supprimable depuis Acme.
    await contact(BETA, 'Chloé Petit')
    for (const ecriture of [
      sql`update client_contacts set phone = '0102030405' where client_id = ${BETA}`,
      sql`delete from client_contacts where client_id = ${BETA}`,
    ]) {
      assert.equal(await errorCode(() => sousPortee((tx) => tx.execute(ecriture))), CLIENT_SCOPE_REFUSED)
    }
    // Une portée vide ne laisse rien passer.
    assert.equal(
      await errorCode(() =>
        withClientScope(
          DEFAULT_TENANT_ID,
          [],
          (tx) => tx.execute(sql`insert into client_contacts (client_id, full_name) values (${ACME}, 'x')`),
          bases.app.db,
        ),
      ),
      CLIENT_SCOPE_REFUSED,
    )
  })

  it('date la modification sans que le code y pense', async () => {
    const id = await contact(ACME, 'Alice Martin')
    const [[avant]] = (await bases.owner.client.query('select updated_at from client_contacts')) as unknown as [
      { updated_at: Date }[],
    ]
    await pause(5)
    await asTenant((tx) =>
      tx.execute(sql`update client_contacts set phone = '01 02 03 04 05' where id = ${id}`),
    )
    const [[apres]] = (await bases.owner.client.query('select updated_at from client_contacts')) as unknown as [
      { updated_at: Date }[],
    ]
    assert.ok(apres.updated_at > avant.updated_at)
  })
})
