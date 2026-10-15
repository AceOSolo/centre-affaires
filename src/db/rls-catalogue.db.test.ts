import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { uuidv7 } from '../lib/uuid.ts'
import { DB_INSUFFICIENT_PRIVILEGE, DB_TENANT_MISMATCH, dbErrorCode } from './errors.ts'
import { withTenant } from './index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from './test-support.ts'
import { DEFAULT_TENANT_ID } from './tenants.ts'

/**
 * Le catalogue de la base tient les règles d'isolation pour toute table,
 * présente ou à venir — une table oubliée échoue ici, avant d'exposer un
 * centre à un autre.
 *
 * Il n'y a plus de Row Level Security (ADR 042) : la base ne protège plus que
 * les écritures, par des triggers que génère le migrateur
 * (`<table>_guard_tenant_insert` / `_update`, `CA014`).
 *
 * - toute table qui porte `tenant_id` a ses deux triggers de garde ;
 * - une écriture sous le contexte d'un autre centre est refusée ;
 * - les compteurs de numérotation ne s'écrivent pas depuis l'application.
 */
describe('catalogue : isolation par centre', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  before(async () => {
    bases = await ouvrirBasesDeTest()
  })

  after(async () => {
    await bases.fermer()
  })

  const lignes = async <T>(requete: string, params: unknown[] = []) =>
    ((await bases.owner.client.query(requete, params)) as unknown as [T[]])[0]

  const code = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  it('pose les deux triggers de garde sur toute table qui porte tenant_id', async () => {
    const tables = await lignes<{ nom: string }>(
      `select c.table_name as nom
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = database() and c.column_name = 'tenant_id'
          and t.table_type = 'BASE TABLE'
        order by c.table_name`,
    )
    assert.ok(tables.length > 30, `${tables.length} tables seulement`)
    const triggers = new Set(
      (
        await lignes<{ nom: string }>(
          `select trigger_name as nom from information_schema.triggers where trigger_schema = database()`,
        )
      ).map((row) => row.nom),
    )
    const manquants: string[] = []
    for (const { nom } of tables) {
      for (const evenement of ['insert', 'update']) {
        const trigger = `${nom}_guard_tenant_${evenement}`
        if (!triggers.has(trigger)) manquants.push(trigger)
      }
    }
    assert.deepEqual(manquants, [])
  })

  it('refuse d’écrire, ou de déplacer une ligne, pour un autre centre', async () => {
    const autre = '01999f00-0000-7000-8000-0000000000fd'
    await bases.owner.client.query(
      `insert into tenants (id, name, slug) values (?, 'Centre de passage', 'centre-de-passage')
       on duplicate key update id = id`,
      [autre],
    )
    const id = uuidv7()
    try {
      const refuse = await code(() =>
        withTenant(
          DEFAULT_TENANT_ID,
          (tx) =>
            tx.execute(sql`
              insert into staff_members (id, tenant_id, email)
              values (${uuidv7()}, ${autre}, 'intrus@exemple.fr')`),
          bases.app.db,
        ),
      )
      assert.equal(refuse, DB_TENANT_MISMATCH)

      await withTenant(
        DEFAULT_TENANT_ID,
        (tx) =>
          tx.execute(sql`insert into staff_members (id, email) values (${id}, 'garde@exemple.fr')`),
        bases.app.db,
      )
      const deplace = await code(() =>
        withTenant(
          DEFAULT_TENANT_ID,
          (tx) => tx.execute(sql`update staff_members set tenant_id = ${autre} where id = ${id}`),
          bases.app.db,
        ),
      )
      assert.equal(deplace, DB_TENANT_MISMATCH)
    } finally {
      await bases.owner.client.query('delete from staff_members where id = ?', [id])
      await bases.owner.client.query('delete from tenants where id = ?', [autre])
    }
  })

  it('ne laisse pas l’identité applicative écrire les compteurs de numérotation', async (t) => {
    if (!process.env.TEST_DB_USER) {
      t.skip('TEST_DB_USER non défini : l’identité applicative est le propriétaire')
      return
    }
    for (const requete of [
      sql`insert into document_sequences (id, tenant_id, document_type, year, last_value)
          values (${uuidv7()}, ${DEFAULT_TENANT_ID}, 'invoice', 2026, 41)`,
      sql`update document_sequences set last_value = 0`,
      sql`delete from document_sequences`,
    ]) {
      const refuse = await code(() =>
        withTenant(DEFAULT_TENANT_ID, (tx) => tx.execute(requete), bases.app.db),
      )
      assert.equal(refuse, DB_INSUFFICIENT_PRIVILEGE)
    }
  })
})
