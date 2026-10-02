import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { findInvoiceForAccounts, listInvoicesForAccounts } from './compte-queries.ts'

/**
 * « Mes factures » (R17), contre la base et sous le rôle applicatif : jamais
 * un brouillon, jamais la facture d'une autre entreprise — par les filtres
 * des requêtes, et par la portée client en RLS, qui tient seule même pour une
 * requête sans filtre.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('factures de l’espace client', { skip: raison }, () => {
  // Les requêtes du module ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const DURAND = '01a00000-0000-7000-8000-0000000f0c01'
  const PETIT = '01a00000-0000-7000-8000-0000000f0c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000f0d01'
  const PAUL = '01a00000-0000-7000-8000-0000000f0d02'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]
  const petit: ClientAccount[] = [{ memberId: PAUL, clientId: PETIT, clientName: 'Boulangerie Petit' }]

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  /** Identité du centre avant le test, rendue à la fin : d'autres tests la lisent. */
  let identite: Record<string, unknown> | undefined

  /** Une facture d'une ligne ; émise si demandé. */
  const facturer = async (clientId: string, { emettre = true, mois = '2026-09' } = {}) => {
    const [row] = await asTenant(async (tx) => {
      const [invoice] = await tx.execute(sql`
        insert into invoices (client_id, period_start, period_end)
        values (${clientId}, ${`${mois}-01`}::date, (${`${mois}-01`}::date + interval '1 month - 1 day')::date)
        returning id`)
      await tx.execute(sql`
        insert into invoice_lines (invoice_id, kind, description, unit_price_cents, vat_rate_bp)
        values (${invoice.id as string}, 'other', 'Domiciliation', 10000, 2000)`)
      if (emettre) await tx.execute(sql`select issue_invoice(${invoice.id as string}::uuid)`)
      return [invoice]
    })
    return row.id as string
  }

  const avoir = async (invoiceId: string) => {
    const [row] = await asTenant(async (tx) => {
      const [draft] = await tx.execute(sql`select draft_credit_note(${invoiceId}::uuid, 'Erreur de période') as id`)
      await tx.execute(sql`select issue_invoice(${draft.id as string}::uuid)`)
      return [draft]
    })
    return row.id as string
  }

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
    const [row] = await owner.client`
      select legal_name, address_line1, postal_code, city, siren, vat_number, bank_iban
        from tenants where id = ${DEFAULT_TENANT_ID}`
    identite = row
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, clients, services, offers cascade`
    await owner.client`
      update tenants set legal_name = 'Centre de démonstration SAS', address_line1 = '1 rue de l''Exemple',
        postal_code = '38070', city = 'Saint-Quentin-Fallavier', siren = '123456789',
        vat_number = 'FR32123456789', bank_iban = 'FR7630006000011234567890189'
      where id = ${DEFAULT_TENANT_ID}`
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (id, name, status, address_line1, postal_code, city) values
          (${DURAND}, 'Atelier Durand', 'active', '2 place du Marché', '38000', 'Grenoble'),
          (${PETIT}, 'Boulangerie Petit', 'active', '3 rue du Four', '38000', 'Grenoble')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, auth_user_id) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'u-jeanne'),
          (${PAUL}, ${PETIT}, 'paul@petit.fr', 'u-paul')`)
    })
  })

  after(async () => {
    if (identite) {
      await owner.client`
        update tenants set legal_name = ${identite.legal_name as string | null},
          address_line1 = ${identite.address_line1 as string | null},
          postal_code = ${identite.postal_code as string | null}, city = ${identite.city as string | null},
          siren = ${identite.siren as string | null}, vat_number = ${identite.vat_number as string | null},
          bank_iban = ${identite.bank_iban as string | null}
        where id = ${DEFAULT_TENANT_ID}`
    }
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  it('ne montre que les factures et avoirs émis des entreprises du compte', async () => {
    const emise = await facturer(DURAND)
    const corrigee = await facturer(DURAND, { mois: '2026-08' })
    const avoirId = await avoir(corrigee)
    await facturer(DURAND, { emettre: false, mois: '2026-10' })
    await facturer(PETIT)

    const rows = await listInvoicesForAccounts(durand)
    assert.deepEqual(rows.map((row) => row.id).sort(), [emise, corrigee, avoirId].sort())
    assert.ok(rows.every((row) => row.clientId === DURAND))
    assert.ok(rows.every((row) => row.status !== 'draft' && row.number !== null))
    const credit = rows.find((row) => row.id === avoirId)
    assert.equal(credit?.kind, 'credit_note')
    assert.match(credit?.creditedInvoiceNumber ?? '', /^FA-/)
  })

  it('n’ouvre ni un brouillon, ni un brouillon abandonné, ni la facture d’un autre client', async () => {
    const emise = await facturer(DURAND)
    const brouillon = await facturer(DURAND, { emettre: false, mois: '2026-10' })
    const abandonne = await facturer(DURAND, { emettre: false, mois: '2026-11' })
    await asTenant((tx) => tx.execute(sql`update invoices set deleted_at = now() where id = ${abandonne}`))
    const autre = await facturer(PETIT)

    assert.equal(await findInvoiceForAccounts(brouillon, durand), undefined)
    assert.equal(await findInvoiceForAccounts(abandonne, durand), undefined)
    assert.equal(await findInvoiceForAccounts(autre, durand), undefined)
    assert.equal(await findInvoiceForAccounts('pas-un-uuid', durand), undefined)
    assert.equal(await findInvoiceForAccounts(emise, []), undefined)
    assert.deepEqual(
      (await listInvoicesForAccounts(durand)).map((row) => row.id),
      [emise],
    )

    const detail = await findInvoiceForAccounts(emise, durand)
    assert.equal(detail?.invoice.id, emise)
    assert.equal(detail?.client.id, DURAND)
    assert.equal(detail?.lines.length, 1)
    // La feuille se lit dans ses instantanés, figés à l'émission.
    assert.equal(detail?.invoice.sellerSnapshot?.legalName, 'Centre de démonstration SAS')
    assert.equal(detail?.invoice.sellerSnapshot?.bankIban, 'FR7630006000011234567890189')
  })

  it('rattache un avoir à la facture qu’il corrige', async () => {
    const facture = await facturer(DURAND)
    const avoirId = await avoir(facture)
    const detail = await findInvoiceForAccounts(avoirId, durand)
    const [{ number }] = await asTenant((tx) => tx.execute(sql`select number from invoices where id = ${facture}`))
    assert.equal(detail?.invoice.kind, 'credit_note')
    assert.equal(detail?.original?.number, number)
  })

  it('montre à un compte de deux entreprises les factures des deux, jamais leurs brouillons', async () => {
    const deDurand = await facturer(DURAND)
    const dePetit = await facturer(PETIT)
    await facturer(PETIT, { emettre: false, mois: '2026-10' })
    const rows = await listInvoicesForAccounts([...durand, ...petit])
    assert.deepEqual(rows.map((row) => row.id).sort(), [deDurand, dePetit].sort())
  })

  it('tient par la portée client seule, sans aucun filtre', async () => {
    const emise = await facturer(DURAND)
    const brouillon = await facturer(DURAND, { emettre: false, mois: '2026-10' })
    await facturer(PETIT)
    // Une requête qui aurait oublié tous ses filtres : la RLS ne laisse passer
    // que les documents émis de l'entreprise de la portée (migration 0031).
    const { factures, lignes } = await withClientScope(
      DEFAULT_TENANT_ID,
      [DURAND],
      async (tx) => ({
        factures: await tx.execute(sql`select id from invoices`),
        lignes: await tx.execute(sql`select invoice_id from invoice_lines`),
      }),
      app.db,
    )
    assert.deepEqual(
      factures.map((row) => row.id),
      [emise],
    )
    assert.deepEqual(
      lignes.map((row) => row.invoice_id),
      [emise],
    )
    assert.ok(!lignes.some((row) => row.invoice_id === brouillon))
  })

  it('ne montre rien à un compte sans entreprise', async () => {
    await facturer(DURAND)
    assert.deepEqual(await listInvoicesForAccounts([]), [])
  })
})
