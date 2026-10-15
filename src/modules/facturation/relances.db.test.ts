import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { eq, sql } from 'drizzle-orm'

import {
  DB_CHECK_VIOLATION,
  DB_INSUFFICIENT_PRIVILEGE,
  DB_INVOICE_INVALID,
  dbErrorCode,
} from '../../db/errors.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { lastRemindersFor, listInvoiceReminders, recordReminder, type ReminderInput } from './relances.ts'
import { invoiceReminders } from './schema-factures.ts'

/**
 * Tout ce qui dépend des clients, contrats, ressources, services et offres :
 * l'équivalent du `truncate … cascade` de PostgreSQL, que MySQL n'a pas.
 */
const TABLES_METIER = [
  'invoice_lines',
  'invoice_reminders',
  'payments',
  'invoices',
  'invoice_runs',
  'sepa_mandates',
  'subscribed_services',
  'offer_requests',
  'offer_items',
  'offers',
  'contract_renewals',
  'contract_documents',
  'contract_lines',
  'contract_amendments',
  'mail_requests',
  'mail_scan_views',
  'mail_scans',
  'mail_items',
  'notification_deliveries',
  'inspection_photo_views',
  'inspection_photos',
  'inspections',
  'bookings',
  'contracts',
  'rate_plan_items',
  'rate_plans',
  'client_contacts',
  'client_members',
  'clients',
  'resource_google_calendars',
  'opening_hours',
  'closures',
  'listings',
  'resources',
  'services',
]
/** Comme `TABLES_METIER`, plus ce qui référence l'équipe (`truncate staff_members cascade`). */
const TABLES_AVEC_EQUIPE = [
  ...TABLES_METIER,
  'accounting_exports',
  'google_calendar_connections',
  'notification_preferences',
  'staff_members',
]

/**
 * Journal des relances (R16, ADR 034) : chaque relance d'une facture émise
 * s'y inscrit, avec son palier, son canal et le reste dû réclamé ; la liste
 * des impayés en lit la dernière. Une preuve : l'application ne la réécrit
 * pas. Sous l'utilisateur applicatif.
 */

describe('journal des relances', { skip: raisonDeSaut }, () => {

  let bases: TestDatabases

  const ACCUEIL = '01a00000-0000-7000-8000-0000000f6d01'
  const CLIENT = '01a00000-0000-7000-8000-0000000f6c01'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const errorCode = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  /** Facture de 100 € HT à 20 %, émise, ou laissée brouillon. */
  const facture = async (emise = true): Promise<string> =>
    asTenant(async (tx) => {
      const id = uuidv7()
      await tx.execute(sql`
        insert into invoices (id, client_id, period_start, period_end)
        values (${id}, ${CLIENT}, '2026-09-01', '2026-09-30')`)
      await tx.execute(sql`
        insert into invoice_lines (invoice_id, kind, description, unit_price_cents, vat_rate_bp)
        values (${id}, 'other', 'Prestation', 10000, 2000)`)
      if (emise) await tx.execute(sql`select issue_invoice(${id}, ${ACCUEIL})`)
      return id
    })

  const relance = (invoiceId: string, values: Partial<ReminderInput> = {}) =>
    asTenant((tx) =>
      recordReminder(tx, {
        invoiceId,
        level: 1,
        channel: 'email',
        recipients: ['compta@durand.fr'],
        amountDueCents: 12_000,
        currency: 'EUR',
        subject: 'Relance — facture impayée',
        body: 'Madame, Monsieur, …',
        sentBy: ACCUEIL,
        ...values,
      }),
    )

  before(async () => {
    bases = await ouvrirBasesDeTest()
    // Les requêtes du module passent par la base du processus : celle des tests.
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await viderTables(bases.owner, ...TABLES_AVEC_EQUIPE)
    await bases.owner.db.execute(sql`
      update tenants set legal_name = 'Centre de démonstration SAS', address_line1 = '1 rue de l''Exemple',
        postal_code = '38070', city = 'Saint-Quentin-Fallavier', siren = '123456789',
        vat_number = 'FR32123456789', bank_iban = 'FR7630006000011234567890189'
      where id = ${DEFAULT_TENANT_ID}`)
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, full_name) values (${ACCUEIL}, 'accueil@centre.fr', 'Camille Accueil')`)
      await tx.execute(sql`
        insert into clients (id, name, address_line1, postal_code, city)
        values (${CLIENT}, 'Atelier Durand', '2 place du Marché', '38000', 'Grenoble')`)
    })
  })

  after(async () => {
    await viderTables(bases.owner, ...TABLES_AVEC_EQUIPE)
    await bases.owner.db.execute(sql`
      update tenants set legal_name = null, address_line1 = null, postal_code = null, city = null,
        siren = null, vat_number = null, bank_iban = null
      where id = ${DEFAULT_TENANT_ID}`)
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  it('inscrit chaque relance, et la liste des impayés en lit la dernière', async () => {
    const id = await facture()
    const autre = await facture()
    await relance(id)
    await relance(id, { level: 3, channel: 'post', recipients: [], amountDueCents: 12_000 })

    const journal = await listInvoiceReminders(id)
    assert.deepEqual(
      journal.map((entry) => [entry.level, entry.channel, entry.recipients, entry.sentByName]),
      [
        [1, 'email', ['compta@durand.fr'], 'Camille Accueil'],
        [3, 'post', [], 'Camille Accueil'],
      ],
    )
    const dernieres = await lastRemindersFor([id, autre])
    assert.equal(dernieres.get(id)?.level, 3)
    assert.equal(dernieres.get(id)?.channel, 'post')
    assert.equal(dernieres.has(autre), false)
  })

  it('ne relance qu’une facture émise', async () => {
    const brouillon = await facture(false)
    assert.equal(await errorCode(() => relance(brouillon)), DB_INVOICE_INVALID)
  })

  it('exige des destinataires pour un courriel, aucun pour un courrier, et un palier connu', async () => {
    const id = await facture()
    assert.equal(await errorCode(() => relance(id, { recipients: [] })), DB_CHECK_VIOLATION)
    assert.equal(await errorCode(() => relance(id, { channel: 'post' })), DB_CHECK_VIOLATION)
    assert.equal(await errorCode(() => relance(id, { level: 4 as 3 })), DB_CHECK_VIOLATION)
    assert.equal(await errorCode(() => relance(id, { amountDueCents: 0 })), DB_CHECK_VIOLATION)
  })

  it('tient une preuve que l’application ne réécrit pas', async () => {
    // Un trigger refuse UPDATE et DELETE (42501), pour tout utilisateur.
    const id = await facture()
    const inscrite = await relance(id)
    for (const tentative of [
      () => asTenant((tx) => tx.update(invoiceReminders).set({ level: 2 }).where(eq(invoiceReminders.id, inscrite.id))),
      () => asTenant((tx) => tx.delete(invoiceReminders).where(eq(invoiceReminders.id, inscrite.id))),
    ]) {
      assert.equal(await errorCode(tentative), DB_INSUFFICIENT_PRIVILEGE)
    }
  })
})
