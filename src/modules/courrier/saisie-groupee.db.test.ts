import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { todayIsoDate } from '../../lib/dates.ts'
import { toutVider } from '../clients/test-support.ts'
import { listMailRecipients, registerMailCounts, UnknownRecipientError } from './saisie-groupee.ts'
import { closeOpenBatch, findOpenBatch } from './tournees.ts'

/**
 * Saisie groupée du courrier, éprouvée contre la base sous l'identité
 * applicative : « 3 lettres pour Durand, 2 pour Petit » donne cinq plis dans
 * la tournée ouverte, en une fois ou pas du tout.
 */
describe('saisie groupée du courrier', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const ACCUEIL = '01a00000-0000-7000-8000-0000000f5a01'
  const DURAND = '01a00000-0000-7000-8000-0000000f5b01'
  const PETIT = '01a00000-0000-7000-8000-0000000f5b02'
  const BUREAU = '01a00000-0000-7000-8000-0000000f5b03'
  const ARCHIVE = '01a00000-0000-7000-8000-0000000f5b04'
  const BAL = '01a00000-0000-7000-8000-0000000f5d01'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)
  const lire = async (text: string, params: unknown[] = []) =>
    (await bases.owner.client.query(text, params))[0] as Record<string, unknown>[]

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, role) values (${ACCUEIL}, 'accueil@centre.fr', 'admin')`)
      await tx.execute(sql`
        insert into clients (id, name, status, deleted_at) values
          (${DURAND}, 'Atelier Durand', 'active', null), (${PETIT}, 'Petit Conseil', 'active', null),
          (${BUREAU}, 'Bureau Martin', 'active', null),
          (${ARCHIVE}, 'Ancienne SARL', 'inactive', current_timestamp(3))`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values (${BAL}, 'boite_aux_lettres', 'BAL-12', 'Boîte 12')`)
      // Durand et Petit sont domiciliés, Durand avec la boîte 12 ; Martin a un bureau.
      await tx.execute(sql`
        insert into contracts (client_id, reference, contract_type, status, starts_on, amount_cents, resource_id) values
          (${DURAND}, 'DOM-1', 'domiciliation', 'active', makedate(year(current_date()) - 1, 1), 3000, ${BAL}),
          (${PETIT}, 'DOM-2', 'domiciliation', 'active', makedate(year(current_date()) - 1, 1), 3000, null),
          (${BUREAU}, 'BUR-1', 'bureau', 'active', makedate(year(current_date()) - 1, 1), 50000, null)`)
    })
  })

  after(async () => {
    await toutVider(bases.owner)
    await bases?.fermer()
  })

  it('liste les domiciliés d’abord, avec leur boîte, sans les fiches archivées', async () => {
    const recipients = await listMailRecipients(todayIsoDate('Europe/Paris'), bases.app.db)
    assert.deepEqual(
      recipients.map((r) => [r.name, r.domiciled, r.mailbox]),
      [
        ['Atelier Durand', true, 'BAL-12'],
        ['Petit Conseil', true, null],
        ['Bureau Martin', false, null],
      ],
    )
  })

  it('« 3 lettres pour Durand, 1 colis et 1 recommandé pour Petit » : cinq plis dans la tournée', async () => {
    const receivedAt = new Date(Date.now() - 60_000)
    const done = await registerMailCounts(
      [
        { clientId: DURAND, kind: 'lettre', count: 3 },
        { clientId: PETIT, kind: 'colis', count: 1 },
        { clientId: PETIT, kind: 'recommande', count: 1 },
      ],
      receivedAt,
      ACCUEIL,
      bases.app.db,
    )
    assert.deepEqual(done, { items: 5, clients: 2 })

    const open = await findOpenBatch()
    assert.equal(open?.items.length, 5)
    assert.equal(open?.clientCount, 2)
    const rows = await lire(
      `select client_id, kind, status, batch_id, registered_by, sender, received_at from mail_items`,
    )
    assert.ok(rows.every((row) => row.batch_id === open?.id && row.status === 'received' && row.sender === null))
    assert.ok(rows.every((row) => row.registered_by === ACCUEIL))
    assert.ok(rows.every((row) => (row.received_at as Date).getTime() === receivedAt.getTime()))
    const tally = (clientId: string, kind: string) =>
      rows.filter((row) => row.client_id === clientId && row.kind === kind).length
    assert.equal(tally(DURAND, 'lettre'), 3)
    assert.equal(tally(PETIT, 'colis'), 1)
    assert.equal(tally(PETIT, 'recommande'), 1)
  })

  it('une deuxième saisie entre dans la même tournée, tant qu’elle est ouverte', async () => {
    const at = new Date(Date.now() - 60_000)
    await registerMailCounts([{ clientId: DURAND, kind: 'lettre', count: 2 }], at, ACCUEIL, bases.app.db)
    await registerMailCounts([{ clientId: PETIT, kind: 'lettre', count: 1 }], at, ACCUEIL, bases.app.db)
    const open = await findOpenBatch()
    assert.equal(open?.items.length, 3)

    assert.ok(open)
    await closeOpenBatch(ACCUEIL, open.id)
    await registerMailCounts([{ clientId: PETIT, kind: 'lettre', count: 1 }], at, ACCUEIL, bases.app.db)
    const next = await findOpenBatch()
    assert.notEqual(next?.id, open?.id)
    assert.equal(next?.items.length, 1)
  })

  it('une entreprise archivée entre-temps : rien n’est enregistré', async () => {
    await assert.rejects(
      registerMailCounts(
        [
          { clientId: DURAND, kind: 'lettre', count: 3 },
          { clientId: ARCHIVE, kind: 'lettre', count: 1 },
        ],
        new Date(Date.now() - 60_000),
        ACCUEIL,
        bases.app.db,
      ),
      (error) => error instanceof UnknownRecipientError && error.clientIds.includes(ARCHIVE),
    )
    assert.deepEqual(await lire(`select id from mail_items`), [])
    // La tournée ouverte par cette saisie part avec elle.
    assert.deepEqual(await lire(`select id from mail_batches`), [])
  })
})
