import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { todayIsoDate } from '../../lib/dates.ts'
import { loadIndicatorData } from './queries.ts'
import { billingSummary, outstanding, revenueBreakdown } from './revenus.ts'

/**
 * Lecture des indicateurs (R31) contre la base, sous `app_centre` : seuls les
 * documents émis comptent, la ressource et le service d'une ligne se
 * retrouvent par sa source, un avoir se rattache à la ligne qu'il crédite,
 * même facturée avant la période.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

const PARIS = 'Europe/Paris'

describe('données des indicateurs', { skip: raison }, () => {
  // Les requêtes du module ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const ACCUEIL = '01a00000-0000-7000-8000-0000000e1d01'
  const DURAND = '01a00000-0000-7000-8000-0000000e1c01'
  const SALLE = '01a00000-0000-7000-8000-0000000e1b01'
  const BUREAU = '01a00000-0000-7000-8000-0000000e1b02'

  /** Jour du centre : `issue_invoice()` date les documents d'aujourd'hui. */
  const AUJOURDHUI = todayIsoDate(PARIS)

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, app.db)

  const one = async (query: ReturnType<typeof sql>): Promise<Record<string, unknown>> => {
    const [row] = await asTenant((tx) => tx.execute(query))
    return row
  }

  const emettre = (id: string) => one(sql`select issue_invoice(${id}::uuid, ${ACCUEIL}::uuid) as numero`)

  const brouillon = async (values: { kind?: 'invoice' | 'credit_note'; creditedInvoiceId?: string } = {}) =>
    (
      await one(sql`
        insert into invoices (kind, client_id, credited_invoice_id, period_start, period_end)
        values (${values.kind ?? 'invoice'}, ${DURAND}, ${values.creditedInvoiceId ?? null},
                '2026-09-01', '2026-09-30')
        returning id`)
    ).id as string

  const identiteDuCentre = sql`
    update tenants set
      legal_name = 'Centre de démonstration SAS', legal_form = 'SAS',
      address_line1 = '1 rue de l''Exemple', postal_code = '38070', city = 'Saint-Quentin-Fallavier',
      siren = '123456789', siret = '12345678900012', vat_number = 'FR32123456789', rcs_city = 'Vienne',
      bank_iban = 'FR7630006000011234567890189', bank_bic = 'AGRIFRPP'
    where id = ${DEFAULT_TENANT_ID}`

  let serviceActe = ''
  let serviceForfait = ''

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`truncate table document_sequences`
    await owner.db.execute(identiteDuCentre)
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
    serviceActe = (
      await one(sql`
        insert into services (code, name, nature, unit, unit_price_cents)
        values ('courrier.ouverture', 'Ouverture et numérisation', 'act', 'unit', 300) returning id`)
    ).id as string
    serviceForfait = (
      await one(sql`
        insert into services (name, nature, unit, unit_price_cents)
        values ('Standard téléphonique', 'package', 'month', 5000) returning id`)
    ).id as string
  })

  after(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`truncate table document_sequences`
    await owner.client`
      update tenants set legal_name = null, legal_form = null, address_line1 = null, postal_code = null,
        city = null, siren = null, siret = null, vat_number = null, rcs_city = null, bank_iban = null,
        bank_bic = null
      where id = ${DEFAULT_TENANT_ID}`
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  it('lit les documents émis, résout ressources et services, et rattache les avoirs', async () => {
    // Bureau loué sous contrat depuis janvier : son occupation est une réservation.
    const contrat = (
      await one(sql`
        insert into contracts (client_id, reference, contract_type, status, starts_on, amount_cents, resource_id)
        values (${DURAND}, 'BUR-IND', 'bureau', 'active', '2026-01-01', 90000, ${BUREAU})
        returning id`)
    ).id as string
    const reservation = (
      await one(sql`
        insert into bookings (resource_id, client_id, channel, starts_at, ends_at, title,
                              quote_unit, quote_quantity, quote_unit_price_cents, quote_vat_rate_bp,
                              quote_currency, quoted_at)
        values (${SALLE}, ${DURAND}, 'staff', '2026-09-10T08:00:00Z', '2026-09-10T10:00:00Z', 'Réunion',
                'hour', 2, 2500, 2000, 'EUR', now())
        returning id`)
    ).id as string
    // Ni une demande en attente, ni une annulée ne comptent dans l'occupation.
    await one(sql`
      insert into bookings (resource_id, client_id, channel, status, starts_at, ends_at, title)
      values (${SALLE}, ${DURAND}, 'staff', 'pending', '2026-09-11T08:00:00Z', '2026-09-11T10:00:00Z', 'Demande')
      returning id`)
    await one(sql`
      insert into bookings (resource_id, client_id, channel, status, cancelled_at, starts_at, ends_at, title)
      values (${SALLE}, ${DURAND}, 'staff', 'cancelled', now(), '2026-09-12T08:00:00Z', '2026-09-12T10:00:00Z', 'Annulée')
      returning id`)
    const souscription = (
      await one(sql`
        insert into subscribed_services (client_id, service_id, unit, unit_price_cents, vat_rate_bp, starts_on)
        values (${DURAND}, ${serviceForfait}, 'month', 5000, 2000, '2026-01-01')
        returning id`)
    ).id as string

    // Facture d'août, sur la salle, émise puis antidatée : elle sera créditée
    // dans la période sans en faire partie.
    const aout = await brouillon()
    const ligneAout = (
      await one(sql`
        insert into invoice_lines (invoice_id, kind, description, unit_price_cents, vat_rate_bp, resource_id)
        values (${aout}, 'other', 'Location de salle', 20000, 2000, ${SALLE})
        returning id`)
    ).id as string
    await emettre(aout)
    await owner.client.begin(async (tx) => {
      // Les gardes de la facture émise sont des triggers : le rôle de
      // réplication les suspend, le temps de reculer la date d'émission.
      await tx`set local session_replication_role = replica`
      await tx`update invoices set issue_date = '2026-08-15' where id = ${aout}`
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
    await one(sql`
      insert into invoice_lines (invoice_id, kind, description, unit_price_cents, vat_rate_bp, credited_line_id)
      values (${avoir}, 'other', 'Geste sur la location d’août', 5000, 2000, ${ligneAout})
      returning id`)
    await emettre(avoir)

    // Un brouillon ne compte pas.
    const enCours = await brouillon()
    await one(sql`
      insert into invoice_lines (invoice_id, kind, description, unit_price_cents, vat_rate_bp, resource_id)
      values (${enCours}, 'other', 'Brouillon', 77700, 2000, ${SALLE})
      returning id`)

    // Paiements : un reçu aujourd'hui, un annulé.
    await one(sql`
      insert into payments (invoice_id, amount_cents, paid_on, method, recorded_by)
      values (${septembre}, 10000, ${AUJOURDHUI}, 'transfer', ${ACCUEIL}) returning id`)
    const erreur = (
      await one(sql`
        insert into payments (invoice_id, amount_cents, paid_on, method, recorded_by)
        values (${septembre}, 99900, ${AUJOURDHUI}, 'transfer', ${ACCUEIL}) returning id`)
    ).id as string
    await one(sql`
      update payments set cancelled_at = now(), cancelled_by = ${ACCUEIL}, cancellation_reason = 'Erreur de pointage'
      where id = ${erreur} returning id`)

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
