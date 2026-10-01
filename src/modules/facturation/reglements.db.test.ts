import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { addDaysToIsoDate, todayIsoDate } from '../../lib/dates.ts'
import {
  EmptyExportError,
  generateAccountingExport,
  listAccountingExports,
  listInvoicedClientCodes,
  rebuildAccountingExport,
  saveClientAccountingCodes,
} from './comptabilite.ts'
import { checkEn16931, toEn16931 } from './en16931.ts'
import { FecExportError } from './fec.ts'
import { openIban } from './iban.ts'
import {
  ActiveMandateExistsError,
  createMandate,
  invoicePaymentSetup,
  listClientMandates,
  revokeMandate,
} from './mandats.ts'
import {
  RemittanceError,
  buildRemittanceFile,
  listDirectDebitCandidates,
  listRemittances,
  prepareDirectDebitRemittance,
} from './prelevements.ts'
import {
  PaymentAmountError,
  PaymentRefusedError,
  cancelPayment,
  findInvoiceIdByNumber,
  findInvoiceSettlement,
  findReminderContexts,
  listOpenInvoices,
  listRecentPayments,
  recordPayment,
} from './reglements.ts'
import { invoices, payments, sepaMandates } from './schema-factures.ts'

/**
 * Règlements (R16, ADR 027, ADR 030), contre la base et sous `app_centre`,
 * par les fonctions mêmes que les écrans appellent :
 *
 * - pointage d'un paiement, partiel, total, trop-perçu, remboursement,
 *   annulation, et statut de la facture qui suit ;
 * - factures échues à relancer ;
 * - mandats SEPA : IBAN chiffré, jamais en clair, un seul actif ;
 * - remise de prélèvements : factures marquées, fichier reconstruit,
 *   `FRST` puis `RCUR`, rejet ;
 * - export comptable : équilibre, journal et empreinte ;
 * - représentation EN 16931 d'une facture réellement émise.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

const PARIS = 'Europe/Paris'

describe('règlements', { skip: raison }, () => {
  // Les requêtes du module ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl
  // Clé des documents propre au test : les IBAN des mandats sont chiffrés avec elle.
  process.env.DOCUMENTS_ENCRYPTION_KEY = randomBytes(32).toString('base64')
  process.env.DOCUMENTS_ENCRYPTION_KEY_VERSION = '1'

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const ACCUEIL = '01a00000-0000-7000-8000-0000000e0d01'
  const DURAND = '01a00000-0000-7000-8000-0000000e0c01'
  const PETIT = '01a00000-0000-7000-8000-0000000e0c02'
  const IBAN_DURAND = 'FR1420041010050500013M02606'

  const today = () => todayIsoDate(PARIS)

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, app.db)

  /** Facture émise d'une ligne HT, à 20 %. */
  const factureEmise = async ({
    clientId = DURAND,
    netCents = 10_000,
    vatRateBp = 2_000,
    values = {},
  }: {
    clientId?: string
    netCents?: number
    vatRateBp?: number
    values?: Partial<typeof invoices.$inferInsert>
  } = {}): Promise<{ id: string; number: string }> => {
    const [draft] = await asTenant((tx) =>
      tx
        .insert(invoices)
        .values({ clientId, periodStart: '2026-09-01', periodEnd: '2026-09-30', ...values })
        .returning({ id: invoices.id }),
    )
    await asTenant((tx) =>
      tx.execute(sql`
        insert into invoice_lines (invoice_id, kind, description, unit_price_cents, vat_rate_bp)
        values (${draft.id}, 'other', 'Domiciliation — septembre 2026', ${netCents}, ${vatRateBp})`),
    )
    const [row] = await asTenant((tx) =>
      tx.execute(sql`select issue_invoice(${draft.id}::uuid, ${ACCUEIL}::uuid) as numero`),
    )
    return { id: draft.id, number: row.numero as string }
  }

  const statut = async (id: string) => {
    const [row] = await asTenant((tx) =>
      tx.select({ status: invoices.status, paidCents: invoices.paidCents }).from(invoices).where(eq(invoices.id, id)),
    )
    return row
  }

  const pointer = (invoiceId: string, amountCents: number, overpaymentConfirmed = false) =>
    recordPayment(
      invoiceId,
      { amountCents, paidOn: today(), method: 'transfer', reference: 'VIR 1', notes: null, overpaymentConfirmed },
      ACCUEIL,
    )

  const errorOf = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run()
    } catch (error) {
      return error
    }
    return undefined
  }

  const mandatDurand = () =>
    createMandate(
      DURAND,
      { debtorName: 'Atelier Durand', iban: IBAN_DURAND, bic: 'PSSTFRPPXXX', signedOn: '2026-01-15', sequenceType: 'recurrent' },
      today(),
    )

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`truncate table document_sequences`
    await owner.client`select seed_accounting_accounts(${DEFAULT_TENANT_ID}::uuid)`
    await owner.client`
      update tenants set
        legal_name = 'Centre de démonstration SAS', legal_form = 'SAS', share_capital_cents = 1000000,
        address_line1 = '1 rue de l''Exemple', postal_code = '38070', city = 'Saint-Quentin-Fallavier',
        siren = '123456789', siret = '12345678900012', vat_number = 'FR32123456789', rcs_city = 'Vienne',
        bank_iban = 'FR7630006000011234567890189', bank_bic = 'AGRIFRPP', sepa_creditor_id = 'FR12ZZZ123456'
      where id = ${DEFAULT_TENANT_ID}`
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, full_name) values (${ACCUEIL}, 'accueil@centre.fr', 'Claire Accueil')`)
      await tx.execute(sql`
        insert into clients (id, name, siret, email, address_line1, postal_code, city) values
          (${DURAND}, 'Atelier Durand', '98765432100015', 'contact@durand.fr', '2 place du Marché', '38000', 'Grenoble'),
          (${PETIT}, 'Boulangerie Petit', '44306184100047', null, '3 rue du Four', '69001', 'Lyon')`)
    })
  })

  after(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`
      update tenants set legal_name = null, legal_form = null, share_capital_cents = null,
        address_line1 = null, postal_code = null, city = null, siren = null, siret = null,
        vat_number = null, rcs_city = null, bank_iban = null, bank_bic = null, sepa_creditor_id = null
      where id = ${DEFAULT_TENANT_ID}`
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  describe('pointage des paiements', () => {
    it('suit le statut : en partie, puis réglée', async () => {
      const { id } = await factureEmise()
      assert.equal((await statut(id)).status, 'issued')
      await pointer(id, 5_000)
      assert.deepEqual(await statut(id), { status: 'partially_paid', paidCents: 5_000 })
      await pointer(id, 7_000)
      assert.deepEqual(await statut(id), { status: 'paid', paidCents: 12_000 })
    })

    it('refuse un trop-perçu non assumé, l’enregistre une fois confirmé', async () => {
      const { id } = await factureEmise()
      const error = await errorOf(() => pointer(id, 120_000))
      assert.ok(error instanceof PaymentAmountError)
      assert.equal((await statut(id)).paidCents, 0)
      await pointer(id, 12_500, true)
      const settlement = await findInvoiceSettlement(id)
      assert.equal(settlement?.invoice.status, 'paid')
      assert.equal(settlement?.invoice.paidCents, 12_500)
    })

    it('borne un remboursement à ce qui a été reçu, et le porte en négatif', async () => {
      const { id } = await factureEmise()
      await pointer(id, 12_500, true)
      assert.ok((await errorOf(() => pointer(id, -12_501))) instanceof PaymentAmountError)
      await pointer(id, -500)
      assert.deepEqual(await statut(id), { status: 'paid', paidCents: 12_000 })
    })

    it('refuse de pointer un brouillon ou un avoir', async () => {
      const [draft] = await asTenant((tx) =>
        tx
          .insert(invoices)
          .values({ clientId: DURAND, periodStart: '2026-09-01', periodEnd: '2026-09-30' })
          .returning({ id: invoices.id }),
      )
      const onDraft = await errorOf(() => pointer(draft.id, 100))
      assert.ok(onDraft instanceof PaymentRefusedError)
      assert.match(onDraft.message, /brouillon/)

      const { id } = await factureEmise()
      const [credit] = await asTenant((tx) => tx.execute(sql`select draft_credit_note(${id}::uuid, 'Erreur') as id`))
      await asTenant((tx) => tx.execute(sql`select issue_invoice(${credit.id as string}::uuid, ${ACCUEIL}::uuid)`))
      const onCredit = await errorOf(() => pointer(credit.id as string, 100))
      assert.ok(onCredit instanceof PaymentRefusedError)
      assert.match(onCredit.message, /avoir/)
    })

    it('annule un pointage sans l’effacer : la facture redevient à régler', async () => {
      const { id } = await factureEmise()
      const payment = await pointer(id, 12_000)
      assert.equal((await statut(id)).status, 'paid')

      assert.equal(await cancelPayment({ invoiceId: id, paymentId: payment.id, reason: 'Erreur de saisie', cancelledBy: ACCUEIL }), true)
      assert.equal(await cancelPayment({ invoiceId: id, paymentId: payment.id, reason: 'Encore', cancelledBy: ACCUEIL }), false)
      assert.deepEqual(await statut(id), { status: 'issued', paidCents: 0 })

      const settlement = await findInvoiceSettlement(id)
      assert.equal(settlement?.payments.length, 1)
      assert.equal(settlement?.payments[0].cancellationReason, 'Erreur de saisie')
      assert.equal(settlement?.payments[0].cancelledByName, 'Claire Accueil')
      assert.equal(settlement?.payments[0].recordedByName, 'Claire Accueil')
      const recent = await listRecentPayments()
      assert.equal(recent[0].invoiceNumber, settlement?.invoice.number)
    })

    it('retrouve une facture par son numéro', async () => {
      const { id, number } = await factureEmise()
      assert.equal(await findInvoiceIdByNumber(` ${number.toLowerCase()} `), id)
      assert.equal(await findInvoiceIdByNumber('FA-1999-0001'), undefined)
      assert.equal(await findInvoiceIdByNumber('n’importe quoi'), undefined)
    })
  })

  describe('factures à relancer', () => {
    it('sépare les échues des factures à échoir, et en déduit le palier', async () => {
      const due = addDaysToIsoDate(today(), 30)
      const { id } = await factureEmise()
      const { id: paid } = await factureEmise({ clientId: PETIT })
      await pointer(paid, 12_000)
      await pointer(id, 2_000)

      assert.deepEqual(
        (await listOpenInvoices({ today: today(), overdue: false })).map((row) => [row.id, row.amountDueCents]),
        [[id, 10_000]],
      )
      assert.deepEqual(await listOpenInvoices({ today: today(), overdue: true }), [])

      const later = addDaysToIsoDate(due, 16)
      const overdue = await listOpenInvoices({ today: later, overdue: true })
      assert.deepEqual(
        overdue.map((row) => [row.id, row.dueDate, row.daysOverdue, row.level]),
        [[id, due, 16, 2]],
      )
    })

    it('adresse la relance aux contacts « factures », sinon à l’adresse de la fiche', async () => {
      const { id } = await factureEmise()
      const { id: other } = await factureEmise({ clientId: PETIT })
      await asTenant((tx) =>
        tx.execute(sql`
          insert into client_contacts (client_id, full_name, email, is_billing) values
            (${DURAND}, 'Cabinet Comptable', 'compta@cabinet.fr', true),
            (${DURAND}, 'Gérante', 'gerante@durand.fr', false)`),
      )
      const contexts = await findReminderContexts([id, other])
      const byInvoice = new Map(contexts.map((context) => [context.invoice.id, context.recipients]))
      assert.deepEqual(byInvoice.get(id), ['compta@cabinet.fr'])
      assert.deepEqual(byInvoice.get(other), [])
      assert.equal(contexts[0].tenant.bankIban, 'FR7630006000011234567890189')
    })
  })

  describe('mandats SEPA', () => {
    it('chiffre l’IBAN : la base ne le contient pas en clair, la RUM le relit', async () => {
      const { id, reference } = await mandatDurand()
      assert.match(reference, /^RUM-\d{8}-[A-Z2-9]{6}$/)

      const [stored] = await owner.client`select iban_ciphertext, iban_last4 from sepa_mandates where id = ${id}`
      const bytes = Buffer.from(stored.iban_ciphertext as Uint8Array)
      assert.equal(bytes.includes(Buffer.from(IBAN_DURAND)), false)
      assert.equal(bytes.includes(Buffer.from('2004101005')), false)
      assert.equal(stored.iban_last4, '2606')
      assert.equal(openIban(bytes, 1, { tenantId: DEFAULT_TENANT_ID, reference }), IBAN_DURAND)

      const listed = await listClientMandates(DURAND, today())
      assert.equal(listed.length, 1)
      assert.equal('ibanCiphertext' in listed[0], false)
      assert.equal(JSON.stringify(listed).includes('2004101005'), false)
      assert.equal(listed[0].ibanLast4, '2606')
      assert.equal(listed[0].lapsed, false)
    })

    it('donne à une nouvelle facture le prélèvement sur le mandat actif, sinon le mode du centre', async () => {
      const setup = (clientId: string) =>
        withTenant(DEFAULT_TENANT_ID, (tx) => invoicePaymentSetup(tx, clientId, today()), app.db)
      assert.deepEqual(await setup(DURAND), { expectedPaymentMethod: 'transfer', sepaMandateId: null })
      const mandate = await mandatDurand()
      assert.deepEqual(await setup(DURAND), { expectedPaymentMethod: 'direct_debit', sepaMandateId: mandate.id })
      // Un centre « prélèvement par défaut » ne prélève pas un client sans mandat.
      await owner.client`update tenants set default_payment_method = 'direct_debit' where id = ${DEFAULT_TENANT_ID}`
      try {
        assert.deepEqual(await setup(PETIT), { expectedPaymentMethod: 'transfer', sepaMandateId: null })
      } finally {
        await owner.client`update tenants set default_payment_method = 'transfer' where id = ${DEFAULT_TENANT_ID}`
      }
      await revokeMandate(DURAND, mandate.id, today())
      assert.deepEqual(await setup(DURAND), { expectedPaymentMethod: 'transfer', sepaMandateId: null })
    })

    it('n’admet qu’un mandat actif ; une fois révoqué, un nouveau prend la suite', async () => {
      const first = await mandatDurand()
      assert.ok((await errorOf(mandatDurand)) instanceof ActiveMandateExistsError)

      assert.equal(await revokeMandate(DURAND, first.id, today()), true)
      assert.equal(await revokeMandate(DURAND, first.id, today()), false)
      const second = await mandatDurand()
      assert.notEqual(second.reference, first.reference)

      const listed = await listClientMandates(DURAND, today())
      assert.deepEqual(
        listed.map((mandate) => [mandate.reference, mandate.status, mandate.revokedOn]).sort(),
        [
          [first.reference, 'revoked', today()],
          [second.reference, 'active', null],
        ].sort(),
      )
    })
  })

  describe('remise de prélèvements', () => {
    const facturePrelevee = async (mandateId: string) =>
      factureEmise({ values: { expectedPaymentMethod: 'direct_debit', sepaMandateId: mandateId, paymentTermsDays: 0 } })

    it('marque les factures, date le mandat et produit le fichier : FRST, puis RCUR', async () => {
      const mandate = await mandatDurand()
      const first = await facturePrelevee(mandate.id)
      const collection = addDaysToIsoDate(today(), 3)

      const candidates = await listDirectDebitCandidates({ collectionDate: collection, today: today() })
      assert.deepEqual(
        candidates.map((candidate) => [candidate.number, candidate.amountDueCents, candidate.blocker]),
        [[first.number, 12_000, null]],
      )
      assert.equal(candidates[0].mandate?.ibanLast4, '2606')

      const remittance = await prepareDirectDebitRemittance({
        invoiceIds: [first.id],
        collectionDate: collection,
        today: today(),
        recordedBy: ACCUEIL,
      })
      assert.equal(remittance.count, 1)
      assert.equal(remittance.totalCents, 12_000)
      assert.equal((await statut(first.id)).status, 'paid')
      const [dated] = await asTenant((tx) =>
        tx.select({ lastCollectedOn: sepaMandates.lastCollectedOn }).from(sepaMandates).where(eq(sepaMandates.id, mandate.id)),
      )
      assert.equal(dated.lastCollectedOn, collection)
      assert.deepEqual(await listDirectDebitCandidates({ collectionDate: collection, today: today() }), [])

      const file = await buildRemittanceFile(remittance.remittanceId)
      assert.ok(file)
      assert.equal(file.fileName, `${remittance.remittanceId}.xml`)
      assert.ok(file.xml.includes(`<MsgId>${remittance.remittanceId}</MsgId>`))
      assert.ok(file.xml.includes('<SeqTp>FRST</SeqTp>'))
      assert.ok(file.xml.includes(`<IBAN>${IBAN_DURAND}</IBAN>`))
      assert.ok(file.xml.includes(`<EndToEndId>${first.number}</EndToEndId>`))
      assert.ok(file.xml.includes('<InstdAmt Ccy="EUR">120.00</InstdAmt>'))
      assert.ok(file.xml.includes(`<ReqdColltnDt>${collection}</ReqdColltnDt>`))
      assert.ok(file.xml.includes(`<MndtId>${mandate.reference}</MndtId>`))
      // Reconstruit à l'identique.
      assert.equal((await buildRemittanceFile(remittance.remittanceId))?.xml, file.xml)

      const second = await facturePrelevee(mandate.id)
      const next = await prepareDirectDebitRemittance({
        invoiceIds: [second.id],
        collectionDate: collection,
        today: today(),
        recordedBy: ACCUEIL,
      })
      assert.ok((await buildRemittanceFile(next.remittanceId))?.xml.includes('<SeqTp>RCUR</SeqTp>'))
      // Le premier fichier ne change pas pour autant.
      assert.equal((await buildRemittanceFile(remittance.remittanceId))?.xml, file.xml)

      const remittances = await listRemittances()
      assert.deepEqual(
        remittances.map((row) => [row.remittanceId, row.activeCount, row.activeTotalCents]).sort(),
        [
          [remittance.remittanceId, 1, 12_000],
          [next.remittanceId, 1, 12_000],
        ].sort(),
      )
    })

    it('un rejet s’annule : la facture redevient à prélever', async () => {
      const mandate = await mandatDurand()
      const invoice = await facturePrelevee(mandate.id)
      const collection = addDaysToIsoDate(today(), 2)
      const remittance = await prepareDirectDebitRemittance({
        invoiceIds: [invoice.id],
        collectionDate: collection,
        today: today(),
        recordedBy: ACCUEIL,
      })
      const [payment] = await asTenant((tx) =>
        tx.select({ id: payments.id }).from(payments).where(eq(payments.reference, remittance.remittanceId)),
      )
      await cancelPayment({ invoiceId: invoice.id, paymentId: payment.id, reason: 'Rejet : provision insuffisante (AM04)', cancelledBy: ACCUEIL })
      assert.equal((await statut(invoice.id)).status, 'issued')
      assert.equal((await listDirectDebitCandidates({ collectionDate: collection, today: today() })).length, 1)

      const emptied = await errorOf(() => buildRemittanceFile(remittance.remittanceId))
      assert.ok(emptied instanceof RemittanceError)
      assert.equal(await buildRemittanceFile('PRLV-20260101-AAAAAA'), undefined)
    })

    it('refuse une facture au mandat révoqué, ou pas encore échue', async () => {
      const mandate = await mandatDurand()
      const invoice = await facturePrelevee(mandate.id)
      await revokeMandate(DURAND, mandate.id, today())
      const collection = addDaysToIsoDate(today(), 2)

      const [candidate] = await listDirectDebitCandidates({ collectionDate: collection, today: today() })
      assert.match(candidate.blocker ?? '', /révoqué/)
      const refused = await errorOf(() =>
        prepareDirectDebitRemittance({ invoiceIds: [invoice.id], collectionDate: collection, today: today(), recordedBy: ACCUEIL }),
      )
      assert.ok(refused instanceof RemittanceError)
      assert.match(refused.problems[0], /révoqué/)
      assert.equal((await statut(invoice.id)).status, 'issued')

      const fresh = await mandatDurand()
      const notDue = await factureEmise({
        values: { expectedPaymentMethod: 'direct_debit', sepaMandateId: fresh.id, paymentTermsDays: 30 },
      })
      const early = await errorOf(() =>
        prepareDirectDebitRemittance({ invoiceIds: [notDue.id], collectionDate: collection, today: today(), recordedBy: ACCUEIL }),
      )
      assert.ok(early instanceof RemittanceError)
      assert.match(early.problems[0], /pas échue/)
    })

    it('ne prélève pas deux fois la même facture, même en deux remises simultanées', async () => {
      const mandate = await mandatDurand()
      const invoice = await facturePrelevee(mandate.id)
      const collection = addDaysToIsoDate(today(), 2)
      const prepare = () =>
        prepareDirectDebitRemittance({ invoiceIds: [invoice.id], collectionDate: collection, today: today(), recordedBy: ACCUEIL })
      const results = await Promise.allSettled([prepare(), prepare()])
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
      const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
      assert.ok(rejected.reason instanceof RemittanceError)
      assert.equal((await statut(invoice.id)).paidCents, 12_000)
    })
  })

  describe('export comptable', () => {
    const periode = () => ({ periodStart: addDaysToIsoDate(today(), -1), periodEnd: addDaysToIsoDate(today(), 1) })

    it('inscrit l’export au journal avec l’empreinte du fichier, équilibré', async () => {
      const { id } = await factureEmise()
      await factureEmise({ clientId: PETIT, netCents: 5_000, vatRateBp: 1_000 })
      await pointer(id, 12_000)

      const recorded = await generateAccountingExport({ ...periode(), generatedBy: ACCUEIL })
      assert.equal(recorded.format, 'fec')
      assert.equal(recorded.entryCount, 3 + 3 + 2)
      const rebuilt = await rebuildAccountingExport(recorded.id)
      assert.equal(rebuilt?.status, 'ok')
      if (rebuilt?.status !== 'ok') return
      assert.equal(rebuilt.sha256, recorded.fileSha256)

      const rows = rebuilt.content.trimEnd().split('\r\n').slice(1).map((row) => row.split('\t'))
      const cents = (value: string) => Number(value.replace(',', ''))
      const debit = rows.reduce((total, row) => total + cents(row[11]), 0)
      const credit = rows.reduce((total, row) => total + cents(row[12]), 0)
      assert.equal(debit, credit)
      assert.equal(debit, 12_000 + 5_500 + 12_000)
      assert.deepEqual(
        rows.filter((row) => row[0] === 'VE' && row[4] === '411000').map((row) => row[6]).sort(),
        ['ATELIERDURAND', 'BOULANGERIEPETIT'],
      )
      assert.ok(rows.some((row) => row[4] === '445712' && row[12] === '5,00'))

      const journal = await listAccountingExports()
      assert.equal(journal[0].id, recorded.id)
      assert.equal(journal[0].generatedByName, 'Claire Accueil')
    })

    it('dit qu’un fichier a changé depuis sa génération', async () => {
      const { id } = await factureEmise()
      const payment = await pointer(id, 12_000)
      const recorded = await generateAccountingExport({ ...periode(), generatedBy: ACCUEIL })
      await cancelPayment({ invoiceId: id, paymentId: payment.id, reason: 'Erreur', cancelledBy: ACCUEIL })
      assert.equal((await rebuildAccountingExport(recorded.id))?.status, 'changed')
    })

    it('refuse une période vide, et un taux de TVA sans compte', async () => {
      assert.ok((await errorOf(() => generateAccountingExport({ ...periode(), generatedBy: ACCUEIL }))) instanceof EmptyExportError)
      await factureEmise({ netCents: 1_000, vatRateBp: 850 })
      const error = await errorOf(() => generateAccountingExport({ ...periode(), generatedBy: ACCUEIL }))
      assert.ok(error instanceof FecExportError)
      assert.deepEqual(error.problems, ['compte de TVA collectée absent pour le taux de 8,5 %'])
      assert.deepEqual(await listAccountingExports(), [])
    })

    it('fixe les comptes auxiliaires, sans doublon', async () => {
      await factureEmise()
      await factureEmise({ clientId: PETIT })
      assert.deepEqual(
        (await listInvoicedClientCodes()).map((row) => [row.name, row.accountingCode, row.proposedCode]),
        [
          ['Atelier Durand', null, 'ATELIERDURAND'],
          ['Boulangerie Petit', null, 'BOULANGERIEPETIT'],
        ],
      )
      assert.deepEqual(
        await saveClientAccountingCodes(new Map([[DURAND, 'DUR'], [PETIT, 'DUR']])),
        { [PETIT]: 'Le compte DUR est déjà donné à un autre client de la liste.' },
      )
      assert.deepEqual(await saveClientAccountingCodes(new Map([[DURAND, 'DURAND'], [PETIT, 'PETIT']])), {})
      // Échange des codes : libérés d'abord, posés ensuite.
      assert.deepEqual(await saveClientAccountingCodes(new Map([[DURAND, 'PETIT'], [PETIT, 'DURAND']])), {})
      assert.deepEqual(
        (await listInvoicedClientCodes()).map((row) => row.accountingCode),
        ['PETIT', 'DURAND'],
      )
    })
  })

  describe('représentation EN 16931', () => {
    it('décrit une facture réellement émise, complète', async () => {
      const { id, number } = await factureEmise()
      const settlement = await findInvoiceSettlement(id)
      assert.ok(settlement)
      const doc = toEn16931({ invoice: settlement.invoice, lines: settlement.lines, precedingInvoice: null })
      assert.equal(doc['BT-1'], number)
      assert.equal(doc['BG-22']['BT-112'], '120.00')
      assert.deepEqual(doc['BG-4']['BT-30'], { value: '123456789', scheme: '0002' })
      assert.deepEqual(doc['BG-7']['BT-47'], { value: '987654321', scheme: '0002' })
      const failures = checkEn16931(doc).filter((check) => !check.ok)
      assert.deepEqual(failures, [])
    })
  })
})
