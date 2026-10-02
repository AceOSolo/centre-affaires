import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import {
  PG_CHECK_VIOLATION,
  PG_EXCLUSION_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
} from '../../db/errors.ts'
import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'

/**
 * Contraintes des tables de la tranche 2 : clients, grilles, contrats.
 *
 * Mêmes principes que `bookings.db.test.ts` — deux connexions, celle du
 * propriétaire pour l'installation, celle de `app_centre` pour tout ce qui est
 * éprouvé (ADR 003).
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('contraintes des clients, grilles et contrats', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const CLIENT_ID = '01a00000-0000-7000-8000-0000000000c1'
  const PLAN_ID = '01a00000-0000-7000-8000-0000000000b1'
  const OTHER_TENANT_ID = '01999f00-0000-7000-8000-0000000000fe'

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

  const createContract = (reference: string) =>
    asTenant((tx) =>
      tx.execute(sql`
        insert into contracts (client_id, reference, contract_type, starts_on, amount_cents)
        values (${CLIENT_ID}, ${reference}, 'domiciliation', '2026-03-01', 90000)
      `),
    )

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    // Les tables sont liées entre elles : les vider ensemble, et la même
      // liste dans les deux suites de base — sinon l'une laisse des lignes qui
      // bloquent le TRUNCATE de l'autre.
      await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources cascade`
    await owner.client`delete from tenants where id <> ${DEFAULT_TENANT_ID}`
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
    await Promise.all([owner.client.end(), app.client.end()])
  })

  describe('clients', () => {
    it('refuse deux fiches pour le même SIRET', async () => {
      const code = await errorCode(() =>
        asTenant((tx) =>
          tx.execute(sql`insert into clients (name, siret) values ('Acme bis', '12345678900012')`),
        ),
      )
      assert.equal(code, PG_UNIQUE_VIOLATION)
    })

    it('libère le SIRET après archivage', async () => {
      await asTenant((tx) => tx.execute(sql`update clients set deleted_at = now()`))
      await asTenant((tx) =>
        tx.execute(sql`insert into clients (name, siret) values ('Acme repris', '12345678900012')`),
      )
      const rows = await asTenant((tx) =>
        tx.execute(sql`select count(*)::int as n from clients where siret = '12345678900012'`),
      )
      assert.equal(rows[0].n, 2)
    })

    it('accepte plusieurs clients sans SIRET', async () => {
      await asTenant((tx) => tx.execute(sql`insert into clients (name) values ('Étranger 1')`))
      await asTenant((tx) => tx.execute(sql`insert into clients (name) values ('Étranger 2')`))
      const rows = await asTenant((tx) =>
        tx.execute(sql`select count(*)::int as n from clients where siret is null`),
      )
      assert.equal(rows[0].n, 2)
    })
  })

  describe('grilles tarifaires', () => {
    it('n’admet qu’une grille par défaut un jour donné, plusieurs qui se suivent (ADR 035)', async () => {
      const code = await errorCode(() =>
        asTenant((tx) =>
          tx.execute(sql`insert into rate_plans (name, is_default) values ('Concurrente', true)`),
        ),
      )
      assert.equal(code, PG_EXCLUSION_VIOLATION)
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
      const rows = await asTenant((tx) =>
        tx.execute(sql`select count(*)::int as n from rate_plans`),
      )
      assert.equal(rows[0].n, 3)
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
      assert.equal(await errorCode(ligne), PG_UNIQUE_VIOLATION)
    })

    it('laisse coexister le tarif de type et le tarif nominatif', async () => {
      const [resource] = await asTenant((tx) =>
        tx.execute(sql`
          insert into resources (resource_type, code, name) values ('salle', 'S-900', 'Salle test')
          returning id
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
          values (${PLAN_ID}, 'salle', ${resource.id as string}, 'hour', 4000)
        `),
      )
      const rows = await asTenant((tx) =>
        tx.execute(sql`select count(*)::int as n from rate_plan_items`),
      )
      assert.equal(rows[0].n, 2)
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
      await asTenant((tx) => tx.execute(sql`update rate_plan_items set deleted_at = now()`))
      await ligne()
      assert.equal(await errorCode(ligne), PG_UNIQUE_VIOLATION)
      const rows = await asTenant((tx) =>
        tx.execute(sql`select count(*)::int as n from rate_plan_items`),
      )
      assert.equal(rows[0].n, 2)
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
      assert.equal(code, PG_CHECK_VIOLATION)
    })
  })

  describe('contrats', () => {
    it('refuse deux contrats sur la même référence', async () => {
      await createContract('DOM-2026-001')
      assert.equal(await errorCode(() => createContract('DOM-2026-001')), PG_UNIQUE_VIOLATION)
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
      assert.equal(code, PG_CHECK_VIOLATION)
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
      assert.equal(code, PG_CHECK_VIOLATION)
    })

    it('refuse une résiliation sans date', async () => {
      await createContract('DOM-2026-004')
      const code = await errorCode(() =>
        asTenant((tx) => tx.execute(sql`update contracts set status = 'terminated'`)),
      )
      assert.equal(code, PG_CHECK_VIOLATION)
    })

    it('refuse une date de résiliation sur un contrat en cours', async () => {
      await createContract('DOM-2026-005')
      const code = await errorCode(() =>
        asTenant((tx) => tx.execute(sql`update contracts set terminated_on = '2026-06-30'`)),
      )
      assert.equal(code, PG_CHECK_VIOLATION)
    })

    it('accepte la résiliation quand l’état et la date vont ensemble', async () => {
      await createContract('DOM-2026-006')
      await asTenant((tx) =>
        tx.execute(sql`update contracts set status = 'terminated', terminated_on = '2026-06-30'`),
      )
      const rows = await asTenant((tx) =>
        tx.execute(sql`select status, terminated_on::text as terminated_on from contracts`),
      )
      assert.equal(rows[0].status, 'terminated')
      assert.equal(rows[0].terminated_on, '2026-06-30')
    })

    it('refuse un contrat sur le client d’un autre centre', async () => {
      await owner.client`
        insert into tenants (id, name, slug)
        values (${OTHER_TENANT_ID}, 'Autre centre', 'autre-centre-2')`

      const code = await errorCode(() =>
        asTenant(
          (tx) =>
            tx.execute(sql`
              insert into contracts (client_id, reference, contract_type, starts_on, amount_cents)
              values (${CLIENT_ID}, 'FUITE-001', 'domiciliation', '2026-03-01', 90000)
            `),
          OTHER_TENANT_ID,
        ),
      )
      assert.equal(code, PG_FOREIGN_KEY_VIOLATION)
    })
  })

  describe('isolation par centre', () => {
    it('ne renvoie rien hors contexte de centre', async () => {
      const horsContexte = await app.db.execute(
        sql`select count(*)::int as n from clients union all select count(*)::int from contracts`,
      )
      assert.deepEqual(
        horsContexte.map((row) => row.n),
        [0, 0],
      )
    })

    it('couvre toutes les tables métier, sans oubli', async () => {
      const rows = await owner.client`
        select relname::text as name
        from pg_class
        where relnamespace = 'public'::regnamespace
          and relkind = 'r'
          and not (relrowsecurity and relforcerowsecurity)
        order by 1`
      assert.deepEqual(rows.map((row) => row.name), [])
    })
  })
})
