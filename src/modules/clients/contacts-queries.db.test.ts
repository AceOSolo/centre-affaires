import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import {
  ContactClientUnavailableError,
  createClientContact,
  findClientContact,
  listClientContacts,
  removeClientContact,
  updateClientContact,
} from './contacts-queries.ts'
import type { ContactInput } from './contacts-regles.ts'
import { toutVider } from './test-support.ts'

/**
 * Carnet de contacts d'une fiche client (R07), contre la base et sous
 * l'identité applicative : un seul contact principal à la fois, transmis
 * plutôt que refusé, et des retraits logiques.
 */
describe('carnet de contacts d’une fiche client', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const ACME = '01a00000-0000-7000-8000-0000000c7a01'
  const BETA = '01a00000-0000-7000-8000-0000000c7a02'
  const ARCHIVE = '01a00000-0000-7000-8000-0000000c7a03'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const contact = (fullName: string, roles: Partial<ContactInput> = {}): ContactInput => ({
    fullName,
    jobTitle: null,
    email: null,
    phone: null,
    isPrimary: false,
    isBilling: false,
    notes: null,
    ...roles,
  })

  /** Contacts actifs désignés principaux, toutes fiches confondues, lus en base. */
  const primaries = async () => {
    const [rows] = (await bases.owner.client.query(
      `select client_id, full_name from client_contacts
        where is_primary and deleted_at is null order by full_name`,
    )) as unknown as [{ client_id: string; full_name: string }[]]
    return rows.map((row) => `${row.client_id === ACME ? 'Acme' : 'Beta'}:${row.full_name}`)
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    // Les requêtes du module passent par la base du processus : celle des tests.
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await asTenant((tx) =>
      tx.execute(sql`
        insert into clients (id, name, status, deleted_at) values
          (${ACME}, 'Acme SAS', 'active', null),
          (${BETA}, 'Beta SARL', 'active', null),
          (${ARCHIVE}, 'Ancienne SARL', 'inactive', now(3))`),
    )
  })

  after(async () => {
    await toutVider(bases.owner)
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  it('liste les contacts actifs, le principal d’abord puis par nom', async () => {
    await createClientContact(ACME, contact('Zoé Roy'))
    await createClientContact(ACME, contact('Bruno Leroy', { isBilling: true }))
    await createClientContact(ACME, contact('Martine Petit', { isPrimary: true }))
    await createClientContact(BETA, contact('Chloé Durand'))

    assert.deepEqual(
      (await listClientContacts(ACME)).map((row) => row.fullName),
      ['Martine Petit', 'Bruno Leroy', 'Zoé Roy'],
    )
  })

  it('transmet le rôle de principal au nouveau contact désigné', async () => {
    await createClientContact(ACME, contact('Alice Martin', { isPrimary: true }))
    await createClientContact(BETA, contact('Chloé Durand', { isPrimary: true }))

    await createClientContact(ACME, contact('Bruno Leroy', { isPrimary: true }))

    // Un seul principal chez Acme, et celui de Beta n'a pas bougé.
    assert.deepEqual(await primaries(), ['Beta:Chloé Durand', 'Acme:Bruno Leroy'].sort())
    const alice = (await listClientContacts(ACME)).find((row) => row.fullName === 'Alice Martin')
    assert.equal(alice?.isPrimary, false)
  })

  it('transmet aussi le rôle quand un contact existant devient principal', async () => {
    await createClientContact(ACME, contact('Alice Martin', { isPrimary: true }))
    const bruno = await createClientContact(ACME, contact('Bruno Leroy'))

    const updated = await updateClientContact(
      ACME,
      bruno.id,
      contact('Bruno Leroy', { isPrimary: true, jobTitle: 'Gérant' }),
    )

    assert.equal(updated?.isPrimary, true)
    assert.equal(updated?.jobTitle, 'Gérant')
    assert.deepEqual(await primaries(), ['Acme:Bruno Leroy'])
  })

  it('garde un seul principal quand deux sont désignés en même temps', async () => {
    // Le verrou sur la fiche fait passer les écritures l'une après l'autre :
    // la suivante décharge la précédente au lieu d'échouer.
    await Promise.all([
      createClientContact(ACME, contact('Alice Martin', { isPrimary: true })),
      createClientContact(ACME, contact('Bruno Leroy', { isPrimary: true })),
      createClientContact(ACME, contact('Chloé Petit', { isPrimary: true })),
    ])
    assert.equal((await primaries()).length, 1)
    assert.equal((await listClientContacts(ACME)).length, 3)
  })

  it('accepte plusieurs destinataires des factures', async () => {
    await createClientContact(ACME, contact('Alice Martin', { isPrimary: true, isBilling: true }))
    await createClientContact(ACME, contact('Cabinet Roy', { isBilling: true }))
    const billing = (await listClientContacts(ACME)).filter((row) => row.isBilling)
    assert.deepEqual(billing.map((row) => row.fullName), ['Alice Martin', 'Cabinet Roy'])
  })

  it('retire un contact sans effacer sa ligne, et libère la place du principal', async () => {
    const alice = await createClientContact(ACME, contact('Alice Martin', { isPrimary: true }))

    assert.equal(await removeClientContact(ACME, alice.id), true)
    // Un second retrait n'a plus rien à faire.
    assert.equal(await removeClientContact(ACME, alice.id), false)

    assert.deepEqual(await listClientContacts(ACME), [])
    assert.equal(await findClientContact(ACME, alice.id), undefined)
    const [[ligne]] = (await bases.owner.client.query(
      'select deleted_at from client_contacts where id = ?',
      [alice.id],
    )) as unknown as [{ deleted_at: Date | null }[]]
    assert.notEqual(ligne.deleted_at, null, 'la ligne est conservée, datée de son retrait (décision 6)')

    await createClientContact(ACME, contact('Bruno Leroy', { isPrimary: true }))
    assert.deepEqual(await primaries(), ['Acme:Bruno Leroy'])
  })

  it('ne modifie pas un contact retiré, ni sans retirer le principal en place', async () => {
    await createClientContact(ACME, contact('Alice Martin', { isPrimary: true }))
    const bruno = await createClientContact(ACME, contact('Bruno Leroy'))
    await removeClientContact(ACME, bruno.id)

    const updated = await updateClientContact(ACME, bruno.id, contact('Bruno Leroy', { isPrimary: true }))

    assert.equal(updated, undefined)
    // Alice reste principale : la modification refusée ne l'a pas déchargée.
    assert.deepEqual(await primaries(), ['Acme:Alice Martin'])
  })

  it('ne touche pas au contact d’une autre fiche', async () => {
    const chloe = await createClientContact(BETA, contact('Chloé Durand'))

    assert.equal(await updateClientContact(ACME, chloe.id, contact('Détourné')), undefined)
    assert.equal(await removeClientContact(ACME, chloe.id), false)
    assert.equal(await findClientContact(ACME, chloe.id), undefined)
    assert.equal((await findClientContact(BETA, chloe.id))?.fullName, 'Chloé Durand')
  })

  it('refuse d’écrire les contacts d’une fiche archivée ou inconnue', async () => {
    await assert.rejects(
      createClientContact(ARCHIVE, contact('Alice Martin')),
      ContactClientUnavailableError,
    )
    await assert.rejects(
      createClientContact('01a00000-0000-7000-8000-0000000c7aff', contact('Alice Martin')),
      ContactClientUnavailableError,
    )
  })
})
