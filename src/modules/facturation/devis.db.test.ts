import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'

import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID, tenants } from '../../db/tenants.ts'
import { wallClockToUtc } from '../../lib/dates.ts'
import { contractSchedule } from '../contrats/echeancier.ts'
import { scheduleVersions, selectPriceVersions } from '../contrats/versions.ts'
import { contractLines, contracts } from '../contrats/schema.ts'
import {
  QuoteDiscountError,
  createBooking,
  createBookingRequest,
  moveBooking,
} from '../reservations/queries.ts'
import { bookings } from '../reservations/schema.ts'
import { quote } from './devis-queries.ts'
import { parseBankDetails, parsePricingRules, parseSellerIdentity } from './parametres.ts'
import { invoiceLines, invoices } from './schema-factures.ts'
import {
  DefaultRatePlanConflictError,
  addRatePlanItem,
  archiveRatePlan,
  createRatePlan,
  findApplicableRate,
  findDefaultRatePlan,
  removeRatePlanItem,
  updateRatePlan,
} from './queries.ts'

/**
 * Moteur de devis contre la base (R08, R10, R11, ADR 023) : la grille par
 * défaut ou celle du contrat du client, ses dates de validité, les règles du
 * centre, et le devis figé sur la réservation à l'écriture — dont le montant
 * HT, recalculé par la base, doit tomber au centime sur celui annoncé.
 *
 * Fonctions appelées telles que l'application les appelle, sous le rôle
 * applicatif.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('devis des réservations', { skip: raison }, () => {
  // Les requêtes du module ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const SALLE = '01a00000-0000-7000-8000-000000d0b001'
  const BUREAU = '01a00000-0000-7000-8000-000000d0b002'
  const VEHICULE = '01a00000-0000-7000-8000-000000d0b003'
  const CLIENT = '01a00000-0000-7000-8000-000000d0c001'
  const AUTRE_CLIENT = '01a00000-0000-7000-8000-000000d0c002'
  const PUBLIQUE = '01a00000-0000-7000-8000-000000d0a001'
  const RESIDENTS = '01a00000-0000-7000-8000-000000d0a002'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  /** Créneau en heure murale de Paris, le fuseau du centre. */
  const creneau = (debut: string, fin: string) => ({
    startsAt: wallClockToUtc(debut, 'Europe/Paris'),
    endsAt: wallClockToUtc(fin, 'Europe/Paris'),
  })

  const MATIN = creneau('2026-10-06T09:00', '2026-10-06T13:00')
  const JOURNEE = creneau('2026-10-06T09:00', '2026-10-06T18:00')

  const lireReservation = async (id: string) => {
    const [row] = await asTenant((tx) => tx.select().from(bookings).where(eq(bookings.id, id)))
    return row
  }

  const prixDe = (ratePlanId: string, resourceType: 'salle' | 'bureau', unit: 'half_day' | 'day', amountCents: number) =>
    addRatePlanItem({ ratePlanId, resourceType, unit, amountCents })

  /** Contrat actif du client qui désigne la grille des résidents. */
  const contratResident = async (clientId = CLIENT) => {
    const [row] = await asTenant((tx) =>
      tx
        .insert(contracts)
        .values({
          clientId,
          reference: `RES-${clientId.slice(-3)}`,
          contractType: 'domiciliation',
          startsOn: '2026-09-01',
          amountCents: 3_000,
          ratePlanId: RESIDENTS,
        })
        .returning({ id: contracts.id }),
    )
    await asTenant((tx) => tx.update(contracts).set({ status: 'active' }).where(eq(contracts.id, row.id)))
    return row.id
  }

  const reinitialiserCentre = () =>
    owner.client`
      update tenants set
        prorata_rule = 'calendar_days', started_unit_tolerance_minutes = 0, half_day_minutes = 240,
        default_vat_rate_bp = 2000, default_payment_method = 'transfer',
        legal_name = null, legal_form = null, share_capital_cents = null,
        address_line1 = null, address_line2 = null, postal_code = null, city = null, country = 'FR',
        siren = null, siret = null, vat_number = null, rcs_city = null,
        bank_iban = null, bank_bic = null, sepa_creditor_id = null
      where id = ${DEFAULT_TENANT_ID}`

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await reinitialiserCentre()
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${SALLE}, 'salle', 'SAL-MB', 'Salle Mont Blanc'),
          (${BUREAU}, 'bureau', 'BUR-03', 'Bureau 3'),
          (${VEHICULE}, 'vehicule', 'VEH-01', 'Utilitaire')`)
      await tx.execute(sql`
        insert into clients (id, name) values (${CLIENT}, 'Acme SAS'), (${AUTRE_CLIENT}, 'Beta SARL')`)
      await tx.execute(sql`
        insert into rate_plans (id, name, is_default) values
          (${PUBLIQUE}, 'Tarifs publics 2026', true),
          (${RESIDENTS}, 'Tarifs résidents', false)`)
    })
    // La grille réelle du centre (ADR 009), et une grille de contrat moins chère.
    await prixDe(PUBLIQUE, 'salle', 'half_day', 9_000)
    await prixDe(PUBLIQUE, 'salle', 'day', 13_000)
    await prixDe(PUBLIQUE, 'bureau', 'half_day', 3_335)
    await prixDe(RESIDENTS, 'salle', 'half_day', 7_000)
  })

  afterEach(async () => {
    await reinitialiserCentre()
  })

  after(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await reinitialiserCentre()
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  describe('quote()', () => {
    it('chiffre un créneau à la grille par défaut, TVA du centre comprise', async () => {
      const result = await quote({ resourceId: SALLE, ...MATIN })
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.quote.unit, 'half_day')
      assert.equal(result.quote.netCents, 9_000)
      assert.equal(result.quote.vatCents, 1_800)
      assert.equal(result.quote.totalCents, 10_800)
      assert.equal(result.quote.ratePlanId, PUBLIQUE)
      assert.deepEqual(result.quote.source, { kind: 'default' })
    })

    it('retient la journée pour neuf heures', async () => {
      const result = await quote({ resourceId: SALLE, ...JOURNEE })
      assert.equal(result.ok && result.quote.unit, 'day')
      assert.equal(result.ok && result.quote.netCents, 13_000)
    })

    it('lit les règles du centre : demi-journée, tolérance, TVA (R10)', async () => {
      await owner.client`
        update tenants set half_day_minutes = 300, started_unit_tolerance_minutes = 10,
          default_vat_rate_bp = 1000
        where id = ${DEFAULT_TENANT_ID}`
      const result = await quote({ resourceId: SALLE, ...creneau('2026-10-06T09:00', '2026-10-06T14:10') })
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.quote.unit, 'half_day')
      assert.equal(result.quote.quantity, 1)
      assert.equal(result.quote.vatRateBp, 1_000)
      assert.equal(result.quote.vatCents, 900)
    })

    it('ignore la grille par défaut hors de ses dates de validité (R08)', async () => {
      await asTenant((tx) =>
        tx.execute(sql`update rate_plans set valid_to = '2026-09-30' where id = ${PUBLIQUE}`),
      )
      const result = await quote({ resourceId: SALLE, ...MATIN })
      assert.deepEqual(result.ok ? 'chiffré' : result.reason, 'aucune-grille')

      assert.equal(await findDefaultRatePlan('2026-10-06'), undefined)
      assert.equal((await findDefaultRatePlan('2026-09-30'))?.id, PUBLIQUE)
      const lookup = { resourceId: SALLE, resourceType: 'salle' as const, unit: 'half_day' as const }
      assert.equal(await findApplicableRate({ ...lookup, on: '2026-10-06' }), undefined)
      assert.equal((await findApplicableRate({ ...lookup, on: '2026-09-30' }))?.item.amountCents, 9_000)
    })

    it('applique la grille du contrat en cours du client avant celle du centre', async () => {
      await contratResident()
      const resident = await quote({ resourceId: SALLE, ...MATIN, clientId: CLIENT })
      assert.equal(resident.ok && resident.quote.netCents, 7_000)
      assert.deepEqual(resident.ok && resident.quote.source, {
        kind: 'contract',
        contractId: (await asTenant((tx) => tx.select({ id: contracts.id }).from(contracts)))[0].id,
        contractReference: 'RES-001',
      })

      // Un autre client, ou une date d'avant le contrat : la grille du centre.
      const autre = await quote({ resourceId: SALLE, ...MATIN, clientId: AUTRE_CLIENT })
      assert.equal(autre.ok && autre.quote.netCents, 9_000)
      const avant = await quote({
        resourceId: SALLE,
        ...creneau('2026-08-31T09:00', '2026-08-31T13:00'),
        clientId: CLIENT,
      })
      assert.equal(avant.ok && avant.quote.netCents, 9_000)
    })

    it('retombe sur la grille du centre quand celle du contrat ne tarife pas la ressource ou est archivée', async () => {
      await contratResident()
      const bureau = await quote({ resourceId: BUREAU, ...MATIN, clientId: CLIENT })
      assert.equal(bureau.ok && bureau.quote.ratePlanId, PUBLIQUE)

      await archiveRatePlan(RESIDENTS)
      const salle = await quote({ resourceId: SALLE, ...MATIN, clientId: CLIENT })
      assert.equal(salle.ok && salle.quote.netCents, 9_000)
    })

    it('dit pourquoi un créneau n’est pas chiffré', async () => {
      const vehicule = await quote({ resourceId: VEHICULE, ...MATIN })
      assert.equal(vehicule.ok ? 'chiffré' : vehicule.reason, 'aucun-tarif')
      assert.equal(vehicule.ok ? '' : vehicule.message.length > 0, true)
      const inconnue = await quote({ resourceId: '01a00000-0000-7000-8000-000000d0b0ff', ...MATIN })
      assert.equal(inconnue.ok ? 'chiffré' : inconnue.reason, 'ressource-inconnue')
    })
  })

  describe('devis figé sur la réservation (R11)', () => {
    it('fige le devis à l’écriture ; la base tombe au centime sur le montant annoncé', async () => {
      const discount = { kind: 'percent' as const, basisPoints: 1_000 }
      const annonce = await quote({ resourceId: BUREAU, ...MATIN, discount })
      assert.equal(annonce.ok, true)
      if (!annonce.ok) return
      // 33,35 € remisés de 10 % : 30,015 €, arrondi une seule fois.
      assert.equal(annonce.quote.netCents, 3_002)

      const created = await createBooking({
        resourceId: BUREAU,
        ...MATIN,
        title: 'Rendez-vous client',
        pricing: { mode: 'grid', discount },
      })
      const row = await lireReservation(created.id)
      assert.equal(row.quoteUnit, 'half_day')
      assert.equal(row.quoteQuantity, 1)
      assert.equal(row.quoteUnitPriceCents, 3_335)
      assert.equal(row.quoteDiscountBp, 1_000)
      assert.equal(row.quoteVatRateBp, 2_000)
      assert.equal(row.quoteCurrency, 'EUR')
      assert.equal(row.quoteRatePlanItemId, annonce.quote.ratePlanItemId)
      assert.ok(row.quotedAt)
      // Colonne générée par la base, par la même règle d'arrondi.
      assert.equal(row.quoteAmountCents, annonce.quote.netCents)
    })

    it('garde le prix figé quand la grille change ensuite', async () => {
      const created = await createBooking({ resourceId: SALLE, ...MATIN, title: 'Comité' })
      const [ancien] = await asTenant((tx) =>
        tx.execute(sql`select id from rate_plan_items where rate_plan_id = ${PUBLIQUE} and unit = 'half_day' and resource_type = 'salle'`),
      )
      await removeRatePlanItem(ancien.id as string)
      await prixDe(PUBLIQUE, 'salle', 'half_day', 10_000)

      assert.equal((await lireReservation(created.id)).quoteAmountCents, 9_000)
      const nouveau = await quote({ resourceId: SALLE, ...MATIN })
      assert.equal(nouveau.ok && nouveau.quote.netCents, 10_000)
    })

    it('ne chiffre pas une réservation interne', async () => {
      const created = await createBooking({
        resourceId: SALLE,
        ...MATIN,
        title: 'Entretien',
        pricing: { mode: 'none' },
      })
      const row = await lireReservation(created.id)
      assert.equal(row.quotedAt, null)
      assert.equal(row.quoteAmountCents, null)
    })

    it('enregistre sans prix un créneau que la grille ne tarife pas', async () => {
      const created = await createBooking({ resourceId: VEHICULE, ...MATIN, title: 'Livraison' })
      assert.equal((await lireReservation(created.id)).quotedAt, null)
    })

    it('refuse une remise plus grande que le montant, sans rien écrire', async () => {
      await assert.rejects(
        createBooking({
          resourceId: SALLE,
          ...MATIN,
          title: 'Comité',
          pricing: { mode: 'grid', discount: { kind: 'amount', cents: 9_001 } },
        }),
        QuoteDiscountError,
      )
      const [{ n }] = await asTenant((tx) => tx.execute(sql`select count(*)::int as n from bookings`))
      assert.equal(n, 0)
    })

    it('fige le montant annoncé sur une demande publique', async () => {
      const created = await createBookingRequest({
        resourceId: SALLE,
        ...JOURNEE,
        title: 'Séminaire',
        requesterName: 'Camille Dupont',
        requesterEmail: 'camille@exemple.fr',
        requesterPhone: '0600000000',
      })
      const row = await lireReservation(created.id)
      assert.equal(row.status, 'pending')
      assert.equal(row.quoteUnit, 'day')
      assert.equal(row.quoteAmountCents, 13_000)
    })

    it('applique la grille du contrat du client à l’écriture', async () => {
      await contratResident()
      const created = await createBooking({ resourceId: SALLE, ...MATIN, title: 'Point', clientId: CLIENT })
      assert.equal((await lireReservation(created.id)).quoteAmountCents, 7_000)
    })

    it('refait le devis d’une réservation déplacée, remise gardée', async () => {
      const created = await createBooking({
        resourceId: SALLE,
        ...MATIN,
        title: 'Comité',
        pricing: { mode: 'grid', discount: { kind: 'percent', basisPoints: 1_000 } },
      })
      await moveBooking({ id: created.id, resourceId: SALLE, ...JOURNEE })
      const row = await lireReservation(created.id)
      assert.equal(row.quoteUnit, 'day')
      assert.equal(row.quoteDiscountBp, 1_000)
      assert.equal(row.quoteAmountCents, 11_700)
    })

    it('ne refait pas le devis d’une réservation déjà portée sur une facture', async () => {
      const created = await createBooking({ resourceId: SALLE, ...MATIN, title: 'Comité', clientId: CLIENT })
      await asTenant(async (tx) => {
        const [facture] = await tx
          .insert(invoices)
          .values({ clientId: CLIENT, periodStart: '2026-10-01', periodEnd: '2026-10-31' })
          .returning({ id: invoices.id })
        await tx.insert(invoiceLines).values({
          invoiceId: facture.id,
          kind: 'booking',
          bookingId: created.id,
          description: 'Salle Mont Blanc, 6 octobre',
          unitPriceCents: 9_000,
          vatRateBp: 2_000,
        })
      })
      await moveBooking({ id: created.id, resourceId: SALLE, ...JOURNEE })
      const row = await lireReservation(created.id)
      assert.equal(row.quoteUnit, 'half_day')
      assert.equal(row.quoteAmountCents, 9_000)
    })
  })

  describe('grilles : validité et rôle (R08)', () => {
    it('applique aussitôt des dates de validité modifiées', async () => {
      assert.equal(
        await updateRatePlan(PUBLIQUE, {
          name: 'Tarifs publics 2027',
          isDefault: true,
          validFrom: '2027-01-01',
          validTo: null,
        }),
        true,
      )
      const result = await quote({ resourceId: SALLE, ...MATIN })
      assert.equal(result.ok ? 'chiffré' : result.reason, 'aucune-grille')
    })

    it('refuse une seconde grille par défaut', async () => {
      await assert.rejects(
        updateRatePlan(RESIDENTS, { name: 'Tarifs résidents', isDefault: true }),
        DefaultRatePlanConflictError,
      )
      await assert.rejects(createRatePlan({ name: 'Autre', isDefault: true }), DefaultRatePlanConflictError)
    })

    it('ne modifie pas une grille archivée', async () => {
      await archiveRatePlan(RESIDENTS)
      assert.equal(await updateRatePlan(RESIDENTS, { name: 'Renommée' }), false)
    })
  })

  describe('paramètres du centre (R10)', () => {
    it('écrit ce que l’écran de configuration valide, sous les contraintes de la base', async () => {
      const sections = [
        parsePricingRules({
          prorataRule: 'thirty_day_month',
          startedUnitToleranceMinutes: '10',
          halfDayMinutes: '300',
          defaultVatRate: '5,5',
        }),
        parseSellerIdentity({
          legalName: 'Centre d’affaires SAS',
          legalForm: 'SAS',
          shareCapital: '21 500 000',
          siren: '732829320',
          siret: '73282932000074',
          vatNumber: 'FR44732829320',
          rcsCity: 'Vienne',
          addressLine1: '1 rue de la Gare',
          postalCode: '38200',
          city: 'Vienne',
          country: 'FR',
        }),
        parseBankDetails({
          bankIban: 'FR76 3000 6000 0112 3456 7890 189',
          bankBic: 'AGRIFRPP882',
          sepaCreditorId: 'FR72ZZZ123456',
          defaultPaymentMethod: 'direct_debit',
        }),
      ]
      for (const section of sections) {
        assert.equal(section.ok, true)
        if (!section.ok) return
        await asTenant((tx) => tx.update(tenants).set(section.update).where(eq(tenants.id, DEFAULT_TENANT_ID)))
      }
      const [centre] = await asTenant((tx) => tx.select().from(tenants).where(eq(tenants.id, DEFAULT_TENANT_ID)))
      assert.equal(centre.prorataRule, 'thirty_day_month')
      assert.equal(centre.defaultVatRateBp, 550)
      assert.equal(centre.shareCapitalCents, 2_150_000_000)
      assert.equal(centre.bankIban, 'FR7630006000011234567890189')

      // Le devis suit aussitôt les nouvelles règles.
      const result = await quote({ resourceId: SALLE, ...creneau('2026-10-06T09:00', '2026-10-06T14:10') })
      assert.equal(result.ok && result.quote.unit, 'half_day')
      assert.equal(result.ok && result.quote.vatCents, 495)
    })
  })

  describe('échéancier lu en base (R10, ADR 025)', () => {
    it('lit la règle de prorata du centre et les lignes de la version, remises comprises', async () => {
      await owner.client`update tenants set prorata_rule = 'thirty_day_month' where id = ${DEFAULT_TENANT_ID}`
      const [contrat] = await asTenant((tx) =>
        tx
          .insert(contracts)
          .values({
            clientId: CLIENT,
            reference: 'BUR-2026-100',
            contractType: 'bureau',
            startsOn: '2026-03-10',
            amountCents: 0,
          })
          .returning({ id: contracts.id }),
      )
      await asTenant((tx) =>
        tx.insert(contractLines).values([
          { contractId: contrat.id, description: 'Bureau', unitPriceCents: 50_000, discountBp: 1_000 },
          { contractId: contrat.id, description: 'Domiciliation', unitPriceCents: 3_000, discountAmountCents: 500 },
          { contractId: contrat.id, description: 'Frais de dossier', unitPriceCents: 15_000, isRecurring: false },
        ]),
      )

      const [tenant] = await asTenant((tx) =>
        tx
          .select({ prorataRule: tenants.prorataRule })
          .from(tenants)
          .where(eq(tenants.id, DEFAULT_TENANT_ID)),
      )
      assert.equal(tenant.prorataRule, 'thirty_day_month')
      const versions = scheduleVersions(await asTenant((tx) => selectPriceVersions(tx, contrat.id)))
      assert.equal(versions.length, 1)
      assert.equal(versions[0].startsOn, '2026-03-10')
      assert.equal(versions[0].lines?.length, 3)

      const [row] = await asTenant((tx) => tx.select().from(contracts).where(eq(contracts.id, contrat.id)))
      // La base tient le montant du brouillon égal à ses lignes récurrentes.
      assert.equal(row.amountCents, 47_500)
      const periods = contractSchedule(row, versions, '2026-04-30', tenant.prorataRule)
      // Mars en base 30 : 21/30 de 450 € et de 25 €, plus 150 € de frais.
      assert.deepEqual(
        periods.map((period) => period.amountCents),
        [31_500 + 1_750 + 15_000, 47_500],
      )
    })
  })
})
