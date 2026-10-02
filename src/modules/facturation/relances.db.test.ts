import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import {
  PG_CHECK_VIOLATION,
  PG_INSUFFICIENT_PRIVILEGE,
  PG_INVOICE_INVALID,
  pgErrorCode,
} from '../../db/errors.ts'
import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { lastRemindersFor, listInvoiceReminders, recordReminder, type ReminderInput } from './relances.ts'
import { invoiceReminders } from './schema-factures.ts'

/**
 * Journal des relances (R16, ADR 034) : chaque relance d'une facture émise
 * s'y inscrit, avec son palier, son canal et le reste dû réclamé ; la liste
 * des impayés en lit la dernière. Une preuve : l'application ne la réécrit
 * pas. Sous `app_centre`.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('journal des relances', { skip: raison }, () => {
  // Les lectures du module ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const ACCUEIL = '01a00000-0000-7000-8000-0000000f6d01'
  const CLIENT = '01a00000-0000-7000-8000-0000000f6c01'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, app.db)

  const errorCode = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return pgErrorCode(error)
    }
    return undefined
  }

  /** Facture de 100 € HT à 20 %, émise, ou laissée brouillon. */
  const facture = async (emise = true): Promise<string> =>
    asTenant(async (tx) => {
      const [row] = await tx.execute(sql`
        insert into invoices (client_id, period_start, period_end)
        values (${CLIENT}, '2026-09-01', '2026-09-30') returning id`)
      const id = row.id as string
      await tx.execute(sql`
        insert into invoice_lines (invoice_id, kind, description, unit_price_cents, vat_rate_bp)
        values (${id}, 'other', 'Prestation', 10000, 2000)`)
      if (emise) await tx.execute(sql`select issue_invoice(${id}::uuid, ${ACCUEIL}::uuid)`)
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
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`
      update tenants set legal_name = 'Centre de démonstration SAS', address_line1 = '1 rue de l''Exemple',
        postal_code = '38070', city = 'Saint-Quentin-Fallavier', siren = '123456789',
        vat_number = 'FR32123456789', bank_iban = 'FR7630006000011234567890189'
      where id = ${DEFAULT_TENANT_ID}`
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, full_name) values (${ACCUEIL}, 'accueil@centre.fr', 'Camille Accueil')`)
      await tx.execute(sql`
        insert into clients (id, name, address_line1, postal_code, city)
        values (${CLIENT}, 'Atelier Durand', '2 place du Marché', '38000', 'Grenoble')`)
    })
  })

  after(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`
      update tenants set legal_name = null, address_line1 = null, postal_code = null, city = null,
        siren = null, vat_number = null, bank_iban = null
      where id = ${DEFAULT_TENANT_ID}`
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
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
    assert.equal(await errorCode(() => relance(brouillon)), PG_INVOICE_INVALID)
  })

  it('exige des destinataires pour un courriel, aucun pour un courrier, et un palier connu', async () => {
    const id = await facture()
    assert.equal(await errorCode(() => relance(id, { recipients: [] })), PG_CHECK_VIOLATION)
    assert.equal(await errorCode(() => relance(id, { channel: 'post' })), PG_CHECK_VIOLATION)
    assert.equal(await errorCode(() => relance(id, { level: 4 as 3 })), PG_CHECK_VIOLATION)
    assert.equal(await errorCode(() => relance(id, { amountDueCents: 0 })), PG_CHECK_VIOLATION)
  })

  it('tient une preuve que l’application ne réécrit pas', async () => {
    const id = await facture()
    const inscrite = await relance(id)
    for (const tentative of [
      () => asTenant((tx) => tx.update(invoiceReminders).set({ level: 2 }).where(eq(invoiceReminders.id, inscrite.id))),
      () => asTenant((tx) => tx.delete(invoiceReminders).where(eq(invoiceReminders.id, inscrite.id))),
    ]) {
      assert.equal(await errorCode(tentative), PG_INSUFFICIENT_PRIVILEGE)
    }
  })
})
