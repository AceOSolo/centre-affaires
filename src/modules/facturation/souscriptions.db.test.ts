import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { invoiceLines, invoices, subscribedServices } from './schema-factures.ts'
import {
  SubscriptionRefusedError,
  cancelSubscription,
  changeSubscriptionConditions,
  findMailOpeningUsage,
  findSubscription,
  listClientSubscriptions,
  listSubscribableServices,
  listSubscriptionContracts,
  setSubscriptionEnd,
  subscribe,
} from './souscriptions-queries.ts'
import type { SubscriptionInput, SubscriptionTerms } from './souscriptions-regles.ts'

/**
 * Services souscrits (R18, R07, ADR 024), par les fonctions que l'écran
 * appelle, sous le rôle applicatif :
 *
 * - souscrire fige le prix, l'unité, la devise et la TVA ;
 * - pas deux souscriptions au même service, pour le même contrat, sur des
 *   jours communs ;
 * - changer les conditions met fin la veille et souscrit à nouveau, sans
 *   jamais réécrire une ligne convenue ni un jour déjà facturé ;
 * - une souscription prend fin, ou s'annule si rien n'a été facturé : jamais
 *   de suppression ;
 * - les actes inclus se consomment dans l'ordre des plis ouverts du mois.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('services souscrits', { skip: raison }, () => {
  // Les fonctions du module ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const DURAND = '01a00000-0000-7000-8000-0000005b0c01'
  const PETIT = '01a00000-0000-7000-8000-0000005b0c02'
  const STANDARD = '01a00000-0000-7000-8000-0000005b5e01'
  const PLI = '01a00000-0000-7000-8000-0000005b5e02'
  const ANCIEN = '01a00000-0000-7000-8000-0000005b5e03'
  const CONTRAT = '01a00000-0000-7000-8000-0000005bc001'
  const CONTRAT_PETIT = '01a00000-0000-7000-8000-0000005bc002'
  const ACCUEIL = '01a00000-0000-7000-8000-0000005b0d01'
  const PARIS = 'Europe/Paris'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  const refusal = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run()
    } catch (error) {
      assert.ok(error instanceof SubscriptionRefusedError, String(error))
      return error.message
    }
    assert.fail('La base aurait dû refuser.')
  }

  const forfait = (values: Partial<SubscriptionInput> = {}): SubscriptionInput => ({
    serviceId: STANDARD,
    contractId: null,
    quantity: 2,
    unitPriceCents: 4_500,
    discountBp: null,
    discountAmountCents: null,
    vatRateBp: 2_000,
    includedQuantity: null,
    startsOn: '2026-01-01',
    endsOn: null,
    notes: null,
    ...values,
  })

  const conditions = (values: Partial<SubscriptionTerms> = {}): SubscriptionTerms => ({
    quantity: 2,
    unitPriceCents: 4_500,
    discountBp: null,
    discountAmountCents: null,
    vatRateBp: 2_000,
    includedQuantity: null,
    ...values,
  })

  const ligneSouscription = async (id: string) => {
    const [row] = await asTenant((tx) =>
      tx.select().from(subscribedServices).where(eq(subscribedServices.id, id)),
    )
    return row
  }

  /** Facture brouillon qui porte le forfait de septembre de la souscription. */
  const facturerSeptembre = async (subscriptionId: string) =>
    asTenant(async (tx) => {
      const [invoice] = await tx
        .insert(invoices)
        .values({ clientId: DURAND, periodStart: '2026-09-01', periodEnd: '2026-09-30' })
        .returning({ id: invoices.id })
      await tx.insert(invoiceLines).values({
        invoiceId: invoice.id,
        kind: 'package',
        description: 'Standard téléphonique, septembre',
        subscribedServiceId: subscriptionId,
        serviceId: STANDARD,
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        quantity: 2,
        unit: 'month',
        unitPriceCents: 4_500,
        vatRateBp: 2_000,
      })
      return invoice.id
    })

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email) values (${ACCUEIL}, 'accueil@centre.fr')`)
      await tx.execute(sql`
        insert into clients (id, name) values (${DURAND}, 'Atelier Durand'), (${PETIT}, 'Boulangerie Petit')`)
      await tx.execute(sql`
        insert into services (id, code, name, nature, unit, unit_price_cents, vat_rate_bp, is_active) values
          (${STANDARD}, null, 'Standard téléphonique', 'package', 'month', 5000, 2000, true),
          (${PLI}, 'courrier.ouverture', 'Ouverture et numérisation d’un pli', 'act', 'unit', 300, 2000, true),
          (${ANCIEN}, null, 'Télécopie', 'package', 'month', 1000, 2000, false)`)
      await tx.execute(sql`
        insert into contracts (id, client_id, reference, contract_type, status, starts_on, amount_cents) values
          (${CONTRAT}, ${DURAND}, 'DOM-DURAND', 'domiciliation', 'active', '2026-01-01', 3000),
          (${CONTRAT_PETIT}, ${PETIT}, 'DOM-PETIT', 'domiciliation', 'active', '2026-01-01', 3000)`)
    })
  })

  after(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  describe('souscrire', () => {
    it('fige le prix, l’unité, la devise et la TVA à la souscription', async () => {
      const id = await subscribe(DURAND, forfait({ discountBp: 1_000 }))
      // Le catalogue change ensuite : la souscription n'en sait rien.
      await asTenant((tx) => tx.execute(sql`update services set unit_price_cents = 6000 where id = ${STANDARD}`))

      const ligne = await ligneSouscription(id)
      assert.equal(ligne.unitPriceCents, 4_500)
      assert.equal(ligne.unit, 'month')
      assert.equal(ligne.currency, 'EUR')
      assert.equal(ligne.vatRateBp, 2_000)
      // 2 × 45,00 € − 10 % : 81,00 € par période, calculé par la base.
      assert.equal(ligne.netAmountCents, 8_100)
    })

    it('ne propose que les services actifs et vivants, et les contrats en cours du client', async () => {
      assert.deepEqual(
        (await listSubscribableServices()).map((service) => service.name),
        ['Standard téléphonique', 'Ouverture et numérisation d’un pli'],
      )
      assert.deepEqual(
        (await listSubscriptionContracts(DURAND)).map((contract) => contract.reference),
        ['DOM-DURAND'],
      )
    })

    it('refuse deux souscriptions au même service sur des jours communs, sauf pour un autre contrat', async () => {
      await subscribe(DURAND, forfait({ endsOn: '2026-12-31' }))
      assert.match(
        await refusal(() => subscribe(DURAND, forfait({ startsOn: '2026-12-31' }))),
        /recouvre/,
      )
      // Le lendemain, ou dans le cadre d'un contrat : permis.
      await subscribe(DURAND, forfait({ startsOn: '2027-01-01' }))
      await subscribe(DURAND, forfait({ contractId: CONTRAT }))
      assert.equal((await listClientSubscriptions(DURAND)).length, 3)
    })

    it('refuse un service qui n’est plus proposé, une fiche archivée, le contrat d’un autre client', async () => {
      assert.match(await refusal(() => subscribe(DURAND, forfait({ serviceId: ANCIEN }))), /plus proposé/)
      assert.match(
        await refusal(() => subscribe(DURAND, forfait({ contractId: CONTRAT_PETIT }))),
        /pas un contrat de ce client/,
      )
      await asTenant((tx) => tx.execute(sql`update clients set deleted_at = now() where id = ${PETIT}`))
      assert.match(await refusal(() => subscribe(PETIT, forfait())), /archivée/)
    })
  })

  describe('changer les conditions', () => {
    it('met fin la veille de la date d’effet et souscrit aux nouvelles conditions', async () => {
      const id = await subscribe(DURAND, forfait({ endsOn: '2027-06-30', notes: 'Deux lignes' }))
      const suite = await changeSubscriptionConditions(id, '2026-10-01', conditions({ quantity: 3 }), null)

      const ancienne = await ligneSouscription(id)
      assert.equal(ancienne.endsOn, '2026-09-30')
      assert.equal(ancienne.quantity, 2)
      assert.equal(ancienne.deletedAt, null)

      const nouvelle = await ligneSouscription(suite)
      assert.equal(nouvelle.startsOn, '2026-10-01')
      assert.equal(nouvelle.endsOn, '2027-06-30')
      assert.equal(nouvelle.quantity, 3)
      assert.equal(nouvelle.netAmountCents, 13_500)
      assert.equal(nouvelle.notes, 'Deux lignes')

      // L'historique se lit en lignes, la plus récente d'abord.
      assert.deepEqual(
        (await listClientSubscriptions(DURAND)).map((row) => [row.startsOn, row.endsOn, row.quantity]),
        [
          ['2026-10-01', '2027-06-30', 3],
          ['2026-01-01', '2026-09-30', 2],
        ],
      )
    })

    it('remplace au premier jour une souscription dont rien n’a été facturé', async () => {
      const id = await subscribe(DURAND, forfait({ startsOn: '2026-11-01' }))
      const suite = await changeSubscriptionConditions(
        id,
        '2026-11-01',
        conditions({ unitPriceCents: 4_000 }),
        'Prix négocié',
      )
      assert.ok((await ligneSouscription(id)).deletedAt)
      const nouvelle = await ligneSouscription(suite)
      assert.equal(nouvelle.startsOn, '2026-11-01')
      assert.equal(nouvelle.unitPriceCents, 4_000)
      assert.equal(nouvelle.notes, 'Prix négocié')
    })

    it('refuse des conditions inchangées', async () => {
      const id = await subscribe(DURAND, forfait())
      assert.match(
        await refusal(() => changeSubscriptionConditions(id, '2026-10-01', conditions(), null)),
        /rien ne change/,
      )
    })

    it('n’applique pas de nouvelles conditions à un jour déjà facturé', async () => {
      const id = await subscribe(DURAND, forfait())
      await facturerSeptembre(id)
      assert.deepEqual(
        { billedThrough: (await findSubscription(id))?.billedThrough, lines: (await findSubscription(id))?.billedLineCount },
        { billedThrough: '2026-09-30', lines: 1 },
      )

      assert.match(
        await refusal(() =>
          changeSubscriptionConditions(id, '2026-09-15', conditions({ quantity: 3 }), null),
        ),
        /Déjà facturée jusqu’au 30 sept\. 2026/,
      )
      await changeSubscriptionConditions(id, '2026-10-01', conditions({ quantity: 3 }), null)
      assert.equal((await ligneSouscription(id)).endsOn, '2026-09-30')
    })
  })

  describe('mettre fin, annuler', () => {
    it('fixe le dernier jour, le déplace, le retire', async () => {
      const id = await subscribe(DURAND, forfait())
      await setSubscriptionEnd(id, '2026-12-31')
      assert.equal((await ligneSouscription(id)).endsOn, '2026-12-31')
      await setSubscriptionEnd(id, null)
      assert.equal((await ligneSouscription(id)).endsOn, null)
    })

    it('refuse une fin avant le premier jour ou avant le dernier jour facturé', async () => {
      const id = await subscribe(DURAND, forfait())
      assert.match(await refusal(() => setSubscriptionEnd(id, '2025-12-31')), /annulez-la/)
      await facturerSeptembre(id)
      assert.match(await refusal(() => setSubscriptionEnd(id, '2026-09-29')), /avoir/)
      await setSubscriptionEnd(id, '2026-09-30')
    })

    it('refuse de prolonger sur la souscription qui prend la suite', async () => {
      const id = await subscribe(DURAND, forfait())
      await changeSubscriptionConditions(id, '2026-10-01', conditions({ quantity: 3 }), null)
      assert.match(await refusal(() => setSubscriptionEnd(id, null)), /prend la suite/)
      assert.equal((await ligneSouscription(id)).endsOn, '2026-09-30')
    })

    it('annule une souscription jamais facturée, sans la supprimer', async () => {
      const id = await subscribe(DURAND, forfait())
      await cancelSubscription(id)
      const ligne = await ligneSouscription(id)
      assert.ok(ligne.deletedAt)
      // Elle reste dans l'historique, et ne change plus.
      assert.equal((await listClientSubscriptions(DURAND)).length, 1)
      assert.match(await refusal(() => setSubscriptionEnd(id, '2026-12-31')), /annulée/)
      // Annulée, elle ne bloque plus une nouvelle souscription aux mêmes dates.
      await subscribe(DURAND, forfait())
    })

    it('refuse d’annuler une souscription déjà facturée', async () => {
      const id = await subscribe(DURAND, forfait())
      await facturerSeptembre(id)
      assert.match(await refusal(() => cancelSubscription(id)), /mettez-y fin/)
      assert.equal((await ligneSouscription(id)).deletedAt, null)
    })
  })

  describe('actes inclus', () => {
    const pli = (openedAt: string | null, values: { deleted?: boolean } = {}) =>
      asTenant((tx) =>
        tx.execute(sql`
          insert into mail_items (client_id, status, opened_at, opened_by, sender, deleted_at)
          values (${DURAND}, ${openedAt ? 'opened' : 'received'}, ${openedAt}, ${openedAt ? ACCUEIL : null},
                  'URSSAF', ${values.deleted ? sql`now()` : null})`),
      )

    it('compte les plis ouverts du mois du centre, les premiers inclus', async () => {
      const id = await subscribe(DURAND, {
        ...forfait({ serviceId: PLI, quantity: 1, unitPriceCents: 250 }),
        includedQuantity: 2,
      })
      await pli('2026-08-31T21:30:00Z') // 31 août à 23h30 à Paris : août, hors du mois.
      await pli('2026-08-31T22:30:00Z') // 1er septembre à 0h30 à Paris : septembre.
      await pli('2026-09-10T09:00:00Z')
      await pli('2026-09-15T09:00:00Z')
      await pli(null) // Reçu, pas ouvert.
      await pli('2026-09-16T09:00:00Z', { deleted: true }) // Retiré.

      const usage = await findMailOpeningUsage(DURAND, '2026-09-20', PARIS)
      assert.deepEqual(usage.get(id), { acts: 3, included: 2, beyond: 1 })
    })

    it('ne compte rien sans souscription au service courrier.ouverture', async () => {
      await pli('2026-09-10T09:00:00Z')
      assert.equal((await findMailOpeningUsage(DURAND, '2026-09-20', PARIS)).size, 0)
    })
  })
})
