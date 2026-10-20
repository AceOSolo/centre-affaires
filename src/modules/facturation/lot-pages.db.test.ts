import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_INVOICE_INVALID, DB_MAIL_REFUSED, dbErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { addMonthsToIsoMonth, todayIsoDate } from '../../lib/dates.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { toutVider } from '../clients/test-support.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { recordScanRequestDone, requestScan } from '../courrier/demandes-queries.ts'
import { correctScanPageCount, recordOpening, type StoredScan } from '../courrier/queries.ts'
import { findInvoice, listInvoices } from './factures-queries.ts'
import { runInvoicing } from './lot-queries.ts'

/**
 * Pages numérisées au-delà de l'ouverture (ADR 044), du dépôt à la facture,
 * sous l'identité applicative :
 *
 * - le lot facture, pli par pli, les pages au-delà de celles comprises dans
 *   l'ouverture, au service `courrier.page`, une seule fois ;
 * - une numérisation demandée ensuite se facture par sa demande, pas à la page ;
 * - la base refuse plus de pages que comptées, et la correction de pages déjà
 *   facturées.
 */
describe('lot de facturation : pages numérisées', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const ACCUEIL = '01a00000-0000-7000-8000-0000000f5a01'
  const DURAND = '01a00000-0000-7000-8000-0000000f5b01'
  const JEANNE = '01a00000-0000-7000-8000-0000000f5c01'
  const OUVERTURE = '01a00000-0000-7000-8000-0000000f5d01'
  const PAGE = '01a00000-0000-7000-8000-0000000f5d02'
  const NUMERISATION = '01a00000-0000-7000-8000-0000000f5d03'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]
  // Le mois prochain facture les consommations de ce mois (terme à échoir).
  const MOIS = addMonthsToIsoMonth(todayIsoDate('Europe/Paris').slice(0, 7), 1)

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
      key: `courrier/test/pages-${nom}.pdf`,
      scan: { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), contentType: 'application/pdf', pageCount },
      encryptionKeyVersion: 1,
    },
  ]

  /** Un pli fermé, puis ouvert par l'accueil avec un contenu de `pages` pages. */
  const ouvert = async (pages: number) => {
    const id = uuidv7()
    await asTenant((tx) => tx.execute(sql`insert into mail_items (id, client_id, sender) values (${id}, ${DURAND}, 'URSSAF')`))
    await recordOpening(id, ACCUEIL, contenu(id, pages))
    const [scan] = await lire("select id from mail_scans where mail_item_id = ? and side = 'content'", [id])
    return { id, scanId: scan.id as string }
  }

  const lignes = async () => {
    const factures = (await listInvoices({ clientId: DURAND })).filter((invoice) => invoice.kind === 'invoice')
    const all = []
    for (const facture of factures) {
      const detail = await findInvoice(facture.id)
      assert.ok(detail)
      all.push(...detail.lines)
    }
    return all
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query('select seed_accounting_accounts(?)', [DEFAULT_TENANT_ID])
    // Cinq pages comprises dans l'ouverture.
    await bases.owner.client.query(
      `update tenants set recurring_billing_timing = 'in_advance', prorata_rule = 'calendar_days',
              mail_opening_included_pages = 5
       where id = ?`,
      [DEFAULT_TENANT_ID],
    )
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, role) values (${ACCUEIL}, 'accueil@centre.fr', 'admin')`)
      await tx.execute(sql`insert into clients (id, name, status) values (${DURAND}, 'Atelier Durand', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id)
        values (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand', 'u-jeanne')`)
      // Ouverture 3 €, page au-delà 0,20 €, numérisation demandée 2 €.
      await tx.execute(sql`
        insert into services (id, code, name, nature, unit, unit_price_cents) values
          (${OUVERTURE}, 'courrier.ouverture', 'Ouverture et numérisation', 'act', 'unit', 300),
          (${PAGE}, 'courrier.page', 'Page numérisée au-delà de l’ouverture', 'act', 'unit', 20),
          (${NUMERISATION}, 'courrier.numerisation', 'Numérisation d’un pli', 'act', 'unit', 200)`)
    })
  })

  after(async () => {
    await toutVider(bases.owner)
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  it('facture les pages au-delà des comprises, pli par pli, une seule fois', async () => {
    const long = await ouvert(12)
    const court = await ouvert(3)

    const { report } = await runInvoicing(MOIS, ACCUEIL)
    assert.equal(report.invoicesCreated, 1)
    const factures = await lignes()
    assert.deepEqual(
      factures
        .map((line) => [line.mailItemId, line.mailScanId, line.quantity, line.netAmountCents, line.serviceId])
        .sort((a, b) => String(a[2]).localeCompare(String(b[2]))),
      [
        [long.id, null, 1, 300, OUVERTURE],
        [court.id, null, 1, 300, OUVERTURE],
        [null, long.scanId, 7, 140, PAGE],
      ].sort((a, b) => String(a[2]).localeCompare(String(b[2]))),
    )

    // Rejoué : rien de plus.
    const rejoue = await runInvoicing(MOIS, ACCUEIL)
    assert.equal(rejoue.report.linesCreated, 0)
  })

  it('ne facture pas à la page une numérisation demandée ensuite', async () => {
    const pli = await ouvert(2)
    const demande = await requestScan(pli.id, durand, null)
    assert.ok(demande.ok)
    await recordScanRequestDone(demande.requestId, ACCUEIL, contenu(demande.requestId, 40))

    await runInvoicing(MOIS, ACCUEIL)
    const factures = await lignes()
    assert.equal(factures.filter((line) => line.mailScanId !== null).length, 0)
    assert.equal(factures.filter((line) => line.mailRequestId === demande.requestId).length, 1)
  })

  it('refuse plus de pages que comptées, et une correction de pages facturées', async () => {
    const long = await ouvert(9)
    // Avant facturation, l'accueil corrige un compte faux.
    assert.equal(await correctScanPageCount(long.scanId, 8), true)
    await runInvoicing(MOIS, ACCUEIL)
    const [ligne] = (await lignes()).filter((line) => line.mailScanId === long.scanId)
    assert.equal(ligne.quantity, 3)

    // Sur le brouillon : pas davantage que les pages comptées.
    assert.equal(
      await codeErreur(() => asTenant((tx) => tx.execute(sql`update invoice_lines set quantity = 9 where id = ${ligne.id}`))),
      DB_INVOICE_INVALID,
    )
    // Facturées, les pages ne se corrigent plus.
    assert.equal(await codeErreur(() => correctScanPageCount(long.scanId, 6)), DB_MAIL_REFUSED)
  })

  it('refuse une ligne de pages avec un autre service que celui des pages', async () => {
    const long = await ouvert(9)
    await runInvoicing(MOIS, ACCUEIL)
    const [ligne] = (await lignes()).filter((line) => line.mailScanId === long.scanId)
    assert.equal(
      await codeErreur(() =>
        asTenant((tx) => tx.execute(sql`update invoice_lines set service_id = ${NUMERISATION} where id = ${ligne.id}`)),
      ),
      DB_INVOICE_INVALID,
    )
  })
})
