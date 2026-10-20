import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_MAIL_REFUSED, dbErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { recordScanRequestDone, requestScan } from './demandes-queries.ts'
import { correctScanPageCount, PagesLockedError, recordOpening, type StoredScan } from './queries.ts'

/**
 * Le relevé mensuel du courrier, ce que le centre reporte dans Dolibarr
 * (ADR 044, 046), éprouvé contre la base sous l'identité applicative :
 *
 * - le nombre de pages d'un contenu se corrige pendant le mois où il figure au
 *   relevé, plus ensuite — ni par le code, ni par une écriture directe.
 */
describe('relevé du courrier', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const DURAND = '01a00000-0000-7000-8000-0000000e1c01'
  const JEANNE = '01a00000-0000-7000-8000-0000000e1d01'
  const CAMILLE = '01a00000-0000-7000-8000-0000000e1e01'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]

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

  const contenu = (nom: string, pageCount: number): StoredScan[] => [
    {
      side: 'content',
      key: `courrier/test/releve-${nom}.pdf`,
      scan: { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), contentType: 'application/pdf', pageCount },
      encryptionKeyVersion: 1,
    },
  ]

  /** Un pli fermé de Durand. */
  const pli = async () => {
    const id = uuidv7()
    await asTenant((tx) => tx.execute(sql`insert into mail_items (id, client_id, sender) values (${id}, ${DURAND}, 'URSSAF')`))
    return id
  }

  /** Un pli ouvert maintenant par l'accueil, avec un contenu de `pages` pages. */
  const ouvert = async (pages: number) => {
    const id = await pli()
    await recordOpening(id, CAMILLE, contenu(id, pages))
    return { id, scanId: await contenuDe(id) }
  }

  /** Un pli ouvert il y a quarante jours : son mois est terminé. */
  const ouvertLeMoisDernier = async (pages: number) => {
    const id = uuidv7()
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into mail_items (id, client_id, sender, status, received_at, opened_at, opened_by)
        values (${id}, ${DURAND}, 'URSSAF', 'opened',
                TIMESTAMPADD(DAY, -41, CURRENT_TIMESTAMP(3)), TIMESTAMPADD(DAY, -40, CURRENT_TIMESTAMP(3)), ${CAMILLE})`)
      await tx.execute(sql`
        insert into mail_scans (id, mail_item_id, side, storage_key, content_type, byte_size, page_count)
        values (${uuidv7()}, ${id}, 'content', ${`courrier/test/releve-${id}.pdf`}, 'application/pdf', 1200, ${pages})`)
    })
    return { id, scanId: await contenuDe(id) }
  }

  const contenuDe = async (mailItemId: string, mailRequestId: string | null = null) => {
    const [scan] = await lire(
      "select id from mail_scans where mail_item_id = ? and side = 'content' and mail_request_id <=> ?",
      [mailItemId, mailRequestId],
    )
    return scan.id as string
  }

  const pages = async (scanId: string) =>
    Number((await lire('select page_count from mail_scans where id = ?', [scanId]))[0].page_count)

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await viderTables(
      bases.owner,
      'mail_scan_views',
      'mail_scans',
      'mail_requests',
      'mail_items',
      'client_members',
      'clients',
      'staff_members',
    )
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into clients (id, name, status) values (${DURAND}, 'Atelier Durand', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id)
        values (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand', 'u-jeanne')`)
      await tx.execute(sql`insert into staff_members (id, email, full_name) values (${CAMILLE}, 'camille@centre.fr', 'Camille')`)
    })
  })

  after(async () => {
    delete (globalThis as { database?: unknown }).database
    await bases?.fermer()
  })

  describe('correction du nombre de pages', () => {
    it('se corrige pendant le mois du relevé', async () => {
      const { scanId } = await ouvert(9)
      assert.equal(await correctScanPageCount(scanId, 8), true)
      assert.equal(await pages(scanId), 8)
    })

    it('ne se corrige plus une fois le mois terminé : elle se fait dans Dolibarr', async () => {
      const { scanId } = await ouvertLeMoisDernier(9)
      await assert.rejects(
        () => correctScanPageCount(scanId, 8),
        (error) => error instanceof PagesLockedError && /Corrigez-les dans Dolibarr/.test(error.message),
      )
      // La base a le dernier mot : une écriture directe est refusée aussi.
      assert.equal(
        await codeErreur(() => asTenant((tx) => tx.execute(sql`update mail_scans set page_count = 8 where id = ${scanId}`))),
        DB_MAIL_REFUSED,
      )
      assert.equal(await pages(scanId), 9)
    })

    it('date une numérisation demandée par sa fin, pas par l’ouverture du pli', async () => {
      // Pli ouvert le mois dernier, numérisé à nouveau ce mois-ci : le
      // contenu demandé figure au relevé de ce mois, il se corrige encore.
      const { id } = await ouvertLeMoisDernier(2)
      const demande = await requestScan(id, durand, null)
      assert.ok(demande.ok)
      await recordScanRequestDone(demande.requestId, CAMILLE, contenu(demande.requestId, 4))
      const scanId = await contenuDe(id, demande.requestId)
      assert.equal(await correctScanPageCount(scanId, 3), true)
      assert.equal(await pages(scanId), 3)
    })
  })
})
