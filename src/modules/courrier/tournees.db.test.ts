import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_INSUFFICIENT_PRIVILEGE, DB_MAIL_REFUSED, dbErrorCode } from '../../db/errors.ts'
import { withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { Message, SendResult } from '../../lib/courriel.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { toutVider } from '../clients/test-support.ts'
import { notifyMailBatchClosed } from '../notifications/declencheurs-courrier.ts'
import {
  batchRecipients,
  closeOpenBatch,
  findOpenBatch,
  inOpenBatch,
  listRecentBatches,
  MailBatchClosedError,
} from './tournees.ts'

/**
 * Tournées du courrier (ADR 044), éprouvées contre la base, sous l'identité
 * applicative :
 *
 * - une seule tournée ouverte ; un pli n'entre jamais dans une tournée
 *   terminée, et n'en change pas ; une tournée ne se rouvre ni ne se supprime ;
 * - la fin de tournée prévient chaque entreprise une fois, avec le nombre et
 *   la nature de ses plis, et les domiciliés sans courrier à la première
 *   tournée du jour seulement.
 */
describe('tournées du courrier', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const ACCUEIL = '01a00000-0000-7000-8000-0000000f4a01'
  const DURAND = '01a00000-0000-7000-8000-0000000f4b01'
  const PETIT = '01a00000-0000-7000-8000-0000000f4b02'
  const BUREAU = '01a00000-0000-7000-8000-0000000f4b03'
  const JEANNE = '01a00000-0000-7000-8000-0000000f4c01'
  const PAUL = '01a00000-0000-7000-8000-0000000f4c02'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)
  const lire = async (text: string, params: unknown[] = []) =>
    (await bases.owner.client.query(text, params))[0] as Record<string, unknown>[]
  const codeErreur = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  let envoyes: Message[] = []
  const send = async (message: Message): Promise<SendResult> => {
    envoyes.push(message)
    return { status: 'sent', recipients: message.to.map((to) => to.toLowerCase()), failed: [], error: null }
  }
  const options = {
    get database() {
      return bases.app.db
    },
    send,
  }

  /** Enregistre un pli dans la tournée ouverte, comme l'écran d'enregistrement. */
  const enregistre = (clientId: string, kind = 'lettre', ouvert = false) =>
    inOpenBatch(ACCUEIL, async (tx, batchId) => {
      const id = uuidv7()
      await tx.execute(sql`
        insert into mail_items (id, client_id, batch_id, kind, sender, status, opened_at, opened_by, registered_by)
        values (${id}, ${clientId}, ${batchId}, ${kind}, 'URSSAF', ${ouvert ? 'opened' : 'received'},
                ${ouvert ? sql`current_timestamp(3)` : null}, ${ouvert ? ACCUEIL : null}, ${ACCUEIL})`)
      return { id, batchId }
    })

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    envoyes = []
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, role) values (${ACCUEIL}, 'accueil@centre.fr', 'admin')`)
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Petit Conseil', 'active'),
          (${BUREAU}, 'Bureau Martin', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand', 'u-jeanne'),
          (${PAUL}, ${PETIT}, 'paul@petit.fr', 'Paul Petit', 'u-paul')`)
      // Durand et Petit sont domiciliés ; le bureau Martin ne l'est pas.
      await tx.execute(sql`
        insert into contracts (client_id, reference, contract_type, status, starts_on, amount_cents) values
          (${DURAND}, 'DOM-1', 'domiciliation', 'active', makedate(year(current_date()) - 1, 1), 3000),
          (${PETIT}, 'DOM-2', 'domiciliation', 'active', makedate(year(current_date()) - 1, 1), 3000),
          (${BUREAU}, 'BUR-1', 'bureau', 'active', makedate(year(current_date()) - 1, 1), 50000)`)
    })
  })

  after(async () => {
    await toutVider(bases.owner)
    await bases?.fermer()
  })

  describe('une tournée ouverte à la fois', () => {
    it('le premier pli ouvre la tournée, les suivants y entrent', async () => {
      const premier = await enregistre(DURAND)
      const second = await enregistre(PETIT, 'colis')
      assert.equal(second.batchId, premier.batchId)
      const ouverte = await findOpenBatch()
      assert.equal(ouverte?.id, premier.batchId)
      assert.equal(ouverte?.items.length, 2)
      assert.equal(ouverte?.clientCount, 2)
    })

    it('après la fin, le pli suivant ouvre une nouvelle tournée', async () => {
      const { batchId } = await enregistre(DURAND)
      assert.equal(await closeOpenBatch(ACCUEIL, batchId), batchId)
      const suivant = await enregistre(DURAND)
      assert.notEqual(suivant.batchId, batchId)
    })

    it('refuse un pli dans une tournée terminée, et un pli qui change de tournée', async () => {
      const { id, batchId } = await enregistre(DURAND)
      await closeOpenBatch(ACCUEIL, batchId)
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`insert into mail_items (id, client_id, batch_id) values (${uuidv7()}, ${DURAND}, ${batchId})`),
          ),
        ),
        DB_MAIL_REFUSED,
      )
      const autre = await enregistre(PETIT)
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => tx.execute(sql`update mail_items set batch_id = ${autre.batchId} where id = ${id}`)),
        ),
        DB_MAIL_REFUSED,
      )
    })

    it('une tournée terminée ne se rouvre pas et ne se supprime pas', async () => {
      const { batchId } = await enregistre(DURAND)
      await closeOpenBatch(ACCUEIL, batchId)
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => tx.execute(sql`update mail_batches set closed_at = null, closed_by = null where id = ${batchId}`)),
        ),
        DB_MAIL_REFUSED,
      )
      assert.equal(
        await codeErreur(() => bases.owner.client.query('delete from mail_batches where id = ?', [batchId])),
        DB_MAIL_REFUSED,
      )
    })

    it('la fin de tournée est datée par la base', async () => {
      const { batchId } = await enregistre(DURAND)
      await asTenant((tx) =>
        tx.execute(sql`update mail_batches set closed_at = '2001-01-01 00:00:00', closed_by = ${ACCUEIL} where id = ${batchId}`),
      )
      const [row] = await lire('select closed_at from mail_batches where id = ?', [batchId])
      assert.ok((row.closed_at as Date).getFullYear() > 2001)
    })

    it('ne s’écrit jamais depuis l’espace client', async () => {
      assert.equal(
        await codeErreur(() =>
          withClientScope(
            DEFAULT_TENANT_ID,
            [DURAND],
            (tx) => tx.execute(sql`insert into mail_batches (id, opened_by) values (${uuidv7()}, ${ACCUEIL})`),
            bases.app.db,
          ),
        ),
        DB_INSUFFICIENT_PRIVILEGE,
      )
    })

    it('ne termine pas à la place d’un collègue une tournée qu’on n’a pas vue', async () => {
      const { batchId } = await enregistre(DURAND)
      await closeOpenBatch(ACCUEIL, batchId)
      await enregistre(PETIT)
      await assert.rejects(() => closeOpenBatch(ACCUEIL, batchId), MailBatchClosedError)
    })
  })

  describe('fin de tournée : les messages', () => {
    it('un message par entreprise qui a du courrier, « pas de courrier » aux autres domiciliés', async () => {
      await enregistre(DURAND, 'lettre')
      const { batchId } = await enregistre(DURAND, 'recommande', true)
      await closeOpenBatch(ACCUEIL, batchId)

      const counts = await notifyMailBatchClosed(batchId, options)
      assert.deepEqual(counts, { received: 1, none: 1, failed: 0 })
      const journal = await lire(
        'select event, client_id, related_type, related_id, status from notification_deliveries order by event',
      )
      assert.deepEqual(
        journal.map((row) => [row.event, row.client_id, row.related_type, row.related_id]),
        [
          ['mail_batch_received', DURAND, 'mail_batch', batchId],
          ['mail_none', PETIT, 'mail_batch', batchId],
        ],
      )
      const [recu, rien] = [...envoyes].sort((a, b) => a.to[0].localeCompare(b.to[0]))
      assert.deepEqual(recu.to, ['jeanne@durand.fr'])
      assert.match(recu.text, /2 courriers pour Atelier Durand \(1 lettre et 1 recommandé\)/)
      assert.match(recu.text, /dont 1 déjà ouvert et numérisé/)
      // Ni l'expéditeur ni le document dans un courriel (ADR 015).
      assert.doesNotMatch(recu.text, /URSSAF/)
      assert.deepEqual(rien.to, ['paul@petit.fr'])
      assert.match(rien.subject, /Pas de courrier/)
    })

    it('ne redit pas « pas de courrier » à la seconde tournée du jour', async () => {
      const premiere = await enregistre(DURAND)
      await closeOpenBatch(ACCUEIL, premiere.batchId)
      await notifyMailBatchClosed(premiere.batchId, options)
      envoyes = []

      const seconde = await enregistre(DURAND)
      await closeOpenBatch(ACCUEIL, seconde.batchId)
      const recipients = await batchRecipients(seconde.batchId)
      assert.equal(recipients.firstOfDay, false)
      assert.deepEqual(await notifyMailBatchClosed(seconde.batchId, options), { received: 1, none: 0, failed: 0 })
    })

    it('sans courrier, une tournée terminée vide prévient tous les domiciliés', async () => {
      const batchId = await closeOpenBatch(ACCUEIL)
      const recipients = await batchRecipients(batchId)
      assert.deepEqual(recipients.received, [])
      assert.deepEqual([...recipients.none].sort(), [DURAND, PETIT].sort())
      const [resume] = await listRecentBatches()
      assert.equal(resume.id, batchId)
      assert.equal(resume.itemCount, 0)
    })

    it('un pli retiré ne compte pas', async () => {
      const { id, batchId } = await enregistre(DURAND)
      await asTenant((tx) => tx.execute(sql`update mail_items set deleted_at = current_timestamp(3) where id = ${id}`))
      await closeOpenBatch(ACCUEIL, batchId)
      const recipients = await batchRecipients(batchId)
      assert.deepEqual(recipients.received, [])
      assert.deepEqual([...recipients.none].sort(), [DURAND, PETIT].sort())
    })

    it('respecte le renoncement à l’avis « pas de courrier »', async () => {
      await asTenant((tx) =>
        tx.execute(sql`
          insert into notification_preferences (client_id, client_member_id, category, enabled)
          values (${PETIT}, ${PAUL}, 'mail_none', 0)`),
      )
      const batchId = await closeOpenBatch(ACCUEIL)
      await notifyMailBatchClosed(batchId, options)
      assert.deepEqual(envoyes.map((message) => message.to[0]), ['jeanne@durand.fr'])
    })
  })
})
