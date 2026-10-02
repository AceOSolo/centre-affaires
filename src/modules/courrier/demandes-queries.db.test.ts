import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import {
  MailRequestError,
  announceMailActs,
  cancelMailRequest,
  cancelMailRequestForClient,
  completeForwardRequest,
  countPendingMailRequests,
  findMailForAccounts,
  listMailRequests,
  listRequestsForAccounts,
  listRequestsForMail,
  previousForwardAddresses,
  recordScanRequestDone,
  refuseMailRequest,
  requestForward,
  requestScan,
  searchMailForAccounts,
  startMailRequest,
  updateForwardShipping,
  type RequestOutcome,
} from './demandes-queries.ts'
import type { ForwardAddress } from './demandes-regles.ts'
import { listMailForAccounts, recordOpening, requestOpening, type StoredScan } from './queries.ts'

/**
 * Demandes de courrier par le code des écrans (R21, R24, ADR 037), sous le
 * rôle applicatif soumis à la RLS : l'espace client sous sa portée, le
 * back-office sous celle du centre.
 *
 * - le client dépose une numérisation ou une réexpédition, l'annule tant
 *   qu'elle n'est pas prise en charge, et la trace reste ;
 * - la boîte aux lettres se pagine et se filtre, sans jamais montrer le
 *   courrier d'une autre entreprise ;
 * - l'accueil traite la file : prise en charge, refus motivé, numérisation
 *   rattachée à sa demande, réexpédition en dernier, frais notés ensuite ;
 * - le prix annoncé suit la règle de la facture.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('demandes de courrier, par les écrans', { skip: raison }, () => {
  // Les requêtes du module ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const DURAND = '01a00000-0000-7000-8000-0000000e0c01'
  const PETIT = '01a00000-0000-7000-8000-0000000e0c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000e0d01'
  const PAUL = '01a00000-0000-7000-8000-0000000e0d02'
  const CAMILLE = '01a00000-0000-7000-8000-0000000e0e01'
  const SCAN = '01a00000-0000-7000-8000-0000000e0f01'
  const REEXP = '01a00000-0000-7000-8000-0000000e0f02'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]
  const petit: ClientAccount[] = [{ memberId: PAUL, clientId: PETIT, clientName: 'Boulangerie Petit' }]

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, app.db)

  const ADRESSE: ForwardAddress = {
    recipient: 'Jeanne Durand',
    line1: '12 rue des Lilas',
    line2: null,
    postalCode: '38000',
    city: 'Grenoble',
    country: 'FR',
  }

  /** Un pli de l'entreprise, fermé ou ouvert par l'accueil. */
  const pli = async (
    clientId = DURAND,
    { ouvert = false, kind = 'lettre', recu = '2026-09-01T08:00:00Z' } = {},
  ): Promise<string> => {
    const [row] = await asTenant((tx) =>
      tx.execute(sql`
        insert into mail_items (client_id, kind, sender, received_at, status, opened_at, opened_by)
        values (${clientId}, ${kind}, 'URSSAF', ${recu}, ${ouvert ? 'opened' : 'received'},
                ${ouvert ? sql`now()` : null}, ${ouvert ? CAMILLE : null})
        returning id`),
    )
    return row.id as string
  }

  const ok = (outcome: RequestOutcome): string => {
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.error)
    return outcome.requestId
  }

  const demande = async (id: string) => {
    const [row] = await asTenant((tx) => tx.execute(sql`select * from mail_requests where id = ${id}`))
    return row
  }

  /** Un contenu déjà déposé (le stockage n'est pas éprouvé ici). */
  const depose = (nom: string): StoredScan[] => [
    {
      side: 'content',
      key: `courrier/test/${nom}.pdf`,
      scan: { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), contentType: 'application/pdf' },
      encryptionKeyVersion: 1,
    },
  ]

  const refus = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      assert.ok(error instanceof MailRequestError, String(error))
      return error.message
    }
    assert.fail('la demande aurait dû être refusée')
  }

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table clients, services cascade`
    await owner.client`truncate table staff_members cascade`
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Boulangerie Petit', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand', 'u-jeanne'),
          (${PAUL}, ${PETIT}, 'paul@petit.fr', 'Paul Petit', 'u-paul')`)
      await tx.execute(sql`insert into staff_members (id, email, full_name) values (${CAMILLE}, 'camille@centre.fr', 'Camille')`)
    })
  })

  after(async () => {
    await owner.client`truncate table clients, services cascade`
    await owner.client`truncate table staff_members cascade`
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  describe('espace client', () => {
    it('dépose une numérisation seule sur un pli ouvert, et dit pourquoi ailleurs non', async () => {
      const ouvert = await pli(DURAND, { ouvert: true })
      const ferme = await pli(DURAND)
      const autre = await pli(PETIT, { ouvert: true })

      const id = ok(await requestScan(ouvert, durand, 'Les annexes aussi.'))
      const row = await demande(id)
      assert.equal(row.kind, 'scan')
      assert.equal(row.status, 'requested')
      assert.equal(row.requested_by_member_id, JEANNE)
      assert.equal(row.client_note, 'Les annexes aussi.')

      // La base dit pourquoi, en français : affiché tel quel.
      const surFerme = await requestScan(ferme, durand, null)
      assert.equal(surFerme.ok, false)
      assert.match(surFerme.ok ? '' : surFerme.error, /encore fermé/)
      const doublon = await requestScan(ouvert, durand, null)
      assert.match(doublon.ok ? '' : doublon.error, /déjà en cours/)
      // Le pli d'une autre entreprise n'existe pas pour elle.
      assert.deepEqual(await requestScan(autre, durand, null), {
        ok: false,
        error: 'Ce courrier est introuvable dans votre espace.',
      })
    })

    it('dépose une réexpédition à l’adresse figée, puis la propose sans doublon', async () => {
      const premier = await pli(DURAND)
      const second = await pli(DURAND, { ouvert: true })
      const troisieme = await pli(DURAND)

      const id = ok(await requestForward(premier, durand, ADRESSE, 'En lettre suivie.'))
      const row = await demande(id)
      assert.deepEqual(
        [row.forward_recipient, row.forward_address_line1, row.forward_address_line2, row.forward_postal_code, row.forward_city, row.forward_country],
        ['Jeanne Durand', '12 rue des Lilas', null, '38000', 'Grenoble', 'FR'],
      )
      ok(await requestForward(second, durand, { ...ADRESSE, recipient: 'JEANNE DURAND' }, null))
      ok(await requestForward(troisieme, durand, { ...ADRESSE, line1: '3 avenue Alsace-Lorraine' }, null))

      const proposees = await previousForwardAddresses(durand, DURAND)
      assert.deepEqual(
        proposees.map((option) => option.address.line1),
        ['3 avenue Alsace-Lorraine', '12 rue des Lilas'],
      )
      // Celles d'une autre entreprise ne sont jamais proposées.
      assert.deepEqual(await previousForwardAddresses(durand, PETIT), [])
      assert.deepEqual(await previousForwardAddresses(petit, PETIT), [])
    })

    it('annule une demande pas encore prise en charge, à son nom : la trace reste', async () => {
      const ouvert = await pli(DURAND, { ouvert: true })
      const id = ok(await requestScan(ouvert, durand, null))

      assert.deepEqual(await cancelMailRequest(id, petit), {
        ok: false,
        error: 'Cette demande est introuvable dans votre espace.',
      })
      assert.deepEqual(await cancelMailRequest(id, durand), { ok: true, requestId: id })
      const row = await demande(id)
      assert.equal(row.status, 'cancelled')
      assert.equal(row.cancelled_by_member_id, JEANNE)
      assert.ok(row.cancelled_at)

      const { rows } = await listRequestsForAccounts(durand, { statuses: ['cancelled'] }, { number: 1, size: 10 })
      assert.deepEqual(
        rows.map((request) => [request.id, request.cancelledByName]),
        [[id, 'Jeanne Durand']],
      )

      // Prise en charge par l'accueil : le client ne l'annule plus.
      const suivante = ok(await requestScan(ouvert, durand, null))
      await startMailRequest(suivante, CAMILLE)
      const refusee = await cancelMailRequest(suivante, durand)
      assert.match(refusee.ok ? '' : refusee.error, /déjà prise en charge/)
    })

    it('pagine et filtre la boîte aux lettres : type, période, état', async () => {
      const lettre = await pli(DURAND, { kind: 'lettre', recu: '2026-09-01T08:00:00Z' })
      const colis = await pli(DURAND, { kind: 'colis', recu: '2026-09-15T08:00:00Z', ouvert: true })
      const recommande = await pli(DURAND, { kind: 'recommande', recu: '2026-09-20T08:00:00Z' })
      await pli(PETIT, { recu: '2026-09-25T08:00:00Z' })
      const reexp = ok(await requestForward(recommande, durand, ADRESSE, null))
      await completeForwardRequest(reexp, CAMILLE, { trackingNumber: null, postageCents: null })
      ok(await requestScan(colis, durand, null))

      const page = (number: number) => ({ number, size: 2 })
      const premiere = await searchMailForAccounts(durand, {}, page(1), 'Europe/Paris')
      assert.equal(premiere.total, 3)
      assert.deepEqual(premiere.rows.map((row) => row.id), [recommande, colis])
      assert.deepEqual((await searchMailForAccounts(durand, {}, page(2), 'Europe/Paris')).rows.map((row) => row.id), [lettre])

      const filtre = (filters: Parameters<typeof searchMailForAccounts>[1]) =>
        searchMailForAccounts(durand, filters, page(1), 'Europe/Paris').then((result) => result.rows.map((row) => row.id))
      assert.deepEqual(await filtre({ kind: 'colis' }), [colis])
      assert.deepEqual(await filtre({ from: '2026-09-10', to: '2026-09-15' }), [colis])
      assert.deepEqual(await filtre({ state: 'reexpedie' }), [recommande])
      assert.deepEqual(await filtre({ state: 'non-ouvert' }), [lettre])
      assert.deepEqual(await filtre({ state: 'numerise' }), [colis])
      assert.deepEqual(await filtre({ state: 'demande-en-cours' }), [colis])

      const [reexpedie, ouvert] = premiere.rows
      assert.ok(reexpedie.forwardedAt instanceof Date)
      assert.deepEqual(ouvert.pendingKinds, ['scan'])
      assert.equal(ouvert.pendingRequests[0].status, 'requested')
    })

    it('montre un pli, ses numérisations et ses demandes ; jamais celui d’une autre entreprise', async () => {
      const ouvert = await pli(DURAND, { ouvert: true })
      const autre = await pli(PETIT)
      const id = ok(await requestScan(ouvert, durand, null))
      await recordScanRequestDone(id, CAMILLE, depose('detail'))

      const detail = await findMailForAccounts(ouvert, durand)
      assert.ok(detail)
      assert.deepEqual(detail.requests.map((request) => [request.kind, request.status]), [['scan', 'done']])
      assert.equal(detail.scans.length, 1)
      assert.equal(detail.scans[0].mailRequestId, id)
      assert.equal(detail.requests[0].contentScanId, detail.scans[0].id)
      assert.equal(await findMailForAccounts(autre, durand), undefined)
    })
  })

  describe('back-office', () => {
    it('lit la file dans l’ordre d’arrivée, par nature, et compte ce qui reste à traiter', async () => {
      const ouvert = await pli(DURAND, { ouvert: true })
      const ferme = await pli(PETIT)
      const scan = ok(await requestScan(ouvert, durand, null))
      const ouverture = await requestOpening(ferme, petit)
      assert.equal(ouverture, true)
      const forward = ok(await requestForward(ouvert, durand, ADRESSE, null))
      await refuseMailRequest(forward, CAMILLE, 'Adresse hors zone desservie.')

      const file = await listMailRequests({ statuses: ['requested', 'in_progress'] }, { number: 1, size: 10 })
      assert.equal(file.total, 2)
      assert.deepEqual(file.rows.map((row) => row.kind), ['scan', 'open_and_scan'])
      assert.equal(file.rows[0].id, scan)
      const scans = await listMailRequests({ statuses: ['requested', 'in_progress'], kind: 'scan' }, { number: 1, size: 10 })
      assert.deepEqual(scans.rows.map((row) => row.id), [scan])
      const durandSeul = await listMailRequests({ statuses: ['refused'], clientId: DURAND }, { number: 1, size: 10 })
      assert.deepEqual(durandSeul.rows.map((row) => [row.id, row.refusalReason, row.refusedByName]), [
        [forward, 'Adresse hors zone desservie.', 'Camille'],
      ])

      assert.deepEqual(await countPendingMailRequests(), { open_and_scan: 1, scan: 1, forward: 0, total: 2 })
    })

    it('prend en charge puis refuse avec un motif ; une transition rejouée est refusée', async () => {
      const ouvert = await pli(DURAND, { ouvert: true })
      const id = ok(await requestScan(ouvert, durand, null))

      await startMailRequest(id, CAMILLE)
      assert.match(await refus(() => startMailRequest(id, CAMILLE)), /changé d’état/)
      await refuseMailRequest(id, CAMILLE, 'Pli détruit à la demande du client.')
      const row = await demande(id)
      assert.equal(row.status, 'refused')
      assert.equal(row.started_by_staff_id, CAMILLE)
      assert.equal(row.refused_by_staff_id, CAMILLE)
      assert.ok(row.started_at && row.refused_at)
      assert.match(await refus(() => refuseMailRequest(id, CAMILLE, 'Encore.')), /changé d’état/)
    })

    it('annule à la demande du client, au nom de l’accueil', async () => {
      const id = ok(await requestScan(await pli(DURAND, { ouvert: true }), durand, null))
      await cancelMailRequestForClient(id, CAMILLE)
      const row = await demande(id)
      assert.deepEqual([row.status, row.cancelled_by_staff_id, row.cancelled_by_member_id], ['cancelled', CAMILLE, null])
      const [staffRow] = await listRequestsForMail(row.mail_item_id as string)
      assert.equal(staffRow.cancelledByName, 'Camille')
    })

    it('rattache la numérisation déposée à sa demande, qui est faite', async () => {
      const ouvert = await pli(DURAND, { ouvert: true })
      const id = ok(await requestScan(ouvert, durand, null))
      const { mailItemId } = await recordScanRequestDone(id, CAMILLE, depose('nouvelle'))
      assert.equal(mailItemId, ouvert)

      const row = await demande(id)
      assert.deepEqual([row.status, row.completed_by_staff_id], ['done', CAMILLE])
      const [scan] = await asTenant((tx) =>
        tx.execute(sql`select id, side, mail_request_id from mail_scans where mail_item_id = ${ouvert}`),
      )
      assert.deepEqual([scan.side, scan.mail_request_id], ['content', id])
      // L'espace client montre le contenu le plus récent.
      const [carte] = await listMailForAccounts(durand)
      assert.equal(carte.contentScanId, scan.id)
      // Une seconde fois, la demande est close : rien n'est écrit.
      assert.match(await refus(() => recordScanRequestDone(id, CAMILLE, depose('encore'))), /changé d’état/)
    })

    it('clôt la demande d’ouverture en ouvrant le pli, et lui rattache le contenu', async () => {
      const demande1 = await pli(DURAND)
      assert.equal(await requestOpening(demande1, durand), true)
      const { mailRequestId } = await recordOpening(demande1, CAMILLE, depose('ouverture'))
      assert.ok(mailRequestId)
      const row = await demande(mailRequestId)
      assert.deepEqual([row.status, row.completed_by_staff_id], ['done', CAMILLE])
      const [scan] = await asTenant((tx) =>
        tx.execute(sql`select mail_request_id from mail_scans where mail_item_id = ${demande1}`),
      )
      assert.equal(scan.mail_request_id, mailRequestId)

      // Ouverture d'office, sans demande : contenu sans demande.
      const office = await pli(DURAND)
      assert.deepEqual(await recordOpening(office, CAMILLE, depose('office')), { mailRequestId: null })
    })

    it('réexpédie en dernier, note suivi et frais ensuite ; plus rien sur un pli parti', async () => {
      const ouvert = await pli(DURAND, { ouvert: true })
      const scan = ok(await requestScan(ouvert, durand, null))
      const forward = ok(await requestForward(ouvert, durand, ADRESSE, null))

      assert.match(
        await refus(() => completeForwardRequest(forward, CAMILLE, { trackingNumber: null, postageCents: null })),
        /D'autres demandes attendent/,
      )
      await recordScanRequestDone(scan, CAMILLE, depose('avant-depart'))
      await completeForwardRequest(forward, CAMILLE, { trackingNumber: '1A2345', postageCents: null })
      let row = await demande(forward)
      assert.deepEqual([row.status, row.forward_tracking_number, row.postage_cents], ['done', '1A2345', null])

      await updateForwardShipping(forward, { trackingNumber: '1A2345', postageCents: 435 })
      row = await demande(forward)
      assert.deepEqual([row.postage_cents, row.postage_currency], [435, 'EUR'])

      const apres = await requestScan(ouvert, durand, null)
      assert.match(apres.ok ? '' : apres.error, /réexpédié/)
      const [forwardRow] = (await listRequestsForMail(ouvert)).filter((request) => request.kind === 'forward')
      assert.equal(forwardRow.billed, false)
      assert.deepEqual(forwardRow.forwardAddress, ADRESSE)
    })
  })

  describe('prix annoncé avant la demande', () => {
    it('suit les inclus du forfait du mois, puis son prix ; aucun prix sans service', async () => {
      await asTenant(async (tx) => {
        await tx.execute(sql`
          insert into services (id, code, name, nature, unit, unit_price_cents) values
            (${SCAN}, 'courrier.numerisation', 'Numérisation', 'act', 'unit', 200),
            (${REEXP}, 'courrier.reexpedition', 'Réexpédition', 'act', 'unit', 500)`)
        await tx.execute(sql`
          insert into subscribed_services (client_id, service_id, quantity, unit, unit_price_cents,
                                           vat_rate_bp, included_quantity, starts_on)
          values (${DURAND}, ${SCAN}, 1, 'unit', 150, 2000, 1, '2026-01-01')`)
      })
      let annonces = await announceMailActs([...durand, ...petit], 'Europe/Paris')
      assert.deepEqual(annonces.get(DURAND)?.scan, { source: 'included', remainingAfter: 0 })
      assert.deepEqual(annonces.get(DURAND)?.forward, { source: 'catalogue', netCents: 500, currency: 'EUR' })
      assert.deepEqual(annonces.get(DURAND)?.open_and_scan, { source: 'unpriced' })
      assert.deepEqual(annonces.get(PETIT)?.scan, { source: 'catalogue', netCents: 200, currency: 'EUR' })

      // L'inclus du mois consommé, la suivante est au prix du forfait.
      const id = ok(await requestScan(await pli(DURAND, { ouvert: true }), durand, null))
      await recordScanRequestDone(id, CAMILLE, depose('inclus'))
      annonces = await announceMailActs(durand, 'Europe/Paris')
      assert.deepEqual(annonces.get(DURAND)?.scan, { source: 'subscription', netCents: 150, currency: 'EUR' })
    })
  })
})
