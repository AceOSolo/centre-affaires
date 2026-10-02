import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { contracts } from '../contrats/schema.ts'
import { notificationDeliveries } from '../notifications/schema.ts'
import {
  findPortalOffer,
  listOfferRequests,
  listPortalOffers,
  recentOfferRequest,
  requestOffer,
} from './offres-portail.ts'

/**
 * L'offre groupée dans l'espace client (R23, ADR 036), contre la base : le
 * client ne voit que les offres présentées, chiffrées par le moteur de la
 * vague 2 ; sa demande part à l'accueil et laisse sa trace dans le journal
 * des envois (ADR 038), que « Demandes » relit jusqu'à ce qu'un contrat en
 * soit tiré. Aucun contrat n'est créé par le client.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('offre groupée depuis l’espace client', { skip: raison }, () => {
  if (appUrl) process.env.APP_DATABASE_URL = appUrl
  delete process.env.SMTP_HOST

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const DURAND = '01a00000-0000-7000-8000-0000000f1c01'
  const PETIT = '01a00000-0000-7000-8000-0000000f1c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000f1d01'
  const PREMIUM = '01a00000-0000-7000-8000-0000000f1a01'
  const INTERNE = '01a00000-0000-7000-8000-0000000f1a02'
  const ANCIENNE = '01a00000-0000-7000-8000-0000000f1a03'
  const SCAN = '01a00000-0000-7000-8000-0000000f1b01'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)
  const journal = () => asTenant((tx) => tx.select().from(notificationDeliveries))
  const demander = () =>
    requestOffer({ account: durand[0], offer: { id: PREMIUM, name: 'Domiciliation Premium' } })

  let centreEmail: string | null = null

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
    const [tenant] = await owner.client`select email from tenants where id = ${DEFAULT_TENANT_ID}`
    centreEmail = tenant.email
  })

  beforeEach(async () => {
    await owner.client`truncate table contracts, offers, services, rate_plan_items, rate_plans, clients cascade`
    await owner.client`truncate table notification_deliveries, notification_templates`
    await owner.client`update tenants set email = 'accueil@centre.test' where id = ${DEFAULT_TENANT_ID}`
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Boulangerie Petit', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.test', 'Jeanne Martin')`)
      await tx.execute(sql`
        insert into services (id, code, name, nature, unit, unit_price_cents) values
          (${SCAN}, 'courrier.numerisation', 'Numérisation', 'act', 'unit', 300)`)
      await tx.execute(sql`
        insert into offers (id, name, client_visible, commitment_months) values
          (${PREMIUM}, 'Domiciliation Premium', true, 12),
          (${INTERNE}, 'Offre en préparation', false, null),
          (${ANCIENNE}, 'Ancienne offre', true, null)`)
      await tx.execute(sql`update offers set deleted_at = now() where id = ${ANCIENNE}`)
      await tx.execute(sql`
        insert into offer_items (offer_id, resource_type, quantity, unit, price_cents, label, position) values
          (${PREMIUM}, 'boite_aux_lettres', 1, 'month', 4000, 'Adresse de domiciliation', 0),
          (${INTERNE}, 'bureau', 1, 'month', 50000, null, 0),
          (${ANCIENNE}, 'bureau', 1, 'month', 40000, null, 0)`)
      await tx.execute(sql`
        insert into offer_items (offer_id, service_id, quantity, unit, position) values
          (${PREMIUM}, ${SCAN}, 10, 'unit', 1)`)
    })
  })

  after(async () => {
    await owner.client`update tenants set email = ${centreEmail} where id = ${DEFAULT_TENANT_ID}`
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  it('ne montre que les offres présentées dans l’espace, chiffrées par le moteur de la vague 2', async () => {
    const offres = await listPortalOffers(durand, '2026-10-02')
    assert.deepEqual(
      offres.map((offre) => offre.id),
      [PREMIUM],
    )
    const [premium] = offres
    assert.equal(premium.commitmentMonths, 12)
    // 40 € HT par mois, TVA 20 % ; dix numérisations incluses.
    assert.equal(premium.quote.totalExclTaxCents, 4_000)
    assert.equal(premium.quote.totalInclTaxCents, 4_800)
    assert.equal(premium.quote.lines[0].commercialLabel, 'Adresse de domiciliation')
    assert.equal(premium.quote.lines[1].includedActs, 10)
    assert.equal(premium.quote.lines[1].extraActNetCents, 300)
  })

  it('refuse une offre qui n’est pas présentée, ou archivée', async () => {
    assert.deepEqual(await findPortalOffer(durand, PREMIUM), { id: PREMIUM, name: 'Domiciliation Premium' })
    assert.equal(await findPortalOffer(durand, INTERNE), undefined)
    assert.equal(await findPortalOffer(durand, ANCIENNE), undefined)
  })

  it('transmet la demande à l’accueil et la journalise, sans créer de contrat', async () => {
    await demander()
    const [ligne] = await journal()
    assert.equal(ligne.event, 'offer_requested')
    assert.equal(ligne.audience, 'centre')
    assert.equal(ligne.clientId, DURAND)
    assert.equal(ligne.relatedType, 'offer')
    assert.equal(ligne.relatedId, PREMIUM)
    assert.equal(ligne.status, 'not_configured')
    assert.deepEqual(ligne.recipients, ['accueil@centre.test'])
    assert.equal(ligne.subject, 'Offre demandée — Domiciliation Premium, Atelier Durand')
    const [{ total }] = await asTenant((tx) => tx.execute(sql`select count(*)::int as total from contracts`))
    assert.equal(total, 0)
  })

  it('retrouve une demande récente, pour ne pas l’envoyer deux fois', async () => {
    assert.equal(await recentOfferRequest(DURAND, PREMIUM), undefined)
    await demander()
    assert.ok(await recentOfferRequest(DURAND, PREMIUM))
    assert.equal(await recentOfferRequest(PETIT, PREMIUM), undefined)
  })

  it('la montre à traiter dans « Demandes » jusqu’à ce qu’un contrat en soit tiré pour ce client', async () => {
    await demander()
    const [demande] = await listOfferRequests()
    assert.equal(demande.clientName, 'Atelier Durand')
    assert.equal(demande.offerName, 'Domiciliation Premium')
    assert.equal(demande.contract, null)

    await asTenant((tx) =>
      tx.insert(contracts).values({
        clientId: DURAND,
        reference: 'CT-OFF-1',
        contractType: 'domiciliation',
        startsOn: '2026-11-01',
        amountCents: 4_000,
        offerId: PREMIUM,
      }),
    )
    const [traitee] = await listOfferRequests()
    assert.equal(traitee.contract?.reference, 'CT-OFF-1')
  })

  it('suit le modèle du centre : son texte, ou rien s’il est désactivé (journalisé)', async () => {
    await asTenant((tx) =>
      tx.execute(sql`
        insert into notification_templates (event, subject, body, active)
        values ('offer_requested', 'Nouvelle demande : {{offre}} pour {{client}}', 'Rappeler {{demandeur}}.', true)`),
    )
    await demander()
    await asTenant((tx) =>
      tx.execute(sql`update notification_templates set active = false where event = 'offer_requested'`),
    )
    await demander()
    const lignes = (await journal()).sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
    assert.equal(lignes[0].subject, 'Nouvelle demande : Domiciliation Premium pour Atelier Durand')
    assert.equal(lignes[1].status, 'skipped')
    assert.match(lignes[1].error ?? '', /^Modèle désactivé par le centre/)
    assert.deepEqual(lignes[1].recipients, [])
  })

  it('journalise sans destinataire un centre sans adresse : la demande reste dans « Demandes »', async () => {
    await owner.client`update tenants set email = null where id = ${DEFAULT_TENANT_ID}`
    await demander()
    const [ligne] = await journal()
    assert.equal(ligne.status, 'skipped')
    assert.match(ligne.error ?? '', /adresse de courriel/)
    assert.equal((await listOfferRequests()).length, 1)
  })
})
