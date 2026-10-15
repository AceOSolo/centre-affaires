import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql, type SQL } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { todayIsoDate } from '../../lib/dates.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { sansTriggers } from '../clients/test-support.ts'
import { loadIndicatorData } from './queries.ts'
import { billingSummary, outstanding, revenueBreakdown } from './revenus.ts'

/**
 * Lecture des indicateurs (R31) contre la base, sous l'identité applicative :
 * seuls les documents émis comptent, la ressource et le service d'une ligne se
 * retrouvent par sa source, un avoir se rattache à la ligne qu'il crédite,
 * même facturée avant la période.
 */
const PARIS = 'Europe/Paris'

describe('données des indicateurs', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const ACCUEIL = '01a00000-0000-7000-8000-0000000e1d01'
  const DURAND = '01a00000-0000-7000-8000-0000000e1c01'
  const SALLE = '01a00000-0000-7000-8000-0000000e1b01'
  const BUREAU = '01a00000-0000-7000-8000-0000000e1b02'

  /** Jour du centre quand les documents du jour sont émis. */
  const AUJOURDHUI = todayIsoDate(PARIS)

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const ecrire = (query: SQL) => asTenant((tx) => tx.execute(query))

  const emettre = async (id: string) => {
    const [rows] = (await asTenant((tx) =>
      tx.execute(sql`select issue_invoice(${id}, ${ACCUEIL}) as numero`),
    )) as unknown as [{ numero: string }[]]
    return rows[0].numero
  }

  const brouillon = async (values: { kind?: 'invoice' | 'credit_note'; creditedInvoiceId?: string } = {}) => {
    const id = uuidv7()
    await ecrire(sql`
      insert into invoices (id, kind, client_id, credited_invoice_id, period_start, period_end)
      values (${id}, ${values.kind ?? 'invoice'}, ${DURAND}, ${values.creditedInvoiceId ?? null},
              '2026-09-01', '2026-09-30')`)
    return id
  }

  const identiteDuCentre = `
    update tenants set
      legal_name = 'Centre de démonstration SAS', legal_form = 'SAS',
      address_line1 = '1 rue de l''Exemple', postal_code = '38070', city = 'Saint-Quentin-Fallavier',
      siren = '123456789', siret = '12345678900012', vat_number = 'FR32123456789', rcs_city = 'Vienne',
      bank_iban = 'FR7630006000011234567890189', bank_bic = 'AGRIFRPP', timezone = 'Europe/Paris'
    where id = ?`

  let serviceActe = ''
  let serviceForfait = ''

  const tables = [
    'bookings',
    'invoice_lines',
    'invoices',
    'payments',
    'subscribed_services',
    'contract_lines',
    'contract_amendments',
    'contracts',
    'rate_plan_items',
    'rate_plans',
    'clients',
    'resources',
    'services',
    'offers',
    'staff_members',
    'document_sequences',
  ]

  before(async () => {
    bases = await ouvrirBasesDeTest()
    // Les requêtes du module passent par la base du processus.
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await viderTables(bases.owner, ...tables)
    await bases.owner.client.query(identiteDuCentre, [DEFAULT_TENANT_ID])
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email) values (${ACCUEIL}, 'accueil@centre.fr')`)
      await tx.execute(sql`
        insert into clients (id, name, address_line1, postal_code, city)
        values (${DURAND}, 'Atelier Durand', '2 place du Marché', '38000', 'Grenoble')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${SALLE}, 'salle', 'SAL-I', 'Salle Europe'),
          (${BUREAU}, 'bureau', 'BUR-I', 'Bureau 12')`)
    })
    serviceActe = uuidv7()
    await ecrire(sql`
      insert into services (id, code, name, nature, unit, unit_price_cents)
      values (${serviceActe}, 'courrier.ouverture', 'Ouverture et numérisation', 'act', 'unit', 300)`)
    serviceForfait = uuidv7()
    await ecrire(sql`
      insert into services (id, name, nature, unit, unit_price_cents)
      values (${serviceForfait}, 'Standard téléphonique', 'package', 'month', 5000)`)
  })

  after(async () => {
    await viderTables(bases.owner, ...tables)
    await bases.owner.client.query(
      `update tenants set legal_name = null, legal_form = null, address_line1 = null, postal_code = null,
         city = null, siren = null, siret = null, vat_number = null, rcs_city = null, bank_iban = null,
         bank_bic = null, timezone = 'Europe/Paris'
       where id = ?`,
      [DEFAULT_TENANT_ID],
    )
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  it('lit les documents émis, résout ressources et services, et rattache les avoirs', async () => {
    // Bureau loué sous contrat depuis janvier : son occupation est une réservation.
    const contrat = uuidv7()
    await ecrire(sql`
      insert into contracts (id, client_id, reference, contract_type, status, starts_on, amount_cents, resource_id)
      values (${contrat}, ${DURAND}, 'BUR-IND', 'bureau', 'active', '2026-01-01', 90000, ${BUREAU})`)
    const reservation = uuidv7()
    await ecrire(sql`
      insert into bookings (id, resource_id, client_id, channel, starts_at, ends_at, title,
                            quote_unit, quote_quantity, quote_unit_price_cents, quote_vat_rate_bp,
                            quote_currency, quoted_at)
      values (${reservation}, ${SALLE}, ${DURAND}, 'staff', '2026-09-10 08:00:00.000', '2026-09-10 10:00:00.000',
              'Réunion', 'hour', 2, 2500, 2000, 'EUR', CURRENT_TIMESTAMP(3))`)
    // Ni une demande en attente, ni une annulée ne comptent dans l'occupation.
    await ecrire(sql`
      insert into bookings (id, resource_id, client_id, channel, status, starts_at, ends_at, title)
      values (${uuidv7()}, ${SALLE}, ${DURAND}, 'staff', 'pending', '2026-09-11 08:00:00.000',
              '2026-09-11 10:00:00.000', 'Demande')`)
    await ecrire(sql`
      insert into bookings (id, resource_id, client_id, channel, status, cancelled_at, starts_at, ends_at, title)
      values (${uuidv7()}, ${SALLE}, ${DURAND}, 'staff', 'cancelled', CURRENT_TIMESTAMP(3),
              '2026-09-12 08:00:00.000', '2026-09-12 10:00:00.000', 'Annulée')`)
    const souscription = uuidv7()
    await ecrire(sql`
      insert into subscribed_services (id, client_id, service_id, unit, unit_price_cents, vat_rate_bp, starts_on)
      values (${souscription}, ${DURAND}, ${serviceForfait}, 'month', 5000, 2000, '2026-01-01')`)

    // Facture d'août, sur la salle, émise puis antidatée (une facture émise
    // est figée : seul le propriétaire, déclencheurs retirés, le peut) : elle
    // sera créditée dans la période sans en faire partie.
    const aout = await brouillon()
    const ligneAout = uuidv7()
    await ecrire(sql`
      insert into invoice_lines (id, invoice_id, kind, description, unit_price_cents, vat_rate_bp, resource_id)
      values (${ligneAout}, ${aout}, 'other', 'Location de salle', 20000, 2000, ${SALLE})`)
    await emettre(aout)
    await sansTriggers(bases.owner, ['invoices'], async (connexion) => {
      await connexion.query(`update invoices set issue_date = '2026-08-15' where id = ?`, [aout])
    })

    // Facture de la période : loyer global (sans ressource écrite), réservation,
    // deux ouvertures de courrier, forfait souscrit.
    const septembre = await brouillon()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into invoice_lines (invoice_id, position, kind, description, period_start, period_end,
                                   quantity, unit_price_cents, vat_rate_bp, contract_id, booking_id,
                                   service_id, subscribed_service_id)
        values
          (${septembre}, 0, 'rent', 'Loyer', '2026-09-01', '2026-09-30', 1, 90000, 2000, ${contrat}, null, null, null),
          (${septembre}, 1, 'booking', 'Réunion', null, null, 2, 2500, 2000, null, ${reservation}, null, null),
          (${septembre}, 2, 'act', 'Ouverture', null, null, 2, 300, 2000, null, null, ${serviceActe}, null),
          (${septembre}, 3, 'package', 'Standard', '2026-09-01', '2026-09-30', 1, 5000, 2000, null, null, null, ${souscription})`),
    )
    await emettre(septembre)

    // Avoir partiel sur la facture d'août, en ligne libre, sans ressource.
    const avoir = await brouillon({ kind: 'credit_note', creditedInvoiceId: aout })
    await ecrire(sql`
      insert into invoice_lines (id, invoice_id, kind, description, unit_price_cents, vat_rate_bp, credited_line_id)
      values (${uuidv7()}, ${avoir}, 'other', 'Geste sur la location d’août', 5000, 2000, ${ligneAout})`)
    await emettre(avoir)

    // Un brouillon ne compte pas.
    const enCours = await brouillon()
    await ecrire(sql`
      insert into invoice_lines (id, invoice_id, kind, description, unit_price_cents, vat_rate_bp, resource_id)
      values (${uuidv7()}, ${enCours}, 'other', 'Brouillon', 77700, 2000, ${SALLE})`)

    // Paiements : un reçu aujourd'hui, un annulé.
    await ecrire(sql`
      insert into payments (id, invoice_id, amount_cents, paid_on, method, recorded_by)
      values (${uuidv7()}, ${septembre}, 10000, ${AUJOURDHUI}, 'transfer', ${ACCUEIL})`)
    const erreur = uuidv7()
    await ecrire(sql`
      insert into payments (id, invoice_id, amount_cents, paid_on, method, recorded_by)
      values (${erreur}, ${septembre}, 99900, ${AUJOURDHUI}, 'transfer', ${ACCUEIL})`)
    await ecrire(sql`
      update payments set cancelled_at = CURRENT_TIMESTAMP(3), cancelled_by = ${ACCUEIL},
             cancellation_reason = 'Erreur de pointage'
       where id = ${erreur}`)

    const period = { from: AUJOURDHUI, to: AUJOURDHUI }
    const data = await loadIndicatorData({
      period,
      range: { from: '2026-08-01', to: AUJOURDHUI },
      timeZone: PARIS,
    })

    // Occupation : la réservation confirmée et l'occupation du contrat.
    assert.deepEqual(
      data.bookings.map((booking) => [booking.resourceId, booking.kind]).sort(),
      [
        [BUREAU, 'contract'],
        [SALLE, 'booking'],
      ].sort(),
    )

    // Lignes de la période : les quatre de septembre et celle de l'avoir.
    assert.equal(data.lines.length, 5)
    assert.deepEqual(data.creditedLines.get(ligneAout), { kind: 'other', resourceId: SALLE, serviceId: null })

    const revenu = revenueBreakdown(data.lines, 'EUR', data.creditedLines)
    // Le loyer sans ressource écrite va au bureau, par le segment du contrat.
    assert.equal(revenu.byResource.get(BUREAU)?.netCents, 90_000)
    // La réservation va à la salle ; l'avoir sur août lui est retiré.
    assert.deepEqual(revenu.byResource.get(SALLE), { invoicedCents: 5_000, creditedCents: 5_000, netCents: 0 })
    assert.deepEqual(revenu.byService.get(serviceActe), {
      invoicedCents: 600,
      creditedCents: 0,
      netCents: 600,
      acts: 2,
      includedActs: 0,
    })
    // Le forfait souscrit retrouve son service par la souscription.
    assert.equal(revenu.byService.get(serviceForfait)?.netCents, 5_000)
    assert.deepEqual(revenu.total, { invoicedCents: 100_600, creditedCents: 5_000, netCents: 95_600 })

    // Facturé, encaissé, restant dû : brouillon et paiement annulé exclus.
    assert.equal(data.documents.length, 3)
    assert.deepEqual(data.payments.map((payment) => payment.amountCents), [10_000])
    const summary = billingSummary({
      documents: data.documents,
      payments: data.payments,
      currency: 'EUR',
      period,
      today: AUJOURDHUI,
    })
    assert.equal(summary.invoicedExclTaxCents, 100_600 - 5_000)
    assert.equal(summary.invoicedInclTaxCents, 120_720 - 6_000)
    assert.equal(summary.collectedCents, 10_000)
    assert.equal(summary.dueCents, 120_720 - 10_000)

    // Encours : septembre, et août moins son avoir.
    assert.deepEqual(outstanding(data.outstanding, 'EUR', AUJOURDHUI), {
      dueCents: 120_720 - 10_000 + (24_000 - 6_000),
      overdueCents: 0,
      invoiceCount: 2,
    })
  })

  it('rend des listes vides, sans erreur, quand rien n’est encore facturé', async () => {
    const data = await loadIndicatorData({
      period: { from: AUJOURDHUI, to: AUJOURDHUI },
      range: { from: AUJOURDHUI, to: AUJOURDHUI },
      timeZone: PARIS,
    })
    assert.equal(data.lines.length, 0)
    assert.equal(data.creditedLines.size, 0)
    assert.equal(data.documents.length, 0)
    assert.equal(data.payments.length, 0)
    assert.equal(data.outstanding.length, 0)
    // Ordre de l'énumération des types, puis du code.
    assert.deepEqual(
      data.resources.map((resource) => resource.code),
      ['SAL-I', 'BUR-I'],
    )
    assert.deepEqual(
      data.services.map((service) => service.name),
      ['Ouverture et numérisation', 'Standard téléphonique'],
    )
  })
})
