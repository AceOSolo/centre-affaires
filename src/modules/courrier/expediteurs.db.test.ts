import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { toutVider } from '../clients/test-support.ts'
import { STARTING_SENDERS, suggestionsFor } from './expediteurs.ts'
import { findKnownSenders, findSenderSuggestions, updateMailSender } from './expediteurs-queries.ts'
import { MailStateError, withdrawMail } from './queries.ts'
import { registerMailEntry } from './saisie-groupee.ts'

/**
 * Expéditeurs des plis (ADR 058), contre la base sous l'identité
 * applicative : suggestions calculées sur `mail_items.sender` (l'entreprise,
 * puis le centre, puis la liste de départ), expéditeur précisé après coup,
 * refusé sur un pli retiré ou anonymisé.
 */
describe('expéditeurs du courrier', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const ACCUEIL = '01a00000-0000-7000-8000-0000000e5a01'
  const DURAND = '01a00000-0000-7000-8000-0000000e5b01'
  const PETIT = '01a00000-0000-7000-8000-0000000e5b02'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)
  const lire = async (text: string, params: unknown[] = []) =>
    (await bases.owner.client.query(text, params))[0] as Record<string, unknown>[]

  let cle = 0
  /** Enregistre des plis fermés, un par expéditeur donné, et rend leurs identifiants dans l'ordre. */
  const plis = async (clientId: string, senders: (string | null)[]) => {
    await registerMailEntry(
      senders.map((sender) => ({ key: String((cle += 1)), clientId, kind: 'lettre' as const, sender })),
      new Date(Date.now() - 60_000),
      ACCUEIL,
      bases.app.db,
    )
    const rows = await lire(`select id from mail_items where client_id = ? order by id desc limit ?`, [clientId, senders.length])
    return rows.map((row) => row.id as string).reverse()
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, role) values (${ACCUEIL}, 'accueil@centre.test', 'admin')`)
      await tx.execute(sql`
        insert into clients (id, name, status) values (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Petit Conseil', 'active')`)
    })
  })

  after(async () => {
    await toutVider(bases.owner)
    await bases?.fermer()
  })

  it('suggère ceux de l’entreprise, puis ceux du centre, puis la liste de départ', async () => {
    await plis(DURAND, ['URSSAF', 'URSSAF', 'Cabinet Martin', null])
    await plis(PETIT, ['Fournisseur Delta', 'Fournisseur Delta', 'Fournisseur Delta', 'Cabinet Martin'])

    const suggestions = await findSenderSuggestions([DURAND], bases.app.db)
    assert.deepEqual(suggestions.byClient[DURAND], ['URSSAF', 'Cabinet Martin'])
    const pourDurand = suggestionsFor(suggestions, DURAND)
    assert.deepEqual(pourDurand.slice(0, 3), ['URSSAF', 'Cabinet Martin', 'Fournisseur Delta'])
    assert.ok(pourDurand.includes('CAF'))
    // Le centre : Delta (3 plis), puis URSSAF et Cabinet Martin (2 chacun) ; sans doublon.
    assert.equal(suggestions.centre[0], 'Fournisseur Delta')
    assert.equal(new Set(pourDurand).size, pourDurand.length)
  })

  it('ignore les plis retirés et les expéditeurs anonymisés', async () => {
    const [retire] = await plis(DURAND, ['Erreur de saisie SA'])
    await withdrawMail(retire)
    const [efface] = await plis(PETIT, ['Banque privée Untel'])
    await asTenant((tx) =>
      tx.execute(sql`update mail_items set sender = null, note = null, sender_anonymized_at = current_timestamp(3) where id = ${efface}`),
    )
    const suggestions = await findSenderSuggestions([DURAND, PETIT], bases.app.db)
    assert.deepEqual(suggestions.byClient, { [DURAND]: [], [PETIT]: [] })
    assert.deepEqual(suggestions.centre, [...STARTING_SENDERS])
  })

  it('connaît toutes les écritures du centre, pour ramener une saisie à la sienne', async () => {
    await plis(PETIT, ['Cabinet Martin'])
    const known = await findKnownSenders(bases.app.db)
    assert.ok(known.includes('Cabinet Martin'))
    assert.ok(known.includes('URSSAF'))
  })

  it('précise, corrige puis efface l’expéditeur d’un pli après coup', async () => {
    const [id] = await plis(DURAND, [null])
    await updateMailSender(id, 'URSSAF', bases.app.db)
    assert.equal((await lire(`select sender from mail_items where id = ?`, [id]))[0].sender, 'URSSAF')
    await updateMailSender(id, 'Impôts / DGFiP', bases.app.db)
    assert.equal((await lire(`select sender from mail_items where id = ?`, [id]))[0].sender, 'Impôts / DGFiP')
    await updateMailSender(id, null, bases.app.db)
    assert.equal((await lire(`select sender from mail_items where id = ?`, [id]))[0].sender, null)
  })

  it('refuse un pli retiré, un expéditeur anonymisé et un pli inconnu', async () => {
    const [retire, efface] = await plis(DURAND, ['Avant', 'Avant aussi'])
    await withdrawMail(retire)
    await asTenant((tx) =>
      tx.execute(sql`update mail_items set sender = null, note = null, sender_anonymized_at = current_timestamp(3) where id = ${efface}`),
    )
    await assert.rejects(updateMailSender(retire, 'URSSAF', bases.app.db), (error) =>
      error instanceof MailStateError && /retiré/.test(error.message),
    )
    await assert.rejects(updateMailSender(efface, 'URSSAF', bases.app.db), (error) =>
      error instanceof MailStateError && /RGPD/.test(error.message),
    )
    await assert.rejects(updateMailSender('01a00000-0000-7000-8000-0000000e5fff', 'URSSAF', bases.app.db), MailStateError)
    await assert.rejects(updateMailSender('pas-un-identifiant', 'URSSAF', bases.app.db), MailStateError)
    assert.deepEqual(
      (await lire(`select sender from mail_items where id in (?, ?) order by id`, [retire, efface])).map((row) => row.sender),
      ['Avant', null],
    )
  })
})
