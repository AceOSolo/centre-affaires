import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import {
  DB_CLIENT_MAIL_REFUSED,
  DB_INSUFFICIENT_PRIVILEGE,
  DB_UNIQUE_VIOLATION,
  dbErrorCode,
} from '../../db/errors.ts'
import { withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { toutVider } from '../clients/test-support.ts'
import {
  createForwardAddress,
  deleteForwardAddress,
  listForwardAddresses,
  setDefaultForwardAddress,
  updateForwardAddress,
} from './carnet-adresses.ts'
import type { ForwardAddress } from './demandes-regles.ts'
import { requestForward } from './demandes-queries.ts'

/**
 * Carnet d'adresses de réexpédition (ADR 078), contre la base et sous
 * l'identité applicative :
 *
 * - partagé par l'entreprise, une adresse par défaut au plus, la première
 *   l'étant d'office, la suivante prenant le relais d'une adresse retirée ;
 * - jamais pour une autre entreprise ; une adresse reste à la sienne (`CA024`) ;
 * - la demande d'envoi fige l'adresse choisie : le carnet peut changer ensuite ;
 * - effacé avec l'entreprise anonymisée.
 */
describe('carnet d’adresses de réexpédition', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const ACCUEIL = '01a00000-0000-7000-8000-0000000f8a01'
  const DURAND = '01a00000-0000-7000-8000-0000000f8b01'
  const PETIT = '01a00000-0000-7000-8000-0000000f8b02'
  const JEANNE = '01a00000-0000-7000-8000-0000000f8c01'
  const JULES = '01a00000-0000-7000-8000-0000000f8c02'
  const PAUL = '01a00000-0000-7000-8000-0000000f8c03'

  const jeanne: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]
  const jules: ClientAccount[] = [{ memberId: JULES, clientId: DURAND, clientName: 'Atelier Durand' }]
  const paul: ClientAccount[] = [{ memberId: PAUL, clientId: PETIT, clientName: 'Petit Conseil' }]

  const siege: ForwardAddress = {
    recipient: 'Atelier Durand',
    line1: '3 rue des Lilas',
    line2: null,
    postalCode: '69003',
    city: 'Lyon',
    country: 'FR',
  }
  const domicile: ForwardAddress = { ...siege, recipient: 'Jeanne Durand', line1: '8 quai Rambaud', postalCode: '69002' }

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)
  const lire = async (text: string, params: unknown[] = []) =>
    (await bases.owner.client.query(text, params))[0] as Record<string, unknown>[]
  const codeAttendu = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }
  const ajouter = async (accounts: ClientAccount[], clientId: string, address: ForwardAddress, isDefault = false, label: string | null = null) => {
    const result = await createForwardAddress(accounts, clientId, { label, address, isDefault })
    assert.ok(result.ok, result.ok ? '' : result.error)
    return result.id
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, role) values (${ACCUEIL}, 'accueil@centre.fr', 'admin')`)
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Petit Conseil', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand', 'u-jeanne'),
          (${JULES}, ${DURAND}, 'jules@durand.fr', 'Jules Durand', 'u-jules'),
          (${PAUL}, ${PETIT}, 'paul@petit.fr', 'Paul Petit', 'u-paul')`)
    })
  })

  after(async () => {
    await toutVider(bases.owner)
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  it('partagé par l’entreprise : la première adresse est celle par défaut', async () => {
    const premiere = await ajouter(jeanne, DURAND, siege, false, 'Siège')
    const seconde = await ajouter(jules, DURAND, domicile)
    const book = await listForwardAddresses(jules)
    assert.deepEqual(
      book.map((entry) => [entry.id, entry.isDefault]),
      [
        [premiere, true],
        [seconde, false],
      ],
    )
    assert.equal(book[0].label, 'Siège')
    assert.deepEqual(book[0].address, siege)
    assert.deepEqual(await listForwardAddresses(paul), [], 'jamais lu par une autre entreprise')
  })

  it('une adresse par défaut au plus ; la suivante prend le relais d’une adresse retirée', async () => {
    const premiere = await ajouter(jeanne, DURAND, siege)
    const seconde = await ajouter(jeanne, DURAND, domicile, true)
    const defauts = async () =>
      (await listForwardAddresses(jeanne)).filter((entry) => entry.isDefault).map((entry) => entry.id)
    assert.deepEqual(await defauts(), [seconde])
    assert.ok((await setDefaultForwardAddress(jeanne, premiere)).ok)
    assert.deepEqual(await defauts(), [premiere])
    assert.ok((await deleteForwardAddress(jeanne, premiere)).ok)
    assert.deepEqual(await defauts(), [seconde])
    // La base tient l'unicité, quel que soit le chemin d'écriture.
    await ajouter(jeanne, DURAND, siege)
    assert.equal(
      await codeAttendu(() => asTenant((tx) => tx.execute(sql`update mail_forward_addresses set is_default = true`))),
      DB_UNIQUE_VIOLATION,
    )
  })

  it('refuse un doublon ; modifie une adresse sans toucher aux autres', async () => {
    const id = await ajouter(jeanne, DURAND, siege)
    const doublon = await createForwardAddress(jeanne, DURAND, {
      label: null,
      address: { ...siege, recipient: 'ATELIER DURAND' },
      isDefault: false,
    })
    assert.equal(doublon.ok, false)
    const modifiee = await updateForwardAddress(jeanne, id, { label: 'Atelier', address: { ...siege, city: 'Villeurbanne', postalCode: '69100' }, isDefault: false })
    assert.ok(modifiee.ok)
    const [entry] = await listForwardAddresses(jeanne)
    assert.equal(entry.address.city, 'Villeurbanne')
    assert.equal(entry.isDefault, true, 'décocher ne retire pas le rôle d’adresse par défaut')
  })

  it('jamais pour une autre entreprise : ni par l’application, ni sous portée client', async () => {
    const chezPetit = await ajouter(paul, PETIT, siege)
    assert.equal((await createForwardAddress(jeanne, PETIT, { label: null, address: siege, isDefault: false })).ok, false)
    assert.equal((await deleteForwardAddress(jeanne, chezPetit)).ok, false)
    assert.equal((await setDefaultForwardAddress(jeanne, chezPetit)).ok, false)
    assert.equal(
      await codeAttendu(() =>
        withClientScope(
          DEFAULT_TENANT_ID,
          [DURAND],
          (tx) =>
            tx.execute(sql`
              insert into mail_forward_addresses (id, client_id, recipient, line1, postal_code, city, country)
              values (${uuidv7()}, ${PETIT}, 'X', '1 rue', '69001', 'Lyon', 'FR')`),
          bases.app.db,
        ),
      ),
      DB_INSUFFICIENT_PRIVILEGE,
    )
    assert.equal(
      await codeAttendu(() =>
        asTenant((tx) => tx.execute(sql`update mail_forward_addresses set client_id = ${DURAND} where id = ${chezPetit}`)),
      ),
      DB_CLIENT_MAIL_REFUSED,
    )
  })

  it('la demande d’envoi fige l’adresse : modifier ou retirer le carnet ne la change pas', async () => {
    const id = await ajouter(jeanne, DURAND, siege)
    const item = uuidv7()
    await asTenant((tx) => tx.execute(sql`insert into mail_items (id, client_id, sender) values (${item}, ${DURAND}, 'Banque')`))
    const [entry] = await listForwardAddresses(jeanne)
    const outcome = await requestForward(item, jeanne, entry.address, null)
    assert.ok(outcome.ok)
    await updateForwardAddress(jeanne, id, { label: null, address: domicile, isDefault: false })
    await deleteForwardAddress(jeanne, id)
    const [request] = await lire('select forward_recipient, forward_address_line1 from mail_requests where mail_item_id = ?', [item])
    assert.deepEqual(request, { forward_recipient: 'Atelier Durand', forward_address_line1: '3 rue des Lilas' })
  })

  it('effacé avec l’entreprise anonymisée', async () => {
    await ajouter(jeanne, DURAND, siege)
    await ajouter(paul, PETIT, siege)
    await asTenant((tx) => tx.execute(sql`select anonymize_client(${DURAND}, ${ACCUEIL}, 'erasure_request', current_date())`))
    assert.deepEqual(await lire('select client_id from mail_forward_addresses'), [{ client_id: PETIT }])
  })
})
