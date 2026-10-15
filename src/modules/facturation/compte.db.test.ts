import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_CLIENT_SCOPE_REFUSED, DB_INVOICE_LOCKED, dbErrorCode } from '../../db/errors.ts'
import { withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { lire, toutVider } from '../clients/test-support.ts'
import { findInvoiceForAccounts, listInvoicesForAccounts } from './compte-queries.ts'

/**
 * « Mes factures » (R17), contre la base et sous l'identité applicative :
 * jamais un brouillon, jamais la facture d'une autre entreprise.
 *
 * MySQL ne filtre plus les lectures (pas de RLS, ADR 042) : ce sont les
 * requêtes qui portent les filtres `client_id` et `status <> 'draft'`, et ce
 * fichier les éprouve une à une. La base garde les écritures : sous la
 * portée d'une entreprise, rien ne s'écrit pour une autre (`CA015`).
 */
describe('factures de l’espace client', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const DURAND = '01a00000-0000-7000-8000-0000000f0c01'
  const PETIT = '01a00000-0000-7000-8000-0000000f0c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000f0d01'
  const PAUL = '01a00000-0000-7000-8000-0000000f0d02'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]
  const petit: ClientAccount[] = [{ memberId: PAUL, clientId: PETIT, clientName: 'Boulangerie Petit' }]

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  /** Dernier jour du mois `AAAA-MM`. */
  const finDeMois = (mois: string) => {
    const [annee, m] = mois.split('-').map(Number)
    return `${mois}-${String(new Date(Date.UTC(annee, m, 0)).getUTCDate()).padStart(2, '0')}`
  }

  /** Une facture d'une ligne ; émise si demandé. */
  const facturer = async (clientId: string, { emettre = true, mois = '2026-09' } = {}) => {
    const id = uuidv7()
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into invoices (id, client_id, period_start, period_end)
        values (${id}, ${clientId}, ${`${mois}-01`}, ${finDeMois(mois)})`)
      await tx.execute(sql`
        insert into invoice_lines (id, invoice_id, kind, description, unit_price_cents, vat_rate_bp)
        values (${uuidv7()}, ${id}, 'other', 'Domiciliation', 10000, 2000)`)
      await tx.execute(sql`select invoice_refresh_amounts(${id})`)
      if (emettre) await tx.execute(sql`select issue_invoice(${id}, null)`)
    })
    return id
  }

  const avoir = async (invoiceId: string) => {
    const id = uuidv7()
    await asTenant(async (tx) => {
      await tx.execute(sql`call draft_credit_note(${id}, ${invoiceId}, 'Erreur de période')`)
      await tx.execute(sql`select issue_invoice(${id}, null)`)
    })
    return id
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    // Les requêtes du module passent par la base du processus : celle des tests.
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query(
      `update tenants set legal_name = 'Centre de démonstration SAS', address_line1 = '1 rue de l''Exemple',
         postal_code = '38070', city = 'Saint-Quentin-Fallavier', siren = '123456789',
         vat_number = 'FR32123456789', bank_iban = 'FR7630006000011234567890189'
       where id = ?`,
      [DEFAULT_TENANT_ID],
    )
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
    await toutVider(bases.owner)
    await bases.owner.client.query(
      `update tenants set legal_name = null, address_line1 = null, postal_code = null, city = null,
         siren = null, vat_number = null, bank_iban = null
       where id = ?`,
      [DEFAULT_TENANT_ID],
    )
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
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
    await asTenant((tx) => tx.execute(sql`update invoices set deleted_at = current_timestamp(3) where id = ${abandonne}`))
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
    const rows = await asTenant((tx) => lire(tx, sql`select number from invoices where id = ${facture}`))
    assert.equal(detail?.invoice.kind, 'credit_note')
    assert.equal(detail?.original?.number, rows[0].number)
  })

  it('montre à un compte de deux entreprises les factures des deux, jamais leurs brouillons', async () => {
    const deDurand = await facturer(DURAND)
    const dePetit = await facturer(PETIT)
    await facturer(PETIT, { emettre: false, mois: '2026-10' })
    const rows = await listInvoicesForAccounts([...durand, ...petit])
    assert.deepEqual(rows.map((row) => row.id).sort(), [deDurand, dePetit].sort())
  })

  it('refuse, sous la portée d’une entreprise, d’écrire pour une autre ou sur un brouillon', async () => {
    const emise = await facturer(DURAND)
    const brouillon = await facturer(DURAND, { emettre: false, mois: '2026-10' })
    const autre = await facturer(PETIT)

    const code = async (run: () => Promise<unknown>) => {
      try {
        await run()
      } catch (error) {
        return dbErrorCode(error)
      }
      return undefined
    }
    const sousPortee = <T>(run: (tx: Transaction) => Promise<T>) =>
      withClientScope(DEFAULT_TENANT_ID, [DURAND], run, bases.app.db)

    // La facture d'une autre entreprise, comme un brouillon, est hors d'atteinte.
    assert.equal(
      await code(() => sousPortee((tx) => tx.execute(sql`update invoices set notes = 'x' where id = ${autre}`))),
      DB_CLIENT_SCOPE_REFUSED,
    )
    assert.equal(
      await code(() => sousPortee((tx) => tx.execute(sql`update invoices set notes = 'x' where id = ${brouillon}`))),
      DB_CLIENT_SCOPE_REFUSED,
    )
    // Une facture émise de l'entreprise reste figée (CA002), la portée n'y change rien.
    assert.equal(
      await code(() => sousPortee((tx) => tx.execute(sql`update invoices set notes = 'x' where id = ${emise}`))),
      DB_INVOICE_LOCKED,
    )
  })

  it('ne montre rien à un compte sans entreprise', async () => {
    await facturer(DURAND)
    assert.deepEqual(await listInvoicesForAccounts([]), [])
  })
})
