import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql, type SQL } from 'drizzle-orm'

import { DB_CLIENT_SCOPE_REFUSED, dbErrorCode } from '../../db/errors.ts'
import { createDatabase, databaseOptionsFromEnv, withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { lire, toutVider } from '../clients/test-support.ts'
import { sealIban } from './iban.ts'

/**
 * Isolation des clients entre eux sur les tables de la monétisation (R17,
 * R28, ADR 019, ADR 026).
 *
 * MySQL ne filtre plus les lectures (pas de RLS, ADR 042) : sous
 * `withClientScope()`, ce sont les requêtes de l'espace client qui filtrent —
 * `compte-queries.ts`, éprouvé dans `compte.db.test.ts` (un client ne voit
 * jamais un brouillon ni la facture d'un autre). Ce fichier éprouve ce que la
 * base garde elle-même, par triggers (`50-facturation.sql`) :
 *
 * - sous portée, une écriture pour une autre entreprise est refusée (`CA015`) ;
 * - un client n'écrit jamais un brouillon de facture ;
 * - les tables du seul back-office (lots, plan de comptes, exports, relances)
 *   refusent toute écriture sous portée ;
 * - une portée vide refuse tout ; sans portée, le back-office écrit librement.
 */
describe('portée client : monétisation', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases
  // Une seule connexion : la portée d'une transaction doit être retombée quand
  // la suivante réutilise la même session.
  let unique: ReturnType<typeof createDatabase>

  const DURAND = '01a00000-0000-7000-8000-0000000b0c01'
  const PETIT = '01a00000-0000-7000-8000-0000000b0c02'
  const ACCUEIL = '01a00000-0000-7000-8000-0000000b0d01'
  const trousseau = { currentVersion: 1, keys: new Map([[1, randomBytes(32)]]) }

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)
  const asClients = <T>(clientIds: string[], run: (tx: Transaction) => Promise<T>) =>
    withClientScope(DEFAULT_TENANT_ID, clientIds, run, unique.db)

  const errorCode = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  /** Compte de lignes par table du back-office. */
  const BACK_OFFICE: Record<string, SQL> = {
    invoice_runs: sql`select id from invoice_runs`,
    accounting_accounts: sql`select id from accounting_accounts`,
    accounting_exports: sql`select id from accounting_exports`,
    invoice_reminders: sql`select id from invoice_reminders`,
  }

  /** Ce que les tests lisent d'une entreprise. */
  const ids = {
    service: uuidv7(),
    emise: { [DURAND]: uuidv7(), [PETIT]: uuidv7() } as Record<string, string>,
    brouillon: { [DURAND]: uuidv7(), [PETIT]: uuidv7() } as Record<string, string>,
    souscription: { [DURAND]: uuidv7(), [PETIT]: uuidv7() } as Record<string, string>,
    mandat: { [DURAND]: uuidv7(), [PETIT]: uuidv7() } as Record<string, string>,
    paiement: { [DURAND]: uuidv7(), [PETIT]: uuidv7() } as Record<string, string>,
  }

  /** Tout ce qu'une entreprise a de facturé : souscription, mandat, factures, paiement. */
  const peupler = async (clientId: string, index: number) => {
    const reference = `RUM-${index}`
    const sealed = sealIban('DE89370400440532013000', { tenantId: DEFAULT_TENANT_ID, reference }, trousseau)
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into subscribed_services (id, client_id, service_id, unit, unit_price_cents, vat_rate_bp, starts_on)
        values (${ids.souscription[clientId]}, ${clientId}, ${ids.service}, 'month', 5000, 2000, '2026-01-01')`)
      await tx.execute(sql`
        insert into sepa_mandates (id, client_id, reference, debtor_name, iban_ciphertext, iban_key_version,
                                   iban_last4, signed_on)
        values (${ids.mandat[clientId]}, ${clientId}, ${reference}, 'Titulaire', ${sealed.ciphertext},
                ${sealed.keyVersion}, ${sealed.last4}, '2026-01-01')`)

      const emise = ids.emise[clientId]
      await tx.execute(sql`
        insert into invoices (id, client_id, period_start, period_end)
        values (${emise}, ${clientId}, '2026-09-01', '2026-09-30')`)
      await tx.execute(sql`
        insert into invoice_lines (id, invoice_id, kind, description, unit_price_cents, vat_rate_bp)
        values (${uuidv7()}, ${emise}, 'other', 'Prestation', 10000, 2000)`)
      await tx.execute(sql`select issue_invoice(${emise}, null)`)
      await tx.execute(sql`
        insert into payments (id, invoice_id, amount_cents, paid_on, method, recorded_by)
        values (${ids.paiement[clientId]}, ${emise}, 2000, '2026-10-01', 'transfer', ${ACCUEIL})`)

      // Un brouillon : jamais écrit par un client.
      const brouillon = ids.brouillon[clientId]
      await tx.execute(sql`
        insert into invoices (id, client_id, period_start, period_end)
        values (${brouillon}, ${clientId}, '2026-10-01', '2026-10-31')`)
      await tx.execute(sql`
        insert into invoice_lines (id, invoice_id, kind, description, unit_price_cents, vat_rate_bp)
        values (${uuidv7()}, ${brouillon}, 'other', 'À valider', 5000, 2000)`)
    })
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    const e = process.env
    unique = createDatabase(
      databaseOptionsFromEnv(e.TEST_DB_USER || e.DB_USER ? 'DB' : 'DB_ADMIN', {
        DB_HOST: e.TEST_DB_HOST ?? e.DB_HOST ?? '127.0.0.1',
        DB_PORT: e.TEST_DB_PORT ?? e.DB_PORT ?? '3306',
        DB_NAME: e.TEST_DB_NAME,
        DB_USER: e.TEST_DB_USER ?? e.DB_USER,
        DB_PASSWORD: e.TEST_DB_PASSWORD ?? e.DB_PASSWORD,
        DB_ADMIN_USER: e.TEST_DB_ADMIN_USER ?? e.DB_ADMIN_USER ?? 'root',
        DB_ADMIN_PASSWORD: e.TEST_DB_ADMIN_PASSWORD ?? e.DB_ADMIN_PASSWORD ?? '',
      } as unknown as NodeJS.ProcessEnv),
      { connectionLimit: 1 },
    )
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    // `toutVider` a aussi vidé le plan de comptes, posé par la base à la création du centre.
    await bases.owner.client.query('select seed_accounting_accounts(?)', [DEFAULT_TENANT_ID])
    await bases.owner.client.query(
      `update tenants set legal_name = 'Centre de démonstration SAS', address_line1 = '1 rue de l''Exemple',
         postal_code = '38070', city = 'Saint-Quentin-Fallavier', siren = '123456789',
         vat_number = 'FR32123456789', bank_iban = 'FR7630006000011234567890189'
       where id = ?`,
      [DEFAULT_TENANT_ID],
    )
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email) values (${ACCUEIL}, 'accueil@centre.fr')`)
      await tx.execute(sql`
        insert into clients (id, name, address_line1, postal_code, city) values
          (${DURAND}, 'Atelier Durand', '2 place du Marché', '38000', 'Grenoble'),
          (${PETIT}, 'Boulangerie Petit', '3 rue du Four', '69001', 'Lyon')`)
      await tx.execute(sql`
        insert into services (id, name, nature, unit, unit_price_cents)
        values (${ids.service}, 'Standard', 'package', 'month', 5000)`)
      await tx.execute(sql`
        insert into invoice_runs (id, period_start, period_end, status, finished_at, created_by)
        values (${uuidv7()}, '2026-09-01', '2026-09-30', 'completed', current_timestamp(3), ${ACCUEIL})`)
      await tx.execute(sql`
        insert into accounting_exports (id, period_start, period_end, file_name, file_sha256, entry_count, generated_by)
        values (${uuidv7()}, '2026-09-01', '2026-09-30', 'FEC.txt', ${'b'.repeat(64)}, 4, ${ACCUEIL})`)
    })
    await peupler(DURAND, 1)
    await peupler(PETIT, 2)
  })

  after(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query(
      `update tenants set legal_name = null, address_line1 = null, postal_code = null, city = null,
         siren = null, vat_number = null, bank_iban = null
       where id = ?`,
      [DEFAULT_TENANT_ID],
    )
    await unique.client.end()
    await bases.fermer()
  })

  it('sans portée, le back-office voit les deux entreprises et ses tables', async () => {
    const vu = await asTenant(async (tx) => ({
      factures: await lire(tx, sql`select id from invoices`),
      lignes: await lire(tx, sql`select id from invoice_lines`),
      souscriptions: await lire(tx, sql`select id from subscribed_services`),
      lots: await lire(tx, BACK_OFFICE.invoice_runs),
      comptes: await lire(tx, BACK_OFFICE.accounting_accounts),
      exports: await lire(tx, BACK_OFFICE.accounting_exports),
    }))
    assert.equal(vu.factures.length, 4)
    assert.equal(vu.lignes.length, 4)
    assert.equal(vu.souscriptions.length, 2)
    assert.equal(vu.lots.length, 1)
    assert.equal(vu.comptes.length, 12)
    assert.equal(vu.exports.length, 1)
  })

  it('sans portée, le back-office écrit pour n’importe quelle entreprise', async () => {
    await asTenant((tx) =>
      tx.execute(sql`update sepa_mandates set bic = 'AGRIFRPP' where id = ${ids.mandat[PETIT]}`),
    )
    await asTenant((tx) =>
      tx.execute(sql`update invoices set buyer_reference = 'BC-1' where id = ${ids.brouillon[PETIT]}`),
    )
  })

  it('laisse écrire pour sa propre entreprise', async () => {
    await asClients([DURAND], (tx) =>
      tx.execute(sql`update sepa_mandates set bic = 'AGRIFRPP' where id = ${ids.mandat[DURAND]}`),
    )
    const [rows] = (await bases.owner.client.query('select bic from sepa_mandates where id = ?', [
      ids.mandat[DURAND],
    ])) as unknown as [{ bic: string }[]]
    assert.equal(rows[0].bic, 'AGRIFRPP')
  })

  it('refuse d’écrire pour une autre entreprise', async () => {
    const refus = (run: (tx: Transaction) => Promise<unknown>) =>
      errorCode(() => asClients([DURAND], run))

    assert.equal(
      await refus((tx) =>
        tx.execute(sql`
          insert into subscribed_services (id, client_id, service_id, unit, unit_price_cents, vat_rate_bp, starts_on)
          values (${uuidv7()}, ${PETIT}, ${ids.service}, 'month', 1, 2000, '2027-01-01')`),
      ),
      DB_CLIENT_SCOPE_REFUSED,
    )
    assert.equal(
      await refus((tx) =>
        tx.execute(sql`update sepa_mandates set bic = 'AGRIFRPP' where id = ${ids.mandat[PETIT]}`),
      ),
      DB_CLIENT_SCOPE_REFUSED,
    )
    assert.equal(
      await refus((tx) =>
        tx.execute(sql`update invoices set buyer_reference = 'x' where id = ${ids.emise[PETIT]}`),
      ),
      DB_CLIENT_SCOPE_REFUSED,
    )
    assert.equal(
      await refus((tx) =>
        tx.execute(sql`
          insert into payments (id, invoice_id, amount_cents, paid_on, method, recorded_by)
          values (${uuidv7()}, ${ids.emise[PETIT]}, 100, '2026-10-02', 'transfer', ${ACCUEIL})`),
      ),
      DB_CLIENT_SCOPE_REFUSED,
    )
    assert.equal(
      await refus((tx) =>
        tx.execute(sql`
          insert into invoice_lines (id, invoice_id, kind, description, unit_price_cents, vat_rate_bp)
          values (${uuidv7()}, ${ids.emise[PETIT]}, 'other', 'Intrus', 100, 2000)`),
      ),
      DB_CLIENT_SCOPE_REFUSED,
    )
  })

  it('refuse à un client d’écrire un brouillon de facture, le sien compris', async () => {
    assert.equal(
      await errorCode(() =>
        asClients([DURAND], (tx) =>
          tx.execute(sql`update invoices set buyer_reference = 'x' where id = ${ids.brouillon[DURAND]}`),
        ),
      ),
      DB_CLIENT_SCOPE_REFUSED,
    )
    assert.equal(
      await errorCode(() =>
        asClients([DURAND], (tx) =>
          tx.execute(sql`
            insert into invoices (id, client_id, period_start, period_end)
            values (${uuidv7()}, ${DURAND}, '2026-11-01', '2026-11-30')`),
        ),
      ),
      DB_CLIENT_SCOPE_REFUSED,
    )
  })

  it('refuse toute écriture sous portée sur les tables du seul back-office', async () => {
    for (const [table, requete] of Object.entries({
      invoice_runs: sql`
        insert into invoice_runs (id, period_start, period_end) values (${uuidv7()}, '2026-10-01', '2026-10-31')`,
      accounting_exports: sql`
        insert into accounting_exports (id, period_start, period_end, file_name, file_sha256, entry_count, generated_by)
        values (${uuidv7()}, '2026-10-01', '2026-10-31', 'FEC.txt', ${'c'.repeat(64)}, 1, ${ACCUEIL})`,
      accounting_accounts: sql`update accounting_accounts set label = 'Autre' where purpose = 'bank'`,
    })) {
      assert.equal(
        await errorCode(() => asClients([DURAND, PETIT], (tx) => tx.execute(requete))),
        DB_CLIENT_SCOPE_REFUSED,
        table,
      )
    }
    assert.equal(
      await errorCode(() =>
        asClients([DURAND], (tx) =>
          tx.execute(sql`
            insert into invoice_reminders (id, invoice_id, level, channel, recipients, amount_due_cents, currency,
                                           subject, body, sent_by)
            values (${uuidv7()}, ${ids.emise[DURAND]}, 1, 'post', json_array(), 8000, 'EUR', 'Relance', 'Texte', ${ACCUEIL})`),
        ),
      ),
      DB_CLIENT_SCOPE_REFUSED,
    )
  })

  it('une portée vide n’écrit rien', async () => {
    assert.equal(
      await errorCode(() =>
        asClients([], (tx) =>
          tx.execute(sql`update sepa_mandates set bic = 'AGRIFRPP' where id = ${ids.mandat[DURAND]}`),
        ),
      ),
      DB_CLIENT_SCOPE_REFUSED,
    )
  })
})
