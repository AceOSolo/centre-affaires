import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { eq, sql } from 'drizzle-orm'

import { DB_UNIQUE_VIOLATION, dbConstraintName, dbErrorCode } from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
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
 * Modification d'une ressource (R01), contre la base et sous l'identité
 * applicative, comme l'application l'écrit : attributs fusionnés, capacité
 * tenue à nul pour les types qui n'en ont pas, unicité du code et du numéro de
 * casier — tenue par des index uniques sur colonnes générées, pas par une
 * lecture.
 */
describe('modification des ressources', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const BUREAU = '01a00000-0000-7000-8000-00000000f0b1'
  const CASIER = '01a00000-0000-7000-8000-00000000f0c1'
  const AUTRE_CASIER = '01a00000-0000-7000-8000-00000000f0c2'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

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
    bases = await ouvrirBasesDeTest()
    // Les requêtes du module passent par la base du processus : on lui donne
    // celle des tests.
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await viderTables(bases.owner, 'bookings', 'contracts', 'rate_plan_items', 'rate_plans', 'clients', 'resources')
    await asTenant((tx) =>
      tx.execute(sql`
        insert into resources (id, resource_type, code, name, capacity, attributes) values
          (${BUREAU}, 'bureau', 'BUR-01', 'Bureau 1', 2, '{"postes": 2, "superficieM2": 12, "etage": 3}'),
          (${CASIER}, 'casier', 'CAS-01', 'Casier 1', null, '{"numero": "A12", "taille": "M"}'),
          (${AUTRE_CASIER}, 'casier', 'CAS-02', 'Casier 2', null, '{"numero": "A13"}')`),
    )
  })

  after(async () => {
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
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

  it('fait tenir l’unicité du numéro par la base, même hors de l’application', async () => {
    let refus: unknown
    try {
      await asTenant((tx) =>
        tx.execute(sql`
          insert into resources (resource_type, code, name, attributes)
          values ('casier', 'CAS-09', 'Casier 9', '{"numero": "a13"}')`),
      )
    } catch (error) {
      refus = error
    }
    assert.equal(dbErrorCode(refus), DB_UNIQUE_VIOLATION)
    assert.equal(dbConstraintName(refus), 'resources_tenant_locker_numero_key')
  })

  it('ne laisse passer qu’une de deux déclarations simultanées du même numéro', async () => {
    const declarer = (code: string) =>
      createResource({ resourceType: 'casier', code, name: code, attributes: { numero: 'B7' } })
    const resultats = await Promise.allSettled([declarer('CAS-10'), declarer('CAS-11')])

    assert.equal(resultats.filter((resultat) => resultat.status === 'fulfilled').length, 1)
    const [echec] = resultats.filter((resultat) => resultat.status === 'rejected')
    assert.ok(echec.reason instanceof DuplicateLockerNumberError, String(echec.reason))
    assert.equal(echec.reason.numero, 'B7')
  })

  it('ne contraint pas un numéro posé sur une ressource qui n’est pas un casier', async () => {
    await asTenant((tx) =>
      tx.execute(sql`
        update resources set attributes = json_set(attributes, '$.numero', 'A12') where id = ${BUREAU}`),
    )
    assert.equal(((await lire(BUREAU)).attributes as { numero?: string }).numero, 'A12')
  })

  it('ne modifie pas une ressource archivée', async () => {
    await asTenant((tx) =>
      tx.execute(sql`update resources set deleted_at = now(), status = 'retired' where id = ${BUREAU}`),
    )
    assert.equal(await updateResource(BUREAU, saisie({ name: 'Renommé' })), undefined)
    assert.equal((await lire(BUREAU)).name, 'Bureau 1')
  })
})
