import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { priceOffer } from './offres-prix.ts'
import {
  ArchivedOfferError,
  addOfferItem,
  archiveOffer,
  countContractsFromOffer,
  createOffer,
  findOffer,
  listOffers,
  loadOfferCatalogue,
  removeOfferItem,
  toOfferInput,
  updateOffer,
  updateOfferItem,
} from './offres-queries.ts'
import type { OfferItemInput } from './offres-regles.ts'
import { seedExpectedServices } from './services-attendus.ts'
import {
  ArchivedServiceError,
  DuplicateServiceCodeError,
  archiveService,
  createService,
  findService,
  findServiceUsage,
  listServices,
  updateService,
} from './services-queries.ts'
import type { ServiceInput } from './services-regles.ts'

/**
 * Catalogue de services et offres groupées (R18, R09, ADR 024), par les
 * fonctions que l'écran appelle, sous le rôle applicatif : codes stables,
 * archivage sans suppression, services attendus semés sans prix inventé,
 * lignes d'offre et prix d'une offre au catalogue du jour.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('catalogue de services et offres groupées', { skip: raison }, () => {
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const BAL = '01a00000-0000-7000-8000-0000005c0b01'
  const BUREAU = '01a00000-0000-7000-8000-0000005c0b02'
  const GRILLE = '01a00000-0000-7000-8000-0000005c0a01'
  const DURAND = '01a00000-0000-7000-8000-0000005c0c01'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  const service = (values: Partial<ServiceInput> = {}): ServiceInput => ({
    code: null,
    name: 'Standard téléphonique',
    description: null,
    nature: 'package',
    unit: 'month',
    unitPriceCents: 5_000,
    vatRateBp: 2_000,
    isActive: true,
    ...values,
  })

  const ligne = (values: Partial<OfferItemInput>): OfferItemInput => ({
    resourceType: null,
    resourceId: null,
    serviceId: null,
    quantity: 1,
    unit: 'month',
    priceCents: null,
    discountBp: null,
    discountAmountCents: null,
    vatRateBp: null,
    ...values,
  })

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${BAL}, 'boite_aux_lettres', 'BAL-01', 'Boîte aux lettres 01'),
          (${BUREAU}, 'bureau', 'BUR-01', 'Bureau 1')`)
      await tx.execute(sql`
        insert into rate_plans (id, name, is_default) values (${GRILLE}, 'Tarifs publics', true)`)
      await tx.execute(sql`
        insert into rate_plan_items (rate_plan_id, resource_type, unit, amount_cents) values
          (${GRILLE}, 'boite_aux_lettres', 'month', 3000),
          (${GRILLE}, 'bureau', 'month', 60000)`)
      await tx.execute(sql`insert into clients (id, name) values (${DURAND}, 'Atelier Durand')`)
    })
  })

  after(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  describe('catalogue de services', () => {
    it('refuse un code déjà pris par un service vivant, et le rend à l’archivage', async () => {
      const premier = await createService(
        service({ code: 'courrier.ouverture', name: 'Ouverture', nature: 'act', unit: 'unit', unitPriceCents: 300 }),
      )
      await assert.rejects(
        createService(service({ code: 'courrier.ouverture', name: 'Doublon', nature: 'act', unit: 'unit' })),
        DuplicateServiceCodeError,
      )
      assert.equal(await archiveService(premier.id), true)
      assert.equal(await archiveService(premier.id), false)
      await createService(service({ code: 'courrier.ouverture', name: 'Ouverture', nature: 'act', unit: 'unit' }))

      // L'archivé reste en base, hors du catalogue.
      assert.deepEqual((await listServices({ archived: true })).map((row) => row.id), [premier.id])
      assert.equal((await findService(premier.id))?.isActive, false)
    })

    it('garde le code posé et la nature à la modification, et fige un service archivé', async () => {
      const cree = await createService(service({ code: 'standard' }))
      await updateService(
        cree.id,
        service({ code: 'autre-code', nature: 'act', unit: 'month', unitPriceCents: 5_500, isActive: false }),
      )
      const relu = await findService(cree.id)
      assert.equal(relu?.code, 'standard')
      assert.equal(relu?.nature, 'package')
      assert.equal(relu?.unitPriceCents, 5_500)
      assert.equal(relu?.isActive, false)

      await archiveService(cree.id)
      await assert.rejects(updateService(cree.id, service()), ArchivedServiceError)
    })

    it('dit ce qui emploie un service : souscriptions en cours, offres actives', async () => {
      const standard = await createService(service())
      await asTenant((tx) =>
        tx.execute(sql`
          insert into subscribed_services (client_id, service_id, unit, unit_price_cents, vat_rate_bp, starts_on, ends_on)
          values (${DURAND}, ${standard.id}, 'month', 5000, 2000, '2026-01-01', null),
                 (${DURAND}, ${standard.id}, 'month', 5000, 2000, '2025-01-01', '2025-12-31')`),
      )
      const offre = await createOffer({ name: 'Pack', description: null, billingPeriod: 'monthly', commitmentMonths: null })
      await addOfferItem(offre.id, ligne({ serviceId: standard.id }))

      assert.deepEqual(await findServiceUsage(standard.id, '2026-10-01'), {
        currentSubscriptions: 1,
        activeOffers: 1,
      })
      await archiveOffer(offre.id)
      assert.equal((await findServiceUsage(standard.id, '2026-10-01')).activeOffers, 0)
    })
  })

  describe('services attendus par l’application', () => {
    const semer = (prices: Record<string, number | null>) =>
      app.client.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${DEFAULT_TENANT_ID}, true)`
        return seedExpectedServices(tx, prices)
      })

    it('ne crée pas l’ouverture d’un pli sans prix fixé par le centre', async () => {
      assert.deepEqual(await semer({}), { created: [], existing: [], withoutPrice: ['courrier.ouverture'] })
      assert.deepEqual(await listServices(), [])
    })

    it('la crée au prix fixé, puis la laisse telle quelle', async () => {
      assert.deepEqual(await semer({ 'courrier.ouverture': 350 }), {
        created: ['courrier.ouverture'],
        existing: [],
        withoutPrice: [],
      })
      const [cree] = await listServices()
      assert.equal(cree.code, 'courrier.ouverture')
      assert.equal(cree.nature, 'act')
      assert.equal(cree.unit, 'unit')
      assert.equal(cree.unitPriceCents, 350)
      assert.equal(cree.vatRateBp, 2_000)

      // Le prix se gère ensuite à l'écran : rejouer ne l'écrase pas.
      await updateService(cree.id, { ...service({ nature: 'act', unit: 'unit' }), name: cree.name, unitPriceCents: 400 })
      assert.deepEqual(await semer({ 'courrier.ouverture': 350 }), {
        created: [],
        existing: ['courrier.ouverture'],
        withoutPrice: [],
      })
      assert.equal((await findService(cree.id))?.unitPriceCents, 400)
    })

    it('refuse un prix qui n’est pas un entier de centimes', async () => {
      await assert.rejects(semer({ 'courrier.ouverture': 3.5 }), RangeError)
    })
  })

  describe('offres groupées', () => {
    it('ajoute les lignes à la suite, les modifie, les retire sans les supprimer', async () => {
      const standard = await createService(service())
      const offre = await createOffer({
        name: 'Domiciliation Premium',
        description: null,
        billingPeriod: 'monthly',
        commitmentMonths: 12,
        currency: 'EUR',
      })
      const boite = await addOfferItem(offre.id, ligne({ resourceType: 'boite_aux_lettres' }))
      const tel = await addOfferItem(offre.id, ligne({ serviceId: standard.id, discountBp: 1_000 }))
      assert.deepEqual([boite.position, tel.position], [0, 1])

      assert.equal(await updateOfferItem(offre.id, tel.id, ligne({ serviceId: standard.id, priceCents: 4_000 })), true)
      assert.equal(await removeOfferItem(offre.id, boite.id), true)
      assert.equal(await removeOfferItem(offre.id, boite.id), false)

      const relue = await findOffer(offre.id)
      assert.deepEqual(
        relue?.items.map((item) => [item.serviceId, item.priceCents, item.discountBp]),
        [[standard.id, 4_000, null]],
      )
      const [{ total }] = await owner.client`select count(*)::int as total from offer_items`
      assert.equal(total, 2)
    })

    it('chiffre une offre au catalogue du jour : grille par défaut et prix des services', async () => {
      const standard = await createService(service())
      const pli = await createService(
        service({ name: 'Numérisation', nature: 'act', unit: 'unit', unitPriceCents: 300 }),
      )
      const offre = await createOffer({ name: 'Premium', description: null, billingPeriod: 'monthly', commitmentMonths: 12 })
      await addOfferItem(offre.id, ligne({ resourceId: BAL }))
      await addOfferItem(offre.id, ligne({ serviceId: standard.id, discountAmountCents: 1_000 }))
      await addOfferItem(offre.id, ligne({ serviceId: pli.id, unit: 'unit', quantity: 10 }))

      const relue = await findOffer(offre.id)
      assert.ok(relue)
      const quote = priceOffer(toOfferInput(relue), await loadOfferCatalogue('2026-10-01'))
      assert.equal(quote.complete, true)
      // 30,00 € de boîte, 50,00 € − 10,00 € de standard, dix numérisations incluses.
      assert.equal(quote.totalExclTaxCents, 7_000)
      assert.equal(quote.totalInclTaxCents, 8_400)
      assert.equal(quote.listAmountCents, 3_000 + 5_000 + 3_000)
      assert.equal(quote.commitment?.totalExclTaxCents, 84_000)
    })

    it('n’applique pas une grille par défaut hors de ses dates de validité', async () => {
      await asTenant((tx) => tx.execute(sql`update rate_plans set valid_to = '2026-09-30' where id = ${GRILLE}`))
      const offre = await createOffer({ name: 'Bureau', description: null, billingPeriod: 'monthly', commitmentMonths: null })
      await addOfferItem(offre.id, ligne({ resourceType: 'bureau' }))
      const relue = await findOffer(offre.id)
      assert.ok(relue)

      assert.equal(priceOffer(toOfferInput(relue), await loadOfferCatalogue('2026-09-30')).totalExclTaxCents, 60_000)
      const apres = priceOffer(toOfferInput(relue), await loadOfferCatalogue('2026-10-01'))
      assert.equal(apres.complete, false)
      assert.equal(apres.totalExclTaxCents, 0)
    })

    it('fige une offre archivée, qui reste lisible', async () => {
      const offre = await createOffer({ name: 'Ancienne', description: null, billingPeriod: 'quarterly', commitmentMonths: null })
      const item = await addOfferItem(offre.id, ligne({ resourceType: 'bureau', quantity: 3 }))
      assert.equal(await archiveOffer(offre.id), true)

      await assert.rejects(addOfferItem(offre.id, ligne({ resourceType: 'bureau' })), ArchivedOfferError)
      await assert.rejects(removeOfferItem(offre.id, item.id), ArchivedOfferError)
      await assert.rejects(
        updateOffer(offre.id, { name: 'Renommée', description: null, billingPeriod: 'monthly', commitmentMonths: null }),
        ArchivedOfferError,
      )
      assert.deepEqual((await listOffers()).map((row) => row.id), [])
      assert.deepEqual((await listOffers({ archived: true })).map((row) => row.items.length), [1])
    })

    it('compte les contrats tirés d’une offre', async () => {
      const offre = await createOffer({ name: 'Pack', description: null, billingPeriod: 'monthly', commitmentMonths: null })
      assert.equal(await countContractsFromOffer(offre.id), 0)
      await asTenant((tx) =>
        tx.execute(sql`
          insert into contracts (client_id, reference, contract_type, starts_on, amount_cents, offer_id)
          values (${DURAND}, 'PACK-1', 'domiciliation', '2026-10-01', 3000, ${offre.id})`),
      )
      assert.equal(await countContractsFromOffer(offre.id), 1)
    })
  })
})
