import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { uuidv7 } from '../lib/uuid.ts'
import { DB_TENANT_MISMATCH, dbErrorCode } from './errors.ts'
import {
  createDatabase,
  databaseOptionsFromEnv,
  scopeClientIds,
  withClientScope,
  withTenant,
} from './index.ts'
import {
  ouvrirBasesDeTest,
  raisonDeSaut,
  viderTables,
  type TestDatabases,
} from './test-support.ts'
import { DEFAULT_TENANT_ID } from './tenants.ts'

/**
 * Portée client en base (R28, ADR 019), sans Row Level Security.
 *
 * MySQL ne filtre plus les lectures : c'est chaque requête de l'espace client
 * qui filtre sur les entreprises du compte, et le test de portée de chaque
 * module le vérifie requête par requête. Ce que la base garantit encore, et
 * que ce fichier éprouve :
 *
 * - `withClientScope()` pose la liste des entreprises (`@app_client_ids`),
 *   relue par `scopeClientIds()`, et la retire en fin de transaction ;
 * - sous portée, une écriture pour une autre entreprise ou pour aucune est
 *   refusée par un trigger (`CAnnn`) ;
 * - une écriture pour un autre centre est refusée (`CA014`) ;
 * - sans portée (back-office), rien n'est restreint.
 */
describe('portée client', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases
  // Une seule connexion : la portée d'une transaction doit être retombée quand
  // la suivante réutilise la même session.
  let unique: ReturnType<typeof createDatabase>

  const DURAND = '01a00000-0000-7000-8000-0000000e0c01'
  const PETIT = '01a00000-0000-7000-8000-0000000e0c02'
  const SALLE = '01a00000-0000-7000-8000-0000000e0b01'
  const BUREAU = '01a00000-0000-7000-8000-0000000e0b02'
  const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000f5'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const asClients = <T>(clientIds: string[], run: Parameters<typeof withClientScope<T>>[2]) =>
    withClientScope(DEFAULT_TENANT_ID, clientIds, run, unique.db)

  const errorCode = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  const reservation = (resourceId: string, clientId: string | null, jour: string) => sql`
    insert into bookings (id, resource_id, client_id, channel, starts_at, ends_at, title)
    values (${uuidv7()}, ${resourceId}, ${clientId}, 'client',
            ${`2026-${jour} 08:00:00.000`}, ${`2026-${jour} 09:00:00.000`}, 'Réunion')`

  before(async () => {
    bases = await ouvrirBasesDeTest()
    const e = process.env
    unique = createDatabase(
      databaseOptionsFromEnv(e.TEST_DB_USER || e.DB_USER ? 'DB' : 'DB_ADMIN', {
        DB_HOST: e.TEST_DB_HOST ?? e.DB_HOST ?? '127.0.0.1',
        DB_PORT: e.TEST_DB_PORT ?? e.DB_PORT ?? '3306',
        DB_NAME: e.TEST_DB_NAME,
        DB_USER: e.TEST_DB_USER ?? e.DB_USER,
        DB_PASSWORD: e.TEST_DB_PASSWORD ?? e.DB_PASSWORD,
        DB_ADMIN_USER: e.TEST_DB_ADMIN_USER ?? e.DB_ADMIN_USER ?? 'root',
        DB_ADMIN_PASSWORD: e.TEST_DB_ADMIN_PASSWORD ?? e.DB_ADMIN_PASSWORD ?? '',
      } as unknown as NodeJS.ProcessEnv),
      { connectionLimit: 1 },
    )
  })

  beforeEach(async () => {
    await viderTables(
      bases.owner,
      'bookings',
      'resources',
      'client_contacts',
      'client_members',
      'clients',
    )
    await bases.owner.client.query('delete from tenants where id <> ?', [DEFAULT_TENANT_ID])
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (id, name) values (${DURAND}, 'Atelier Durand'), (${PETIT}, 'Boulangerie Petit')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${SALLE}, 'salle', 'SAL-1', 'Salle'), (${BUREAU}, 'bureau', 'BUR-1', 'Bureau')`)
      await tx.execute(reservation(SALLE, DURAND, '10-01'))
      await tx.execute(reservation(SALLE, PETIT, '10-02'))
    })
  })

  after(async () => {
    await unique.client.end()
    await bases.fermer()
  })

  it('pose la portée pour la durée de la transaction et la retire ensuite', async () => {
    const dedans = await asClients([DURAND, PETIT], (tx) => scopeClientIds(tx))
    assert.deepEqual(dedans, [DURAND, PETIT])

    // Même connexion (pool d'une seule) : la portée ne doit pas survivre.
    const [rows] = (await unique.client.query(
      'select @app_client_ids as ids, @app_tenant_id as t',
    )) as unknown as [{ ids: string | null; t: string | null }[]]
    assert.equal(rows[0].ids, null)
    assert.equal(rows[0].t, null)
  })

  it('distingue la portée vide de l’absence de portée', async () => {
    assert.deepEqual(await asClients([], (tx) => scopeClientIds(tx)), [])
    assert.equal(await asTenant((tx) => scopeClientIds(tx)), null)
  })

  it('refuse d’écrire pour une autre entreprise, ou pour aucune', async () => {
    for (const clientId of [PETIT, null]) {
      const code = await errorCode(() =>
        asClients([DURAND], (tx) => tx.execute(reservation(BUREAU, clientId, '11-02'))),
      )
      // Le code exact dépend de la table (CA009, CA010…) ; toujours un code métier.
      assert.match(code ?? '', /^CA\d{3}$/, String(clientId))
    }
  })

  it('refuse de déplacer une de ses lignes chez le voisin', async () => {
    const code = await errorCode(() =>
      asClients([DURAND], (tx) =>
        tx.execute(sql`update bookings set client_id = ${PETIT} where client_id = ${DURAND}`),
      ),
    )
    assert.match(code ?? '', /^CA\d{3}$/)
  })

  it('laisse écrire pour sa propre entreprise', async () => {
    // Depuis l'espace client, une réservation porte la personne de
    // l'entreprise qui la fait (CA009 sinon).
    const MEMBRE = uuidv7()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into client_members (id, client_id, email, auth_user_id)
        values (${MEMBRE}, ${DURAND}, 'jeanne@durand.test', 'u-jeanne-portee')`),
    )
    await asClients([DURAND], (tx) =>
      tx.execute(sql`
        insert into bookings (id, resource_id, client_id, kind, channel, booked_by_member_id, starts_at, ends_at, title)
        values (${uuidv7()}, ${BUREAU}, ${DURAND}, 'booking', 'client', ${MEMBRE},
                '2026-11-02 08:00:00.000', '2026-11-02 09:00:00.000', 'Réunion')`),
    )
    const [rows] = (await bases.owner.client.query(
      'select count(*) as n from bookings where client_id = ? and resource_id = ?',
      [DURAND, BUREAU],
    )) as unknown as [{ n: number }[]]
    assert.equal(Number(rows[0].n), 1)
  })

  it('sans portée, le back-office écrit pour n’importe quelle entreprise', async () => {
    await asTenant((tx) => tx.execute(reservation(BUREAU, PETIT, '11-03')))
  })

  it('refuse d’écrire pour un autre centre que celui du contexte', async () => {
    await bases.owner.client.query(
      `insert into tenants (id, name, slug) values (?, 'Autre centre', 'autre-centre-portee')`,
      [AUTRE_CENTRE],
    )
    const code = await errorCode(() =>
      withClientScope(
        AUTRE_CENTRE,
        [DURAND],
        (tx) =>
          tx.execute(sql`
            insert into resources (id, tenant_id, resource_type, code, name)
            values (${uuidv7()}, ${DEFAULT_TENANT_ID}, 'salle', 'INTRUS', 'Intrus')`),
        bases.app.db,
      ),
    )
    assert.equal(code, DB_TENANT_MISMATCH)
  })

  it('refuse une portée mal formée avant d’atteindre la base', async () => {
    await assert.rejects(
      withClientScope(DEFAULT_TENANT_ID, ['x}', DURAND], async () => undefined, bases.app.db),
      /Portée client invalide/,
    )
    await assert.rejects(
      withClientScope(DEFAULT_TENANT_ID, ['a,b'], async () => undefined, bases.app.db),
      /Portée client invalide/,
    )
  })
})
