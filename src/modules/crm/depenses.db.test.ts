import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { dbErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { addMonthsToIsoMonth, todayIsoDate } from '../../lib/dates.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { toutVider } from '../clients/test-support.ts'
import { completeForwardRequest, requestForward } from '../courrier/demandes-queries.ts'
import { expenseSettings, loadClientExpenses, saveExpenseSettings } from './depenses-queries.ts'
import { DEFAULT_EXPENSE_NOTE } from './depenses-reglages.ts'

/**
 * « Mes dépenses » en base (ADR 081), sous l'identité applicative :
 *
 * - frais fixes d'un contrat, prestations des règles du registre (réservation
 *   au devis figé, ouvertures, pages en plus, réexpédition et son
 *   affranchissement), chiffrées au catalogue reçu du CRM ;
 * - une réservation passée par un devis n'y est pas (le devis la facture) ;
 * - rien d'une autre entreprise ; rien ne s'écrit au registre ;
 * - le réglage du centre : valeurs par défaut sans ligne, puis enregistré.
 */
describe('dépenses de l’espace client, en base', { skip: raisonDeSaut }, () => {
  const PARIS = 'Europe/Paris'
  const ACCUEIL = '01a00000-0000-7000-8000-00000081ad01'
  const DURAND = '01a00000-0000-7000-8000-00000081d001'
  const JEANNE = '01a00000-0000-7000-8000-00000081d011'
  const PETIT = '01a00000-0000-7000-8000-00000081d002'
  const SALLE = '01a00000-0000-7000-8000-00000081a001'

  let bases: TestDatabases
  let pagesComprises: number

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]
  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)
  const brut = async <T>(requete: string, params: unknown[] = []) =>
    ((await bases.owner.client.query(requete, params)) as unknown as [T[]])[0]

  // Le mois en cours (M0) et le mois dernier (M1), au calendrier du centre.
  const M0 = todayIsoDate(PARIS).slice(0, 7)
  const M1 = addMonthsToIsoMonth(M0, -1)

  const reservation = async (client: string, debut: string, fin: string) => {
    const id = uuidv7()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into bookings (id, resource_id, client_id, channel, status, starts_at, ends_at, title,
                              quote_unit, quote_quantity, quote_unit_price_cents, quote_vat_rate_bp, quote_currency, quoted_at)
        values (${id}, ${SALLE}, ${client}, 'staff', 'confirmed', ${debut}, ${fin}, 'Réunion',
                'half_day', 1, 9000, 2000, 'EUR', current_timestamp(3))`),
    )
    return id
  }

  const pliOuvert = async (client: string, ouvertLe: string) => {
    const id = uuidv7()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into mail_items (id, client_id, kind, received_at, status, opened_at, opened_by)
        values (${id}, ${client}, 'lettre', ${ouvertLe}, 'opened', ${ouvertLe}, ${ACCUEIL})`),
    )
    return id
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
    const [[tenant]] = (await bases.owner.client.query('select mail_opening_included_pages as pages from tenants where id = ?', [
      DEFAULT_TENANT_ID,
    ])) as unknown as [[{ pages: number }]]
    pagesComprises = tenant.pages
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query('update tenants set mail_opening_included_pages = 5 where id = ?', [DEFAULT_TENANT_ID])
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, role) values (${ACCUEIL}, 'accueil@centre.exemple.fr', 'admin')`)
      await tx.execute(sql`
        insert into clients (id, name, status) values (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Studio Petit', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id)
        values (${JEANNE}, ${DURAND}, 'jeanne@durand.exemple.fr', 'Jeanne Durand', 'u-jeanne-81')`)
      await tx.execute(sql`insert into resources (id, resource_type, code, name) values (${SALLE}, 'salle', 'SAL-81', 'Salle Mont Blanc')`)
      await tx.execute(sql`
        insert into services (id, code, name, nature, unit, unit_price_cents) values
          (${uuidv7()}, 'courrier.ouverture', 'Ouverture', 'act', 'unit', 300),
          (${uuidv7()}, 'courrier.page', 'Page numérisée', 'act', 'unit', 20),
          (${uuidv7()}, 'courrier.reexpedition', 'Réexpédition', 'act', 'unit', 500)`)
      await tx.execute(sql`
        insert into contracts (client_id, reference, contract_type, status, starts_on, amount_cents)
        values (${DURAND}, 'DOM-81', 'domiciliation', 'active', ${`${M1}-01`}, 3000),
               (${PETIT}, 'DOM-82', 'domiciliation', 'active', ${`${M1}-01`}, 9900)`)
    })
  })

  after(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query('update tenants set mail_opening_included_pages = ? where id = ?', [
      pagesComprises,
      DEFAULT_TENANT_ID,
    ])
    delete (globalThis as { database?: unknown }).database
    await bases?.fermer()
  })

  it('frais fixes et prestations du compte, au catalogue ; ni devis, ni autre entreprise, ni registre', async () => {
    await reservation(DURAND, `${M1}-10 07:00:00`, `${M1}-10 11:00:00`)
    // Passée par un devis : le devis la facture, elle n'est pas une dépense ici.
    const parDevis = await reservation(DURAND, `${M1}-12 07:00:00`, `${M1}-12 11:00:00`)
    await asTenant((tx) =>
      tx.execute(sql`
        insert into proposals (id, number, product, channel, client_id, booking_id, answers)
        values (${uuidv7()}, 'DV-TEST-0081', 'espace', 'staff', ${DURAND}, ${parDevis}, json_object())`),
    )
    const pli = await pliOuvert(DURAND, `${M1}-10 08:00:00`)
    await asTenant((tx) =>
      tx.execute(sql`
        insert into mail_scans (id, mail_item_id, side, storage_key, content_type, byte_size, page_count)
        values (${uuidv7()}, ${pli}, 'content', ${`courrier/test/${pli}.pdf`}, 'application/pdf', 5, 8)`),
    )
    // Réexpédiée ce mois-ci, affranchissement relevé.
    const aReexpedier = await pliOuvert(DURAND, `${M1}-15 08:00:00`)
    const demande = await requestForward(
      aReexpedier,
      durand,
      { recipient: 'Jeanne Durand', line1: '12 rue des Lilas', line2: null, postalCode: '38000', city: 'Grenoble', country: 'FR' },
      null,
    )
    assert.ok(demande.ok)
    await completeForwardRequest(demande.requestId, ACCUEIL, { trackingNumber: null, postageCents: 450 })
    // Une autre entreprise : rien d'elle ne paraît.
    await reservation(PETIT, `${M1}-11 07:00:00`, `${M1}-11 11:00:00`)
    await pliOuvert(PETIT, `${M1}-11 08:00:00`)

    const [m0, m1] = await loadClientExpenses(durand, { months: [M0, M1], timeZone: PARIS, estimateMailActs: true })
    assert.equal(m1!.month, M1)
    assert.deepEqual(
      m1!.lines.map((ligne) => [ligne.kind, ligne.amountCents, ligne.feesCents, ligne.pricing, ligne.clientId]),
      [
        ['fixed', 3000, null, 'contract', DURAND],
        ['booking', 9000, null, 'quote', DURAND],
        ['mail_opening', 300, null, 'catalogue', DURAND],
        ['mail_pages', 60, null, 'catalogue', DURAND],
        ['mail_opening', 300, null, 'catalogue', DURAND],
      ],
    )
    assert.deepEqual(m1!.totals, [{ currency: 'EUR', fixedCents: 3000, servicesCents: 9660, totalCents: 12660 }])

    assert.equal(m0!.current, true)
    assert.deepEqual(
      m0!.lines.map((ligne) => [ligne.kind, ligne.amountCents, ligne.feesCents]),
      [
        ['fixed', 3000, null],
        ['mail_forward', 500, 450],
      ],
    )

    // Sans estimation des actes : comptés, sans montant ; l'affranchissement reste.
    const [, sansActes] = await loadClientExpenses(durand, { months: [M0, M1], timeZone: PARIS, estimateMailActs: false })
    assert.deepEqual(sansActes!.totals, [{ currency: 'EUR', fixedCents: 3000, servicesCents: 9000, totalCents: 12000 }])
    assert.equal(sansActes!.unpriced, 3)

    // Lire les dépenses n'écrit rien au registre transmis au CRM.
    assert.deepEqual(await brut('select id from crm_consumptions'), [])
  })

  it('un compte sans rien : des mois vides, sans erreur', async () => {
    const mois = await loadClientExpenses(
      [{ memberId: uuidv7(), clientId: PETIT, clientName: 'Studio Petit' }],
      { months: [addMonthsToIsoMonth(M1, -3)], timeZone: PARIS, estimateMailActs: true },
    )
    assert.deepEqual(mois.map((m) => [m.lines.length, m.totals]), [[0, []]])
    assert.deepEqual(await loadClientExpenses([], { months: [M0], timeZone: PARIS, estimateMailActs: true }), [])
  })

  it('le réglage du centre : par défaut sans ligne, puis enregistré et relu', async () => {
    assert.deepEqual(await expenseSettings(), {
      showExpenses: true,
      estimateMailActs: true,
      historyMonths: 12,
      note: DEFAULT_EXPENSE_NOTE,
      customNote: false,
    })
    await saveExpenseSettings({ showExpenses: false, estimateMailActs: false, historyMonths: 6, note: 'Facturé le 1er.' }, ACCUEIL)
    await saveExpenseSettings({ showExpenses: true, estimateMailActs: false, historyMonths: 24, note: null }, ACCUEIL)
    assert.deepEqual(await expenseSettings(), {
      showExpenses: true,
      estimateMailActs: false,
      historyMonths: 24,
      note: DEFAULT_EXPENSE_NOTE,
      customNote: false,
    })
    assert.equal((await brut('select id from client_expense_settings')).length, 1)
    let code: string | undefined
    try {
      await saveExpenseSettings({ showExpenses: true, estimateMailActs: true, historyMonths: 30, note: null }, ACCUEIL)
    } catch (error) {
      code = dbErrorCode(error)
    }
    assert.equal(code, '23514')
  })
})
