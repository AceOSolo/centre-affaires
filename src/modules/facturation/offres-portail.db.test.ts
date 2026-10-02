import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { PG_OFFER_REQUEST_REFUSED, pgErrorCode } from '../../db/errors.ts'
import { createDatabase, withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { loadAccountHistory } from '../clients/historique-compte-queries.ts'
import { settleOfferRequests } from '../contrats/demandes-offres.ts'
import { contracts } from '../contrats/schema.ts'
import { notificationDeliveries } from '../notifications/schema.ts'
import {
  dismissOfferRequest,
  findPortalOffer,
  listOfferRequests,
  listPortalOffers,
  openOfferRequest,
  requestOffer,
} from './offres-portail.ts'

/**
 * L'offre groupée dans l'espace client (R23, ADR 036), contre la base : le
 * client ne voit que les offres présentées, chiffrées par le moteur de la
 * vague 2 ; sa demande est une ligne de `offer_requests` (ADR 041), qu'il
 * retrouve dans son historique et que « Demandes » montre jusqu'à ce qu'un
 * contrat en soit tiré ou que l'accueil l'écarte ; l'accueil en est prévenu
 * (ADR 038). Aucun contrat n'est créé par le client.
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
  const ACCUEIL = '01a00000-0000-7000-8000-0000000f1e01'
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
    await owner.client`truncate table staff_members cascade`
    await owner.client`truncate table notification_deliveries, notification_templates`
    await owner.client`update tenants set email = 'accueil@centre.test' where id = ${DEFAULT_TENANT_ID}`
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, full_name) values (${ACCUEIL}, 'accueil@centre.test', 'Claire Accueil')`)
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

  it('inscrit la demande, prévient l’accueil et la journalise, sans créer de contrat', async () => {
    assert.equal((await demander()).status, 'created')
    const [demande] = await asTenant((tx) => tx.execute(sql`select * from offer_requests`))
    assert.equal(demande.client_id, DURAND)
    assert.equal(demande.offer_id, PREMIUM)
    assert.equal(demande.requested_by_member_id, JEANNE)
    assert.equal(demande.status, 'requested')

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

  it('ne garde qu’une demande à traiter par entreprise et par offre, sans prévenir deux fois', async () => {
    assert.equal(await openOfferRequest(durand, DURAND, PREMIUM), undefined)
    const premiere = await demander()
    const seconde = await demander()
    assert.equal(seconde.status, 'already')
    assert.equal(seconde.requestedAt.getTime(), premiere.requestedAt.getTime())
    assert.ok(await openOfferRequest(durand, DURAND, PREMIUM))
    assert.equal((await listOfferRequests()).length, 1)
    assert.equal((await journal()).length, 1)
  })

  it('refuse en base une offre qui n’est pas présentée, et tout dépôt pour une autre entreprise', async () => {
    const deposer = (clientId: string, offerId: string, scope = [DURAND]) =>
      withClientScope(
        DEFAULT_TENANT_ID,
        scope,
        (tx) =>
          tx.execute(sql`
            insert into offer_requests (client_id, offer_id, requested_by_member_id)
            values (${clientId}, ${offerId}, ${JEANNE})`),
        app.db,
      )
    const code = async (run: () => Promise<unknown>) => {
      try {
        await run()
      } catch (error) {
        return pgErrorCode(error)
      }
      return undefined
    }
    assert.equal(await code(() => deposer(DURAND, INTERNE)), PG_OFFER_REQUEST_REFUSED)
    assert.equal(await code(() => deposer(DURAND, ANCIENNE)), PG_OFFER_REQUEST_REFUSED)
    // Hors de la portée du compte : la RLS refuse l'écriture.
    assert.ok(await code(() => deposer(PETIT, PREMIUM)))
    // Le client ne traite pas sa demande, et personne ne la supprime.
    await demander()
    assert.equal(
      await code(() =>
        withClientScope(
          DEFAULT_TENANT_ID,
          [DURAND],
          (tx) => tx.execute(sql`update offer_requests set status = 'dismissed', closed_by_staff_id = ${ACCUEIL}`),
          app.db,
        ),
      ),
      PG_OFFER_REQUEST_REFUSED,
    )
    assert.ok(await code(() => asTenant((tx) => tx.execute(sql`delete from offer_requests`))))
    // Une autre entreprise ne la voit pas.
    const vues = await withClientScope(
      DEFAULT_TENANT_ID,
      [PETIT],
      (tx) => tx.execute(sql`select id from offer_requests`),
      app.db,
    )
    assert.equal(vues.length, 0)
  })

  it('la montre à traiter dans « Demandes » jusqu’à ce qu’un contrat en soit tiré pour ce client', async () => {
    await demander()
    const [demande] = await listOfferRequests()
    assert.equal(demande.clientName, 'Atelier Durand')
    assert.equal(demande.offerName, 'Domiciliation Premium')
    assert.equal(demande.requestedByName, 'Jeanne Martin')
    assert.equal(demande.status, 'requested')
    assert.equal(demande.contract, null)

    // Un contrat tiré d'une autre offre, ou pour un autre client, ne la clôt pas.
    await asTenant(async (tx) => {
      const [autre] = await tx
        .insert(contracts)
        .values({ clientId: PETIT, reference: 'CT-OFF-0', contractType: 'domiciliation', startsOn: '2026-11-01', amountCents: 4_000, offerId: PREMIUM })
        .returning({ id: contracts.id, clientId: contracts.clientId })
      await settleOfferRequests(tx, { id: autre.id, clientId: autre.clientId, offerId: PREMIUM }, ACCUEIL)
    })
    assert.equal((await listOfferRequests())[0].status, 'requested')

    await asTenant(async (tx) => {
      const [contrat] = await tx
        .insert(contracts)
        .values({ clientId: DURAND, reference: 'CT-OFF-1', contractType: 'domiciliation', startsOn: '2026-11-01', amountCents: 4_000, offerId: PREMIUM })
        .returning({ id: contracts.id, clientId: contracts.clientId })
      await settleOfferRequests(tx, { id: contrat.id, clientId: contrat.clientId, offerId: PREMIUM }, ACCUEIL)
    })
    const [traitee] = await listOfferRequests()
    assert.equal(traitee.status, 'contracted')
    assert.equal(traitee.contract?.reference, 'CT-OFF-1')
    assert.equal(traitee.closedByName, 'Claire Accueil')
    assert.ok(traitee.closedAt)
    // Traitée : l'entreprise peut en déposer une nouvelle.
    assert.equal((await demander()).status, 'created')
  })

  it('écarte une demande avec son motif, que le client lit dans son historique', async () => {
    await demander()
    const [demande] = await listOfferRequests()
    assert.equal(await dismissOfferRequest(demande.id, ACCUEIL, '  Offre réservée aux bureaux.  '), true)
    // Une seconde fois : déjà traitée.
    assert.equal(await dismissOfferRequest(demande.id, ACCUEIL, null), false)
    const [ecartee] = await listOfferRequests()
    assert.equal(ecartee.status, 'dismissed')
    assert.equal(ecartee.dismissalReason, 'Offre réservée aux bureaux.')
    assert.equal(ecartee.closedByName, 'Claire Accueil')

    const { sources } = await loadAccountHistory(durand, {
      year: new Date().getUTCFullYear(),
      timeZone: 'Europe/Paris',
      category: 'contrats',
    })
    assert.equal(sources.offerRequests.length, 1)
    const [historique] = sources.offerRequests
    assert.equal(historique.offerName, 'Domiciliation Premium')
    assert.equal(historique.status, 'dismissed')
    assert.equal(historique.requestedByName, 'Jeanne Martin')
    assert.equal(historique.dismissalReason, 'Offre réservée aux bureaux.')
    assert.ok(historique.closedAt)
  })

  it('retient l’anonymisation tant qu’une demande attend, et efface le motif avec la fiche', async () => {
    await demander()
    const bloquants = async () => {
      const [row] = await asTenant((tx) =>
        tx.execute(sql`select client_anonymization_blockers(${DURAND}::uuid) as raisons`),
      )
      return row.raisons as string[]
    }
    assert.deepEqual(await bloquants(), ["Demande d'offre à traiter."])
    const [demande] = await listOfferRequests()
    await dismissOfferRequest(demande.id, ACCUEIL, 'Rappeler M. Durand en janvier.')
    assert.deepEqual(await bloquants(), [])
    await asTenant((tx) =>
      tx.execute(sql`select anonymize_client(${DURAND}::uuid, ${ACCUEIL}::uuid, 'relationship_ended', null)`),
    )
    const [reste] = await asTenant((tx) => tx.execute(sql`select status, dismissal_reason from offer_requests`))
    assert.deepEqual({ ...reste }, { status: 'dismissed', dismissal_reason: null })
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
    // La première écartée, l'entreprise redemande l'offre : un second message.
    const [premiere] = await listOfferRequests()
    await dismissOfferRequest(premiere.id, ACCUEIL, null)
    await demander()
    const lignes = (await journal()).sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
    assert.equal(lignes[0].subject, 'Nouvelle demande : Domiciliation Premium pour Atelier Durand')
    assert.equal(lignes[1].status, 'skipped')
    assert.match(lignes[1].error ?? '', /^Modèle désactivé par le centre/)
    assert.deepEqual(lignes[1].recipients, [])
  })

  it('garde dans « Demandes » la demande d’un centre sans adresse, journalisée sans destinataire', async () => {
    await owner.client`update tenants set email = null where id = ${DEFAULT_TENANT_ID}`
    assert.equal((await demander()).status, 'created')
    const [ligne] = await journal()
    assert.equal(ligne.status, 'skipped')
    assert.match(ligne.error ?? '', /adresse de courriel/)
    assert.equal((await listOfferRequests()).length, 1)
  })
})
