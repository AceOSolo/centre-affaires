import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { addMonthsToIsoMonth, todayIsoDate } from '../../lib/dates.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import {
  MailRequestError,
  completeForwardRequest,
  recordScanRequestDone,
  refuseMailRequest,
  requestForward,
  requestScan,
  updateForwardShipping,
} from '../courrier/demandes-queries.ts'
import type { StoredScan } from '../courrier/queries.ts'
import { findInvoice, listInvoices } from './factures-queries.ts'
import { runInvoicing } from './lot-queries.ts'

/**
 * Facturation des demandes de courrier par le lot (R14, R21, ADR 037), sous
 * `app_centre`, par le code des écrans :
 *
 * - une numérisation seule et une réexpédition faites deviennent des lignes
 *   d'actes de la facture du client, au service de leur nature, les inclus de
 *   la souscription d'abord ;
 * - les frais d'affranchissement relevés deviennent une ligne à côté, au
 *   centime ; relevés après le lot, ils rejoignent le suivant ;
 * - rejoué, le lot ne refacture rien ; une demande refusée ne se facture pas ;
 *   des frais facturés ne se modifient plus.
 *
 * Les demandes sont faites maintenant : le lot du mois prochain, qui facture
 * les consommations du mois en cours (à échoir), les reprend.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('lot de facturation : demandes de courrier', { skip: raison }, () => {
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const ACCUEIL = '01a00000-0000-7000-8000-0000000f2d01'
  const DURAND = '01a00000-0000-7000-8000-0000000f2c01'
  const JEANNE = '01a00000-0000-7000-8000-0000000f2c11'
  const NUMERISATION = '01a00000-0000-7000-8000-0000000f2e01'
  const REEXPEDITION = '01a00000-0000-7000-8000-0000000f2e02'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]
  const ADRESSE = {
    recipient: 'Jeanne Durand',
    line1: '12 rue des Lilas',
    line2: null,
    postalCode: '38000',
    city: 'Grenoble',
    country: 'FR',
  }

  // Le mois prochain facture les consommations de ce mois (terme à échoir).
  const MOIS = addMonthsToIsoMonth(todayIsoDate('Europe/Paris').slice(0, 7), 1)

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, app.db)

  const pli = async (ouvert: boolean): Promise<string> => {
    const [row] = await asTenant((tx) =>
      tx.execute(sql`
        insert into mail_items (client_id, sender, status, opened_at, opened_by)
        values (${DURAND}, 'URSSAF', ${ouvert ? 'opened' : 'received'}, ${ouvert ? sql`now()` : null},
                ${ouvert ? ACCUEIL : null})
        returning id`),
    )
    return row.id as string
  }

  const depose = (nom: string): StoredScan[] => [
    {
      side: 'content',
      key: `courrier/test/lot-${nom}.pdf`,
      scan: { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), contentType: 'application/pdf' },
      encryptionKeyVersion: 1,
    },
  ]

  const demandeFaite = async (kind: 'scan' | 'forward', postageCents: number | null = null) => {
    const item = await pli(kind === 'scan')
    const outcome = kind === 'scan' ? await requestScan(item, durand, null) : await requestForward(item, durand, ADRESSE, null)
    assert.ok(outcome.ok)
    if (kind === 'scan') await recordScanRequestDone(outcome.requestId, ACCUEIL, depose(outcome.requestId))
    else await completeForwardRequest(outcome.requestId, ACCUEIL, { trackingNumber: null, postageCents })
    return outcome.requestId
  }

  /** Avertissements du lot qui ne tiennent pas aux plis ouverts par l'accueil pour les besoins du test. */
  const avertissements = (warnings: { message: string }[] | undefined) =>
    (warnings ?? []).map((warning) => warning.message).filter((message) => !/plis? ouverts?/.test(message))

  const lignes = async () => {
    const factures = (await listInvoices({ clientId: DURAND })).filter((invoice) => invoice.kind === 'invoice')
    const all = []
    for (const facture of factures) {
      const detail = await findInvoice(facture.id)
      assert.ok(detail)
      all.push(...detail.lines.map((line) => ({ ...line, periodStartOfInvoice: detail.invoice.periodStart })))
    }
    return all
  }

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`truncate table document_sequences`
    await owner.client`
      update tenants set recurring_billing_timing = 'in_advance', prorata_rule = 'calendar_days'
      where id = ${DEFAULT_TENANT_ID}`
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, role) values (${ACCUEIL}, 'accueil@centre.fr', 'admin')`)
      await tx.execute(sql`insert into clients (id, name, status) values (${DURAND}, 'Atelier Durand', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id)
        values (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand', 'u-jeanne')`)
      // Catalogue : numérisation 2 €, réexpédition 5 € (hors affranchissement).
      await tx.execute(sql`
        insert into services (id, code, name, nature, unit, unit_price_cents) values
          (${NUMERISATION}, 'courrier.numerisation', 'Numérisation d’un pli', 'act', 'unit', 200),
          (${REEXPEDITION}, 'courrier.reexpedition', 'Réexpédition d’un pli', 'act', 'unit', 500)`)
      // Durand : une numérisation incluse par mois, 1,50 € au-delà.
      await tx.execute(sql`
        insert into subscribed_services (client_id, service_id, quantity, unit, unit_price_cents,
                                         vat_rate_bp, included_quantity, starts_on)
        values (${DURAND}, ${NUMERISATION}, 1, 'unit', 150, 2000, 1, '2026-01-01')`)
    })
  })

  after(async () => {
    await owner.client`truncate table bookings, contracts, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  it('facture numérisations et réexpédition faites, inclus d’abord, et les frais relevés à côté', async () => {
    const premiere = await demandeFaite('scan')
    const seconde = await demandeFaite('scan')
    const reexpedition = await demandeFaite('forward', 435)
    // Refusée : jamais facturée.
    const item = await pli(true)
    const refusee = await requestScan(item, durand, null)
    assert.ok(refusee.ok)
    await refuseMailRequest(refusee.requestId, ACCUEIL, 'Pli illisible.')

    const { report } = await runInvoicing(MOIS, ACCUEIL)
    assert.equal(report.invoicesCreated, 1)
    // Les plis ouverts par l'accueil (sans service d'ouverture ici) sont à part.
    assert.deepEqual(avertissements(report.warnings), [])

    const factures = await lignes()
    assert.deepEqual(
      factures.map((line) => [line.kind, line.mailRequestId, line.netAmountCents, line.serviceId]),
      [
        ['act', premiere, 0, NUMERISATION],
        ['act', seconde, 150, NUMERISATION],
        ['act', reexpedition, 500, REEXPEDITION],
        ['other', reexpedition, 435, null],
      ],
    )
    assert.match(factures[0].description, /inclus/)
    assert.ok(factures.every((line) => line.mailItemId === null))

    // Rejoué : rien de plus, rien de refusé par la base.
    const rejoue = await runInvoicing(MOIS, ACCUEIL)
    assert.equal(rejoue.report.linesCreated, 0)
    assert.deepEqual(avertissements(rejoue.report.warnings), [])

    // Facturés, les frais ne changent plus ; le suivi, si.
    await assert.rejects(
      updateForwardShipping(reexpedition, { trackingNumber: null, postageCents: 500 }),
      (error: unknown) => error instanceof MailRequestError && /facturée/.test(error.message),
    )
    await updateForwardShipping(reexpedition, { trackingNumber: '1A2345', postageCents: 435 })
  })

  it('fait attendre une réexpédition sans frais relevés, puis la facture avec eux au lot rejoué', async () => {
    const reexpedition = await demandeFaite('forward')
    const sansFrais = await demandeFaite('forward', 0)

    const { report } = await runInvoicing(MOIS, ACCUEIL)
    assert.deepEqual(
      avertissements(report.warnings),
      ['1 réexpédition non facturée : frais d’affranchissement non relevés. Notez-les sur la demande (0 s’il n’y en a pas), puis relancez le lot.'],
    )
    // Des frais nuls : l'acte seul, sans ligne de frais.
    assert.deepEqual(
      (await lignes()).map((line) => [line.kind, line.mailRequestId, line.netAmountCents]),
      [['act', sansFrais, 500]],
    )

    // Les frais notés, le lot rejoué facture l'acte et ses frais, au même brouillon.
    await updateForwardShipping(reexpedition, { trackingNumber: null, postageCents: 290 })
    const rejoue = await runInvoicing(MOIS, ACCUEIL)
    assert.equal(rejoue.report.invoicesUpdated, 1)
    assert.deepEqual(avertissements(rejoue.report.warnings), [])
    const toutes = await lignes()
    assert.deepEqual(
      toutes.map((line) => [line.kind, line.mailRequestId, line.netAmountCents]),
      [
        ['act', sansFrais, 500],
        ['act', reexpedition, 500],
        ['other', reexpedition, 290],
      ],
    )
    assert.match(
      toutes.find((line) => line.kind === 'other')?.description ?? '',
      /^Frais d’affranchissement — réexpédition du \d{2}\/\d{2}\/\d{4}$/,
    )
    // Le lot suivant ne reprend rien : elles sont de ce mois-ci.
    const suivant = await runInvoicing(addMonthsToIsoMonth(MOIS, 1), ACCUEIL)
    assert.equal(suivant.report.linesCreated, 0)
  })
})
