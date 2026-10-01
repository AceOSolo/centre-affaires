import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql, type SQL } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { pgErrorCode } from '../../db/errors.ts'
import { createDatabase, withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { sealIban } from './iban.ts'

/**
 * Isolation des clients entre eux sur les tables de la monétisation (R17,
 * R28, ADR 019, ADR 026) : sous `withClientScope()`, une requête **sans aucun
 * filtre** ne rend que ce qui relève des entreprises de la portée — et jamais
 * un brouillon de facture. Les tables du seul back-office (lots, plan de
 * comptes, exports) n'y rendent rien. Sans portée, le back-office voit tout.
 *
 * Éprouvé sous `app_centre`.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

/** Ligne refusée par une politique. */
const PG_RLS_VIOLATION = '42501'

describe('portée client : monétisation', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '', { max: 1 })

  const DURAND = '01a00000-0000-7000-8000-0000000b0c01'
  const PETIT = '01a00000-0000-7000-8000-0000000b0c02'
  const ACCUEIL = '01a00000-0000-7000-8000-0000000b0d01'
  const trousseau = { currentVersion: 1, keys: new Map([[1, randomBytes(32)]]) }

  /** Tables qui relèvent d'un client, et comment retrouver ce client. */
  const PAR_CLIENT: Record<string, SQL> = {
    subscribed_services: sql`select client_id from subscribed_services`,
    sepa_mandates: sql`select client_id from sepa_mandates`,
    invoices: sql`select client_id from invoices`,
    invoice_lines: sql`select i.client_id from invoice_lines l join invoices i on i.id = l.invoice_id`,
    payments: sql`select i.client_id from payments p join invoices i on i.id = p.invoice_id`,
    contract_lines: sql`select k.client_id from contract_lines l join contracts k on k.id = l.contract_id`,
    contract_amendments: sql`select k.client_id from contract_amendments a join contracts k on k.id = a.contract_id`,
    contract_documents: sql`select k.client_id from contract_documents d join contracts k on k.id = d.contract_id`,
  }
  /** Tables du seul back-office. */
  const BACK_OFFICE: Record<string, SQL> = {
    invoice_runs: sql`select id from invoice_runs`,
    accounting_accounts: sql`select id from accounting_accounts`,
    accounting_exports: sql`select id from accounting_exports`,
  }
  /** Mêmes tables, comptées sans jointure : la politique de chacune est à l'épreuve. */
  const SANS_JOINTURE: Record<string, SQL> = {
    invoice_lines: sql`select id from invoice_lines`,
    payments: sql`select id from payments`,
    contract_lines: sql`select id from contract_lines`,
    contract_amendments: sql`select id from contract_amendments`,
    contract_documents: sql`select id from contract_documents`,
  }

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)
  const asClients = <T>(clientIds: string[], run: (tx: Transaction) => Promise<T>) =>
    withClientScope(DEFAULT_TENANT_ID, clientIds, run, app.db)

  const lire = (run: typeof asTenant, requetes: Record<string, SQL>) =>
    run(async (tx) => {
      const lignes: Record<string, Record<string, unknown>[]> = {}
      for (const [table, query] of Object.entries(requetes)) lignes[table] = await tx.execute(query)
      return lignes
    })

  /** Tout ce qu'une entreprise a de facturé : souscription, mandat, contrat, factures. */
  const peupler = async (clientId: string, index: number) => {
    const reference = `RUM-${index}`
    const sealed = sealIban('DE89370400440532013000', { tenantId: DEFAULT_TENANT_ID, reference }, trousseau)
    await asTenant(async (tx) => {
      const [service] = await tx.execute(sql`
        insert into services (name, nature, unit, unit_price_cents)
        values (${`Standard ${index}`}, 'package', 'month', 5000) returning id`)
      await tx.execute(sql`
        insert into subscribed_services (client_id, service_id, unit, unit_price_cents, vat_rate_bp, starts_on)
        values (${clientId}, ${service.id as string}, 'month', 5000, 2000, '2026-01-01')`)
      await tx.execute(sql`
        insert into sepa_mandates (client_id, reference, debtor_name, iban_ciphertext, iban_key_version,
                                   iban_last4, signed_on)
        values (${clientId}, ${reference}, 'Titulaire', ${sealed.ciphertext}, ${sealed.keyVersion},
                ${sealed.last4}, '2026-01-01')`)

      const [contrat] = await tx.execute(sql`
        insert into contracts (client_id, reference, contract_type, starts_on, amount_cents)
        values (${clientId}, ${`DOM-${index}`}, 'domiciliation', '2026-01-01', 3000) returning id`)
      const contratId = contrat.id as string
      await tx.execute(sql`
        insert into contract_lines (contract_id, description, unit_price_cents)
        values (${contratId}, 'Domiciliation', 3000)`)
      await tx.execute(sql`update contracts set status = 'active' where id = ${contratId}`)
      await tx.execute(sql`
        insert into contract_amendments (contract_id, effective_on, amount_cents, status)
        values (${contratId}, '2026-07-01', 3500, 'signed')`)
      await tx.execute(sql`
        insert into contract_documents (contract_id, snapshot) values (${contratId}, '{"version": 1}')`)

      const [emise] = await tx.execute(sql`
        insert into invoices (client_id, period_start, period_end)
        values (${clientId}, '2026-09-01', '2026-09-30') returning id`)
      await tx.execute(sql`
        insert into invoice_lines (invoice_id, kind, description, unit_price_cents, vat_rate_bp)
        values (${emise.id as string}, 'other', 'Prestation', 10000, 2000)`)
      await tx.execute(sql`select issue_invoice(${emise.id as string}::uuid)`)
      await tx.execute(sql`
        insert into payments (invoice_id, amount_cents, paid_on, method, recorded_by)
        values (${emise.id as string}, 2000, '2026-10-01', 'transfer', ${ACCUEIL})`)

      // Un brouillon : jamais visible du client.
      const [brouillon] = await tx.execute(sql`
        insert into invoices (client_id, period_start, period_end)
        values (${clientId}, '2026-10-01', '2026-10-31') returning id`)
      await tx.execute(sql`
        insert into invoice_lines (invoice_id, kind, description, unit_price_cents, vat_rate_bp)
        values (${brouillon.id as string}, 'other', 'À valider', 5000, 2000)`)
    })
  }

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`delete from tenants where id <> ${DEFAULT_TENANT_ID}`
    await owner.client`
      update tenants set legal_name = 'Centre de démonstration SAS', address_line1 = '1 rue de l''Exemple',
        postal_code = '38070', city = 'Saint-Quentin-Fallavier', siren = '123456789',
        vat_number = 'FR32123456789', bank_iban = 'FR7630006000011234567890189'
      where id = ${DEFAULT_TENANT_ID}`
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email) values (${ACCUEIL}, 'accueil@centre.fr')`)
      await tx.execute(sql`
        insert into clients (id, name, address_line1, postal_code, city) values
          (${DURAND}, 'Atelier Durand', '2 place du Marché', '38000', 'Grenoble'),
          (${PETIT}, 'Boulangerie Petit', '3 rue du Four', '69001', 'Lyon')`)
      await tx.execute(sql`
        insert into invoice_runs (period_start, period_end, status, finished_at, created_by)
        values ('2026-09-01', '2026-09-30', 'completed', now(), ${ACCUEIL})`)
      await tx.execute(sql`
        insert into accounting_exports (period_start, period_end, file_name, file_sha256, entry_count, generated_by)
        values ('2026-09-01', '2026-09-30', 'FEC.txt', ${'b'.repeat(64)}, 4, ${ACCUEIL})`)
    })
    await peupler(DURAND, 1)
    await peupler(PETIT, 2)
  })

  after(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`
      update tenants set legal_name = null, address_line1 = null, postal_code = null, city = null,
        siren = null, vat_number = null, bank_iban = null
      where id = ${DEFAULT_TENANT_ID}`
    await Promise.all([owner.client.end(), app.client.end()])
  })

  it('sans portée, le back-office voit les deux entreprises et ses tables', async () => {
    const vu = await lire(asTenant, { ...PAR_CLIENT, ...BACK_OFFICE })
    assert.equal(vu.invoices.length, 4)
    assert.equal(vu.invoice_lines.length, 4)
    assert.equal(vu.subscribed_services.length, 2)
    assert.equal(vu.invoice_runs.length, 1)
    assert.equal(vu.accounting_accounts.length, 12)
    assert.equal(vu.accounting_exports.length, 1)
  })

  it('sous portée client, une requête sans where ne voit que son entreprise', async () => {
    const vu = await lire((run) => asClients([DURAND], run), PAR_CLIENT)
    for (const [table, lignes] of Object.entries(vu)) {
      assert.ok(lignes.length > 0, table)
      assert.deepEqual(new Set(lignes.map((ligne) => ligne.client_id)), new Set([DURAND]), table)
    }
    const sansJointure = await lire((run) => asClients([DURAND], run), SANS_JOINTURE)
    for (const [table, lignes] of Object.entries(sansJointure)) {
      assert.equal(lignes.length, vu[table].length, table)
    }
  })

  it('ne montre jamais un brouillon de facture au client, ni ses lignes', async () => {
    const vu = await lire((run) => asClients([DURAND], run), {
      invoices: sql`select status from invoices`,
      invoice_lines: sql`select description from invoice_lines`,
    })
    assert.deepEqual(vu.invoices.map((row) => row.status), ['partially_paid'])
    assert.deepEqual(vu.invoice_lines.map((row) => row.description), ['Prestation'])
  })

  it('ne rend rien des tables du seul back-office', async () => {
    const vu = await lire((run) => asClients([DURAND, PETIT], run), BACK_OFFICE)
    for (const [table, lignes] of Object.entries(vu)) assert.equal(lignes.length, 0, table)
  })

  it('une portée vide ne voit rien', async () => {
    const vu = await lire((run) => asClients([], run), { ...PAR_CLIENT, ...SANS_JOINTURE })
    for (const [table, lignes] of Object.entries(vu)) assert.equal(lignes.length, 0, table)
  })

  it('refuse d’écrire pour une autre entreprise', async () => {
    const code = async (run: () => Promise<unknown>) => {
      try {
        await run()
      } catch (error) {
        return pgErrorCode(error)
      }
      return undefined
    }
    assert.equal(
      await code(() =>
        asClients([DURAND], (tx) =>
          tx.execute(sql`
            insert into subscribed_services (client_id, service_id, unit, unit_price_cents, vat_rate_bp, starts_on)
            select ${PETIT}, id, 'month', 1, 2000, '2027-01-01' from services limit 1`),
        ),
      ),
      PG_RLS_VIOLATION,
    )
    // Les factures de l'autre entreprise ne sont même pas atteintes.
    const touchees = await asClients([DURAND], (tx) =>
      tx.execute(sql`update invoices set buyer_reference = buyer_reference where client_id = ${PETIT} returning id`),
    )
    assert.equal(touchees.length, 0)
  })
})
