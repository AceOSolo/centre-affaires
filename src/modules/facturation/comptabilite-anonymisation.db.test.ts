import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { addDaysToIsoDate, todayIsoDate } from '../../lib/dates.ts'
import { generateAccountingExport, rebuildAccountingExport } from './comptabilite.ts'
import { deriveAccountingCode } from './fec.ts'
import { recordPayment } from './reglements.ts'
import { invoices } from './schema-factures.ts'

/**
 * Export comptable et anonymisation (R16, R29 ; ADR 040, ADR 041) : le livre
 * d'une période passée ne bouge pas quand ses clients sont anonymisés.
 *
 * - les libellés viennent de l'instantané de l'acheteur, figé à l'émission ;
 * - le compte auxiliaire d'un client facturé sans compte saisi est figé à
 *   l'anonymisation, dérivé de son ancien nom par la même règle que l'export
 *   (`derive_accounting_code`, jumeau SQL de `deriveAccountingCode`) ;
 * - deux clients anonymisés ne se disputent donc pas un même compte.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('export comptable et anonymisation', { skip: raison }, () => {
  // Les requêtes du module ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const ACCUEIL = '01a00000-0000-7000-8000-0000000e4d01'
  const DURAND = '01a00000-0000-7000-8000-0000000e4c01'
  const PETIT = '01a00000-0000-7000-8000-0000000e4c02'

  const today = () => todayIsoDate('Europe/Paris')
  const periode = () => ({ periodStart: addDaysToIsoDate(today(), -1), periodEnd: addDaysToIsoDate(today(), 1) })

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, app.db)

  /** Facture émise de 100 € HT à 20 %, réglée le jour même. */
  const factureReglee = async (clientId: string) => {
    const [draft] = await asTenant((tx) =>
      tx
        .insert(invoices)
        .values({ clientId, periodStart: '2026-09-01', periodEnd: '2026-09-30' })
        .returning({ id: invoices.id }),
    )
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into invoice_lines (invoice_id, kind, description, unit_price_cents, vat_rate_bp)
        values (${draft.id}, 'other', 'Domiciliation — septembre 2026', 10000, 2000)`)
      await tx.execute(sql`select issue_invoice(${draft.id}::uuid, ${ACCUEIL}::uuid)`)
    })
    await recordPayment(
      draft.id,
      { amountCents: 12_000, paidOn: today(), method: 'transfer', reference: 'VIR', notes: null, overpaymentConfirmed: false },
      ACCUEIL,
    )
  }

  const anonymiser = (clientId: string) =>
    asTenant((tx) =>
      tx.execute(sql`select anonymize_client(${clientId}::uuid, ${ACCUEIL}::uuid, 'relationship_ended', null)`),
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
        bank_iban = 'FR7630006000011234567890189', bank_bic = 'AGRIFRPP'
      where id = ${DEFAULT_TENANT_ID}`
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, full_name) values (${ACCUEIL}, 'accueil@centre.fr', 'Claire Accueil')`)
      // Sans compte auxiliaire saisi : l'export le dérive de la raison sociale.
      await tx.execute(sql`
        insert into clients (id, name, status, siret, address_line1, postal_code, city) values
          (${DURAND}, 'Atelier Durand', 'active', '98765432100015', '2 place du Marché', '38000', 'Grenoble'),
          (${PETIT}, 'Boulangerie Petit', 'active', '44306184100047', '3 rue du Four', '69001', 'Lyon')`)
    })
  })

  after(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`
      update tenants set legal_name = null, legal_form = null, share_capital_cents = null,
        address_line1 = null, postal_code = null, city = null, siren = null, siret = null,
        vat_number = null, rcs_city = null, bank_iban = null, bank_bic = null
      where id = ${DEFAULT_TENANT_ID}`
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  it('dérive en base le compte auxiliaire comme l’export', async () => {
    const noms = [
      'Atelier Durand',
      'Société Générale d’Électricité',
      '3D Print & Co',
      '—',
      '',
      'Straße & Söhne',
      'Iıİ ſ ẛ ẚ ŉ',
      'ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ',
      'Ærø Œuvre Øre',
      'Ça coûte 100 € — très cher !',
      'ＡＢＣ 漢字 🎉',
      'Un nom de société beaucoup trop long pour un compte',
    ]
    const rows = await owner.client`
      select n.nom, derive_accounting_code(n.nom) as code from unnest(${noms}::text[]) as n(nom)`
    for (const row of rows) {
      assert.equal(row.code, deriveAccountingCode(row.nom as string), row.nom as string)
    }
  })

  it('garde le fichier d’une période passée identique, et l’exporte encore, quand ses clients sont anonymisés', async () => {
    await factureReglee(DURAND)
    await factureReglee(PETIT)
    const recorded = await generateAccountingExport({ ...periode(), generatedBy: ACCUEIL })
    const before = await rebuildAccountingExport(recorded.id)
    assert.equal(before?.status, 'ok')

    await anonymiser(DURAND)
    await anonymiser(PETIT)

    // Le fichier remis avant l'anonymisation est toujours celui-ci.
    const rebuilt = await rebuildAccountingExport(recorded.id)
    assert.equal(rebuilt?.status, 'ok')
    if (rebuilt?.status !== 'ok' || before?.status !== 'ok') return
    assert.equal(rebuilt.content, before.content)

    // Deux clients anonymisés dans la même période : chacun garde son compte.
    const again = await generateAccountingExport({ ...periode(), generatedBy: ACCUEIL })
    assert.equal(again.fileSha256, recorded.fileSha256)
    const rows = rebuilt.content.trimEnd().split('\r\n').slice(1).map((row) => row.split('\t'))
    const comptes = rows.filter((row) => row[4] === '411000')
    assert.deepEqual([...new Set(comptes.map((row) => row[6]))].sort(), ['ATELIERDURAND', 'BOULANGERIEPETIT'])
    // Les libellés sont ceux des pièces, figés à l'émission.
    assert.ok(comptes.every((row) => !/anonymisé/i.test(row[7]) && !/anonymisé/i.test(row[10])))
    assert.ok(comptes.some((row) => row[7] === 'Atelier Durand'))
  })
})
