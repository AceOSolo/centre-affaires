import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import {
  DB_CHECK_VIOLATION,
  DB_EXCLUSION_VIOLATION,
  DB_FOREIGN_KEY_VIOLATION,
  DB_TENANT_MISMATCH,
  DB_UNIQUE_VIOLATION,
  dbErrorCode,
} from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { uuidv7 } from '../../lib/uuid.ts'

/**
 * Contraintes des tables de la tranche 2 : clients, grilles, contrats.
 *
 * Mêmes principes que `bookings.db.test.ts` — deux identités, celle du
 * propriétaire pour l'installation, celle de l'application pour tout ce qui
 * est éprouvé (ADR 003).
 */
describe('contraintes des clients, grilles et contrats', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const CLIENT_ID = '01a00000-0000-7000-8000-0000000000c1'
  const PLAN_ID = '01a00000-0000-7000-8000-0000000000b1'
  const OTHER_TENANT_ID = '01999f00-0000-7000-8000-0000000000fe'

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

  /** Nombre de lignes d'une requête `select count(*) as n …`. */
  const count = async (query: ReturnType<typeof sql>) => {
    const [rows] = (await asTenant((tx) => tx.execute(query))) as unknown as [{ n: number | string }[]]
    return Number(rows[0].n)
  }

  const createContract = (reference: string) =>
    asTenant((tx) =>
      tx.execute(sql`
        insert into contracts (client_id, reference, contract_type, starts_on, amount_cents)
        values (${CLIENT_ID}, ${reference}, 'domiciliation', '2026-03-01', 90000)
      `),
    )

  before(async () => {
    bases = await ouvrirBasesDeTest()
  })

  beforeEach(async () => {
    // Les tables sont liées entre elles : les vider ensemble, et la même
    // liste dans toutes les suites de base — sinon l'une laisse des lignes
    // que l'autre retrouve.
    await viderTables(
      bases.owner,
      'bookings',
      'contract_documents',
      'contract_amendments',
      'contract_lines',
      'contracts',
      'rate_plan_items',
      'rate_plans',
      'clients',
      'resources',
    )
    await bases.owner.client.query('delete from tenants where id <> ?', [DEFAULT_TENANT_ID])
    await asTenant((tx) =>
      tx.execute(sql`
        insert into clients (id, name, siret) values (${CLIENT_ID}, 'Acme SAS', '12345678900012')
      `),
    )
    await asTenant((tx) =>
      tx.execute(sql`
        insert into rate_plans (id, name, is_default) values (${PLAN_ID}, 'Tarifs publics', true)
      `),
    )
  })

  after(async () => {
    await bases.fermer()
  })

  describe('clients', () => {
    it('refuse deux fiches pour le même SIRET', async () => {
      const code = await errorCode(() =>
        asTenant((tx) =>
          tx.execute(sql`insert into clients (name, siret) values ('Acme bis', '12345678900012')`),
        ),
      )
      assert.equal(code, DB_UNIQUE_VIOLATION)
    })

    it('libère le SIRET après archivage', async () => {
      await asTenant((tx) => tx.execute(sql`update clients set deleted_at = current_timestamp(3)`))
      await asTenant((tx) =>
        tx.execute(sql`insert into clients (name, siret) values ('Acme repris', '12345678900012')`),
      )
      assert.equal(await count(sql`select count(*) as n from clients where siret = '12345678900012'`), 2)
    })

    it('accepte plusieurs clients sans SIRET', async () => {
      await asTenant((tx) => tx.execute(sql`insert into clients (name) values ('Étranger 1')`))
      await asTenant((tx) => tx.execute(sql`insert into clients (name) values ('Étranger 2')`))
      assert.equal(await count(sql`select count(*) as n from clients where siret is null`), 2)
    })
  })

  describe('grilles tarifaires', () => {
    it('n’admet qu’une grille par défaut un jour donné, plusieurs qui se suivent (ADR 035)', async () => {
      const code = await errorCode(() =>
        asTenant((tx) =>
          tx.execute(sql`insert into rate_plans (name, is_default) values ('Concurrente', true)`),
        ),
      )
      assert.equal(code, DB_EXCLUSION_VIOLATION)
      await asTenant((tx) =>
        tx.execute(sql`update rate_plans set valid_to = '2026-12-31' where id = ${PLAN_ID}`),
      )
      await asTenant((tx) =>
        tx.execute(sql`
          insert into rate_plans (name, is_default, valid_from) values ('Tarifs publics 2027', true, '2027-01-01')`),
      )
    })

    it('accepte autant de grilles non par défaut qu’on veut', async () => {
      await asTenant((tx) => tx.execute(sql`insert into rate_plans (name) values ('Grands comptes')`))
      await asTenant((tx) => tx.execute(sql`insert into rate_plans (name) values ('Associations')`))
      assert.equal(await count(sql`select count(*) as n from rate_plans`), 3)
    })

    it('refuse deux prix pour le même type et la même unité', async () => {
      const ligne = () =>
        asTenant((tx) =>
          tx.execute(sql`
            insert into rate_plan_items (rate_plan_id, resource_type, unit, amount_cents)
            values (${PLAN_ID}, 'salle', 'hour', 2500)
          `),
        )
      await ligne()
      assert.equal(await errorCode(ligne), DB_UNIQUE_VIOLATION)
    })

    it('laisse coexister le tarif de type et le tarif nominatif', async () => {
      const resourceId = uuidv7()
      await asTenant((tx) =>
        tx.execute(sql`
          insert into resources (id, resource_type, code, name)
          values (${resourceId}, 'salle', 'S-900', 'Salle test')
        `),
      )
      await asTenant((tx) =>
        tx.execute(sql`
          insert into rate_plan_items (rate_plan_id, resource_type, unit, amount_cents)
          values (${PLAN_ID}, 'salle', 'hour', 2500)
        `),
      )
      await asTenant((tx) =>
        tx.execute(sql`
          insert into rate_plan_items (rate_plan_id, resource_type, resource_id, unit, amount_cents)
          values (${PLAN_ID}, 'salle', ${resourceId}, 'hour', 4000)
        `),
      )
      assert.equal(await count(sql`select count(*) as n from rate_plan_items`), 2)
    })

    it('libère la place d’un prix retiré pour celui qui le remplace', async () => {
      // Le retrait est une suppression logique (décision 6) : l'unicité ne
      // porte que sur les prix encore en vigueur.
      const ligne = () =>
        asTenant((tx) =>
          tx.execute(sql`
            insert into rate_plan_items (rate_plan_id, resource_type, unit, amount_cents)
            values (${PLAN_ID}, 'salle', 'day', 13000)
          `),
        )
      await ligne()
      await asTenant((tx) => tx.execute(sql`update rate_plan_items set deleted_at = current_timestamp(3)`))
      await ligne()
      assert.equal(await errorCode(ligne), DB_UNIQUE_VIOLATION)
      assert.equal(await count(sql`select count(*) as n from rate_plan_items`), 2)
    })

    it('refuse un prix négatif', async () => {
      const code = await errorCode(() =>
        asTenant((tx) =>
          tx.execute(sql`
            insert into rate_plan_items (rate_plan_id, resource_type, unit, amount_cents)
            values (${PLAN_ID}, 'salle', 'hour', -100)
          `),
        ),
      )
      assert.equal(code, DB_CHECK_VIOLATION)
    })
  })

  describe('contrats', () => {
    it('refuse deux contrats sur la même référence', async () => {
      await createContract('DOM-2026-001')
      assert.equal(await errorCode(() => createContract('DOM-2026-001')), DB_UNIQUE_VIOLATION)
    })

    it('libère la référence d’un contrat archivé', async () => {
      // Index unique partiel de PostgreSQL, ici colonne générée `live`.
      await createContract('DOM-2026-001')
      await asTenant((tx) => tx.execute(sql`update contracts set deleted_at = current_timestamp(3)`))
      await createContract('DOM-2026-001')
      assert.equal(await count(sql`select count(*) as n from contracts`), 2)
    })

    it('refuse un terme antérieur au début', async () => {
      const code = await errorCode(() =>
        asTenant((tx) =>
          tx.execute(sql`
            insert into contracts (client_id, reference, contract_type, starts_on, ends_on, amount_cents)
            values (${CLIENT_ID}, 'DOM-2026-002', 'domiciliation', '2026-03-01', '2026-02-01', 90000)
          `),
        ),
      )
      assert.equal(code, DB_CHECK_VIOLATION)
    })

    it('refuse un montant négatif', async () => {
      const code = await errorCode(() =>
        asTenant((tx) =>
          tx.execute(sql`
            insert into contracts (client_id, reference, contract_type, starts_on, amount_cents)
            values (${CLIENT_ID}, 'DOM-2026-003', 'domiciliation', '2026-03-01', -1)
          `),
        ),
      )
      assert.equal(code, DB_CHECK_VIOLATION)
    })

    it('refuse une résiliation sans date', async () => {
      await createContract('DOM-2026-004')
      const code = await errorCode(() =>
        asTenant((tx) => tx.execute(sql`update contracts set status = 'terminated'`)),
      )
      assert.equal(code, DB_CHECK_VIOLATION)
    })

    it('refuse une date de résiliation sur un contrat en cours', async () => {
      await createContract('DOM-2026-005')
      const code = await errorCode(() =>
        asTenant((tx) => tx.execute(sql`update contracts set terminated_on = '2026-06-30'`)),
      )
      assert.equal(code, DB_CHECK_VIOLATION)
    })

    it('accepte la résiliation quand l’état et la date vont ensemble', async () => {
      await createContract('DOM-2026-006')
      await asTenant((tx) =>
        tx.execute(sql`update contracts set status = 'terminated', terminated_on = '2026-06-30'`),
      )
      const [rows] = (await asTenant((tx) =>
        tx.execute(sql`select status, cast(terminated_on as char) as terminated_on from contracts`),
      )) as unknown as [{ status: string; terminated_on: string }[]]
      assert.equal(rows[0].status, 'terminated')
      assert.equal(rows[0].terminated_on, '2026-06-30')
    })

    it('refuse un contrat sur le client d’un autre centre', async () => {
      await bases.owner.client.query('insert into tenants (id, name, slug) values (?, ?, ?)', [
        OTHER_TENANT_ID,
        'Autre centre',
        'autre-centre-2',
      ])

      // La clé étrangère composite (tenant_id, client_id) : le client n'existe
      // pas dans cet autre centre.
      const code = await errorCode(() =>
        asTenant(
          (tx) =>
            tx.execute(sql`
              insert into contracts (tenant_id, client_id, reference, contract_type, starts_on, amount_cents)
              values (${OTHER_TENANT_ID}, ${CLIENT_ID}, 'FUITE-001', 'domiciliation', '2026-03-01', 90000)
            `),
          OTHER_TENANT_ID,
        ),
      )
      assert.equal(code, DB_FOREIGN_KEY_VIOLATION)
    })
  })

  describe('isolation par centre', () => {
    it('refuse d’écrire une ligne d’un autre centre que celui du contexte', async () => {
      // Remplace le `WITH CHECK` des politiques RLS : les triggers
      // `<table>_guard_tenant_*` posés par le migrateur (CA014).
      await bases.owner.client.query('insert into tenants (id, name, slug) values (?, ?, ?)', [
        OTHER_TENANT_ID,
        'Autre centre',
        'autre-centre-2',
      ])
      const code = await errorCode(() =>
        asTenant(
          (tx) =>
            tx.execute(sql`
              insert into contracts (tenant_id, client_id, reference, contract_type, starts_on, amount_cents)
              values (${DEFAULT_TENANT_ID}, ${CLIENT_ID}, 'FUITE-002', 'domiciliation', '2026-03-01', 90000)
            `),
          OTHER_TENANT_ID,
        ),
      )
      assert.equal(code, DB_TENANT_MISMATCH)
    })

    it('garde chaque table du module par ses triggers de centre', async () => {
      const tables = [
        'contracts',
        'contract_lines',
        'contract_amendments',
        'contract_documents',
        'contract_renewals',
        'offer_requests',
      ]
      const [rows] = (await bases.owner.client.query(
        `select trigger_name as name from information_schema.triggers
          where trigger_schema = database() and trigger_name like '%\\_guard\\_tenant\\_%'`,
      )) as unknown as [{ name: string }[]]
      const present = new Set(rows.map((row) => row.name))
      for (const table of tables) {
        assert.ok(present.has(`${table}_guard_tenant_insert`), `${table} : insert non gardé`)
        assert.ok(present.has(`${table}_guard_tenant_update`), `${table} : update non gardé`)
      }
    })
  })
})
