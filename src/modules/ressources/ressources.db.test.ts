import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import {
  DuplicateLockerNumberError,
  DuplicateResourceCodeError,
  createResource,
  updateResource,
  type UpdateResourceInput,
} from './queries.ts'
import { resources } from './schema.ts'

/**
 * Modification d'une ressource (R01), contre la base et sous `app_centre`,
 * comme l'application l'écrit : attributs fusionnés, capacité tenue à nul pour
 * les types qui n'en ont pas, unicité du code et du numéro de casier.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('modification des ressources', { skip: raison }, () => {
  // Les requêtes ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const BUREAU = '01a00000-0000-7000-8000-00000000f0b1'
  const CASIER = '01a00000-0000-7000-8000-00000000f0c1'
  const AUTRE_CASIER = '01a00000-0000-7000-8000-00000000f0c2'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  const lire = async (id: string) => {
    const [row] = await asTenant((tx) => tx.select().from(resources).where(eq(resources.id, id)))
    return row
  }

  const saisie = (overrides: Partial<UpdateResourceInput> = {}): UpdateResourceInput => ({
    code: 'BUR-01',
    name: 'Bureau 1',
    description: null,
    capacity: 3,
    status: 'active',
    attributes: {},
    ...overrides,
  })

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources cascade`
    await asTenant((tx) =>
      tx.execute(sql`
        insert into resources (id, resource_type, code, name, capacity, attributes) values
          (${BUREAU}, 'bureau', 'BUR-01', 'Bureau 1', 2, '{"postes": 2, "superficieM2": 12, "etage": 3}'),
          (${CASIER}, 'casier', 'CAS-01', 'Casier 1', null, '{"numero": "A12", "taille": "M"}'),
          (${AUTRE_CASIER}, 'casier', 'CAS-02', 'Casier 2', null, '{"numero": "A13"}')`),
    )
  })

  after(async () => {
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  it('modifie les champs saisis et garde les attributs que l’écran ne connaît pas', async () => {
    const updated = await updateResource(
      BUREAU,
      saisie({
        name: 'Bureau Lumière',
        capacity: 4,
        status: 'maintenance',
        description: 'Vue sur cour.',
        // Superficie vidée : elle disparaît ; postes changés.
        attributes: { postes: 4 },
      }),
    )
    assert.ok(updated)
    const row = await lire(BUREAU)
    assert.equal(row.name, 'Bureau Lumière')
    assert.equal(row.capacity, 4)
    assert.equal(row.status, 'maintenance')
    assert.equal(row.description, 'Vue sur cour.')
    assert.deepEqual(row.attributes, { etage: 3, postes: 4 })
  })

  it('tient la capacité d’un casier à nul, quoi qu’on lui envoie', async () => {
    await updateResource(
      CASIER,
      saisie({ code: 'CAS-01', name: 'Casier 1', capacity: 5, attributes: { numero: 'A12', taille: 'L' } }),
    )
    const row = await lire(CASIER)
    assert.equal(row.capacity, null)
    assert.deepEqual(row.attributes, { numero: 'A12', taille: 'L' })
  })

  it('refuse un code déjà porté par une autre ressource', async () => {
    await assert.rejects(
      updateResource(CASIER, saisie({ code: 'BUR-01', attributes: { numero: 'A12' } })),
      DuplicateResourceCodeError,
    )
    assert.equal((await lire(CASIER)).code, 'CAS-01')
  })

  it('refuse un numéro de casier déjà pris, à la casse près', async () => {
    await assert.rejects(
      updateResource(
        AUTRE_CASIER,
        saisie({ code: 'CAS-02', name: 'Casier 2', attributes: { numero: 'a12' } }),
      ),
      DuplicateLockerNumberError,
    )
    await assert.rejects(
      createResource({
        resourceType: 'casier',
        code: 'CAS-03',
        name: 'Casier 3',
        attributes: { numero: 'A12' },
      }),
      DuplicateLockerNumberError,
    )
  })

  it('laisse un casier garder son propre numéro', async () => {
    const updated = await updateResource(
      CASIER,
      saisie({ code: 'CAS-01', name: 'Casier du hall', attributes: { numero: 'A12' } }),
    )
    assert.equal(updated?.name, 'Casier du hall')
  })

  it('rend le numéro d’un casier archivé à nouveau disponible', async () => {
    await asTenant((tx) =>
      tx.execute(sql`update resources set deleted_at = now(), status = 'retired' where id = ${CASIER}`),
    )
    const created = await createResource({
      resourceType: 'casier',
      code: 'CAS-04',
      name: 'Casier 4',
      attributes: { numero: 'A12' },
    })
    assert.deepEqual(created.attributes, { numero: 'A12' })
  })

  it('ne modifie pas une ressource archivée', async () => {
    await asTenant((tx) =>
      tx.execute(sql`update resources set deleted_at = now(), status = 'retired' where id = ${BUREAU}`),
    )
    assert.equal(await updateResource(BUREAU, saisie({ name: 'Renommé' })), undefined)
    assert.equal((await lire(BUREAU)).name, 'Bureau 1')
  })
})
