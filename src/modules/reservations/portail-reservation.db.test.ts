import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { addDaysToIsoDate, todayIsoDate, wallClockToUtc } from '../../lib/dates.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { contracts } from '../contrats/schema.ts'
import { frozenQuoteDisplay } from '../facturation/devis.ts'
import { notifyBookingRequestSubmitted } from '../notifications/declencheurs-reservations.ts'
import { notificationDeliveries } from '../notifications/schema.ts'
import { createResource, updateClientBookingMode } from '../ressources/queries.ts'
import { defaultClientBookingMode } from '../ressources/reservation-client.ts'
import { cancelRequestForAccounts, listBookingsForAccounts } from './compte-queries.ts'
import { findBookingAuthors, listPendingRequests } from './demandes-queries.ts'
import {
  PortalBookingError,
  createPortalBooking,
  listPortalDayAvailability,
  previewPortalQuote,
} from './portail-queries.ts'
import { cancelBooking, refuseBooking } from './queries.ts'
import { bookings } from './schema.ts'

/**
 * Réservation depuis l'espace client (R23, ADR 016 décision D4, ADR 036), de
 * la disponibilité à l'écriture, par les fonctions que le portail appelle,
 * sous le rôle applicatif et la portée client :
 *
 * - les ressources ouvertes au portail et leurs plages libres, sans rien
 *   révéler des réservations des autres ;
 * - le montant du contrat du client, annoncé puis figé à l'écriture ;
 * - le statut posé selon le réglage de la ressource : confirmée d'emblée, ou
 *   demande à l'accueil ;
 * - l'annulation par le client, et par l'équipe, tracées.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('réservation depuis l’espace client, de la disponibilité à l’écriture', { skip: raison }, () => {
  // Les requêtes ouvrent leur propre connexion, par APP_DATABASE_URL. Aucun
  // courriel ne part : SMTP non configuré.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl
  delete process.env.SMTP_HOST

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const SALLE = '01a00000-0000-7000-8000-0000000f0a01'
  const VEHICULE = '01a00000-0000-7000-8000-0000000f0a02'
  const CASIER = '01a00000-0000-7000-8000-0000000f0a03'
  const BUREAU = '01a00000-0000-7000-8000-0000000f0a04'
  const DURAND = '01a00000-0000-7000-8000-0000000f0c01'
  const PETIT = '01a00000-0000-7000-8000-0000000f0c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000f0d01'
  const PAUL = '01a00000-0000-7000-8000-0000000f0d02'
  const ACCUEIL = '01a00000-0000-7000-8000-0000000f0e01'
  const PUBLIQUE = '01a00000-0000-7000-8000-0000000f0b01'
  const RESIDENTS = '01a00000-0000-7000-8000-0000000f0b02'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]
  const petit: ClientAccount[] = [{ memberId: PAUL, clientId: PETIT, clientName: 'Boulangerie Petit' }]

  const TZ = 'Europe/Paris'
  /** Un mardi à venir, dans l'horizon du centre. */
  const jour = (() => {
    let day = addDaysToIsoDate(todayIsoDate(TZ), 7)
    while (new Date(`${day}T12:00:00Z`).getUTCDay() !== 2) day = addDaysToIsoDate(day, 1)
    return day
  })()
  const creneau = (debut: string, fin: string) => ({
    startsAt: wallClockToUtc(`${jour}T${debut}`, TZ),
    endsAt: wallClockToUtc(`${jour}T${fin}`, TZ),
  })

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  const reserver = (
    accounts: ClientAccount[],
    resourceId: string,
    debut = '09:00',
    fin = '11:00',
    account: ClientAccount = accounts[0],
  ) =>
    createPortalBooking({
      account,
      accounts,
      resourceId,
      ...creneau(debut, fin),
      title: 'Réunion',
      notes: null,
    })

  const ligne = async (id: string) => {
    const [row] = await asTenant((tx) => tx.select().from(bookings).where(eq(bookings.id, id)))
    return row
  }

  const refus = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      if (error instanceof PortalBookingError) return error
      throw error
    }
    return undefined
  }

  let centreEmail: string | null = null

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
    const [tenant] = await owner.client`select email from tenants where id = ${DEFAULT_TENANT_ID}`
    centreEmail = tenant.email
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, opening_hours, closures cascade`
    await owner.client`truncate table staff_members cascade`
    // Les messages au centre sans client, et les modèles, ne suivent pas les clients.
    await owner.client`truncate table notification_deliveries, notification_templates`
    await owner.client`update tenants set email = 'accueil@centre.test' where id = ${DEFAULT_TENANT_ID}`
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name, client_booking_mode) values
          (${SALLE}, 'salle', 'S-PRT', 'Salle Europe', 'approval'),
          (${VEHICULE}, 'vehicule', 'V-PRT', 'Utilitaire', 'instant'),
          (${CASIER}, 'casier', 'C-PRT', 'Casier 12', 'closed'),
          (${BUREAU}, 'bureau', 'B-PRT', 'Bureau 3', 'instant')`)
      // Le centre ouvre de 7 h à 21 h, tous les jours.
      await tx.execute(sql`
        insert into opening_hours (weekday, opens_at, closes_at)
        select day, '07:00', '21:00' from generate_series(1, 7) as day`)
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Boulangerie Petit', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.test', 'Jeanne Martin', 'u-jeanne'),
          (${PAUL}, ${PETIT}, 'paul@petit.test', null, 'u-paul')`)
      await tx.execute(sql`insert into staff_members (id, email) values (${ACCUEIL}, 'accueil@centre.test')`)
      // Grille du centre ; grille des résidents, moins chère, portée par le contrat de Durand.
      // Le bureau n'a pas de prix à l'heure : réservé, il n'est pas chiffré.
      await tx.execute(sql`
        insert into rate_plans (id, name, is_default) values
          (${PUBLIQUE}, 'Tarifs publics', true), (${RESIDENTS}, 'Tarifs résidents', false)`)
      await tx.execute(sql`
        insert into rate_plan_items (rate_plan_id, resource_type, unit, amount_cents) values
          (${PUBLIQUE}, 'salle', 'hour', 2500),
          (${PUBLIQUE}, 'vehicule', 'hour', 3000),
          (${RESIDENTS}, 'salle', 'hour', 2000)`)
      const [contract] = await tx
        .insert(contracts)
        .values({
          clientId: DURAND,
          reference: 'CT-PRT-1',
          contractType: 'domiciliation',
          startsOn: '2026-01-01',
          amountCents: 3_000,
          ratePlanId: RESIDENTS,
        })
        .returning({ id: contracts.id })
      await tx.update(contracts).set({ status: 'active' }).where(eq(contracts.id, contract.id))
    })
  })

  after(async () => {
    await owner.client`update tenants set email = ${centreEmail} where id = ${DEFAULT_TENANT_ID}`
    // Le pool ouvert par les requêtes du module, sans quoi le processus ne finit pas.
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  describe('disponibilités et montant', () => {
    it('propose les ressources ouvertes au portail, pas celles fermées', async () => {
      const day = await listPortalDayAvailability(durand, jour, TZ)
      assert.deepEqual(
        day.map(({ resource }) => resource.id).sort(),
        [SALLE, VEHICULE, BUREAU].sort(),
      )
      const salle = day.find(({ resource }) => resource.id === SALLE)
      assert.equal(salle?.closed, false)
      assert.equal(salle?.freeMinutes, 14 * 60)
    })

    it('retire le créneau d’un autre client des plages libres, sans rien en révéler', async () => {
      await reserver(petit, SALLE, '10:00', '12:00')
      const salle = (await listPortalDayAvailability(durand, jour, TZ)).find(
        ({ resource }) => resource.id === SALLE,
      )
      assert.equal(salle?.freeMinutes, 12 * 60)
      assert.deepEqual(
        salle?.free.map((range) => [range.startsAt.toISOString(), range.endsAt.toISOString()]),
        [
          [creneau('07:00', '10:00').startsAt.toISOString(), creneau('07:00', '10:00').endsAt.toISOString()],
          [creneau('12:00', '21:00').startsAt.toISOString(), creneau('12:00', '21:00').endsAt.toISOString()],
        ],
      )
      // La réservation de Petit n'est pas dans l'espace de Durand.
      assert.equal((await listBookingsForAccounts(durand)).length, 0)
    })

    it('annonce le tarif du contrat du client, ou celui du centre', async () => {
      const deDurand = await previewPortalQuote(durand, { clientId: DURAND, resourceId: SALLE, ...creneau('09:00', '11:00') })
      assert.equal(deDurand?.mode, 'approval')
      assert.equal(deDurand?.quote?.unitPriceCents, 2_000)
      assert.equal(deDurand?.fromContract, true)
      const dePetit = await previewPortalQuote(petit, { clientId: PETIT, resourceId: SALLE, ...creneau('09:00', '11:00') })
      assert.equal(dePetit?.quote?.unitPriceCents, 2_500)
      assert.equal(dePetit?.fromContract, false)
      const nonChiffre = await previewPortalQuote(durand, { clientId: DURAND, resourceId: BUREAU, ...creneau('09:00', '11:00') })
      assert.equal(nonChiffre?.quote, null)
    })

    it('ne chiffre ni une ressource fermée au portail, ni pour une entreprise hors du compte', async () => {
      assert.equal(
        await previewPortalQuote(durand, { clientId: DURAND, resourceId: CASIER, ...creneau('09:00', '11:00') }),
        undefined,
      )
      assert.equal(
        await previewPortalQuote(durand, { clientId: PETIT, resourceId: SALLE, ...creneau('09:00', '11:00') }),
        undefined,
      )
    })
  })

  describe('écriture selon le réglage de la ressource', () => {
    it('met en attente de l’accueil une ressource soumise à son accord, devis du contrat figé', async () => {
      const created = await reserver(durand, SALLE)
      assert.equal(created.status, 'pending')
      assert.equal(created.quote?.unitPriceCents, 2_000)
      assert.equal(created.quote?.quantity, 2)
      const row = await ligne(created.id)
      assert.equal(row.status, 'pending')
      assert.equal(row.channel, 'client')
      assert.equal(row.kind, 'booking')
      assert.equal(row.bookedByMemberId, JEANNE)
      assert.equal(row.clientId, DURAND)
      assert.ok(row.quotedAt)
      assert.equal(row.quoteAmountCents, 4_000)
    })

    it('confirme d’emblée une ressource à confirmation immédiate chiffrée', async () => {
      const created = await reserver(durand, VEHICULE)
      assert.equal(created.status, 'confirmed')
      // 2 h × 30 € HT, TVA à 20 %.
      assert.equal(created.quote?.totalCents, 7_200)
      assert.equal((await ligne(created.id)).status, 'confirmed')
    })

    it('laisse en attente une confirmation immédiate que la grille ne chiffre pas', async () => {
      const created = await reserver(durand, BUREAU)
      assert.equal(created.status, 'pending')
      assert.equal(created.quote, undefined)
      assert.equal((await ligne(created.id)).quotedAt, null)
    })

    it('suit le réglage changé par l’équipe, dès la réservation suivante', async () => {
      assert.equal(await updateClientBookingMode(SALLE, 'instant'), true)
      assert.equal((await reserver(durand, SALLE)).status, 'confirmed')
      assert.equal(await updateClientBookingMode(SALLE, 'closed'), true)
      const day = await listPortalDayAvailability(durand, jour, TZ)
      assert.equal(day.some(({ resource }) => resource.id === SALLE), false)
      await asTenant((tx) => tx.execute(sql`update resources set deleted_at = now() where id = ${VEHICULE}`))
      assert.equal(await updateClientBookingMode(VEHICULE, 'approval'), false)
    })

    it('crée une ressource au réglage proposé par l’écran : fermée pour un casier, accord de l’accueil sinon', async () => {
      const casier = await createResource({
        resourceType: 'casier',
        code: 'C-NEUF',
        name: 'Casier 40',
        attributes: { numero: '40' },
        clientBookingMode: defaultClientBookingMode('casier'),
      })
      assert.equal(casier.clientBookingMode, 'closed')
      const salle = await createResource({ resourceType: 'salle', code: 'S-NEUVE', name: 'Salle neuve' })
      assert.equal(salle.clientBookingMode, 'approval')
    })

    it('fige le devis : un nouveau prix de la grille ne change pas la réservation', async () => {
      const created = await reserver(durand, SALLE)
      await asTenant(async (tx) => {
        await tx.execute(sql`update rate_plan_items set deleted_at = now() where rate_plan_id = ${RESIDENTS}`)
        await tx.execute(sql`
          insert into rate_plan_items (rate_plan_id, resource_type, unit, amount_cents)
          values (${RESIDENTS}, 'salle', 'hour', 5000)`)
      })
      const apres = await previewPortalQuote(durand, { clientId: DURAND, resourceId: SALLE, ...creneau('14:00', '16:00') })
      assert.equal(apres?.quote?.unitPriceCents, 5_000)
      assert.equal(frozenQuoteDisplay(await ligne(created.id))?.unitPriceCents, 2_000)
    })

    it('refuse une ressource fermée au portail, avec le message de la base', async () => {
      const error = await refus(() => reserver(durand, CASIER))
      assert.equal(error?.reason, 'refus')
      assert.match(error?.message ?? '', /Casier 12/)
    })

    it('refuse un créneau déjà pris, fût-ce par une autre entreprise', async () => {
      await reserver(petit, SALLE, '10:00', '12:00')
      const error = await refus(() => reserver(durand, SALLE, '11:00', '13:00'))
      assert.equal(error?.reason, 'conflit')
    })

    it('refuse une personne qui n’est pas de l’entreprise', async () => {
      const usurpe: ClientAccount = { memberId: PAUL, clientId: DURAND, clientName: 'Atelier Durand' }
      const error = await refus(() => reserver([usurpe], SALLE, '09:00', '11:00', usurpe))
      assert.equal(error?.reason, 'acces')
    })
  })

  describe('suivi et annulation, tracés', () => {
    it('annule une demande en attente au nom de la personne, et le montre dans « Mes réservations »', async () => {
      const created = await reserver(durand, SALLE)
      assert.equal(await cancelRequestForAccounts(created.id, durand), true)
      const row = await ligne(created.id)
      assert.equal(row.status, 'cancelled')
      assert.equal(row.cancelledByMemberId, JEANNE)
      const [vue] = await listBookingsForAccounts(durand)
      assert.equal(vue.bookedBy, 'Jeanne Martin')
      assert.equal(vue.cancelledByMember, 'Jeanne Martin')
      assert.equal(vue.cancelledByCentre, false)
      assert.equal(frozenQuoteDisplay(vue)?.unitPriceCents, 2_000)
    })

    it('n’annule pas depuis l’espace une réservation confirmée : elle s’annule auprès du centre', async () => {
      const created = await reserver(durand, VEHICULE)
      assert.equal(await cancelRequestForAccounts(created.id, durand), false)
      assert.equal((await ligne(created.id)).status, 'confirmed')
    })

    it('trace l’annulation et le refus par l’équipe, dits « par le centre » au client', async () => {
      const confirmee = await reserver(durand, VEHICULE)
      await cancelBooking(confirmee.id, 'Véhicule au garage', ACCUEIL)
      const demande = await reserver(durand, SALLE)
      await refuseBooking(demande.id, null, ACCUEIL)
      assert.equal((await ligne(confirmee.id)).cancelledByStaffId, ACCUEIL)
      assert.equal((await ligne(demande.id)).cancelledByStaffId, ACCUEIL)
      const vues = await listBookingsForAccounts(durand)
      assert.ok(vues.every((vue) => vue.cancelledByCentre && vue.cancelledByMember === null))
      assert.deepEqual(await findBookingAuthors(demande.id), {
        bookedBy: 'Jeanne Martin',
        cancelledByMember: null,
        cancelledByStaff: 'accueil@centre.test',
      })
    })

    it('montre la demande dans « Demandes », avec son canal et la personne', async () => {
      const created = await reserver(petit, SALLE)
      const [demande] = await listPendingRequests()
      assert.equal(demande.id, created.id)
      assert.equal(demande.channel, 'client')
      assert.equal(demande.clientName, 'Boulangerie Petit')
      assert.deepEqual(demande.bookedBy, { name: null, email: 'paul@petit.test' })
    })

    it('prévient l’accueil d’une demande, et pas d’une réservation confirmée d’emblée', async () => {
      const demande = await reserver(durand, SALLE)
      const confirmee = await reserver(durand, VEHICULE)
      await notifyBookingRequestSubmitted(demande.id)
      await notifyBookingRequestSubmitted(confirmee.id)
      const journal = await asTenant((tx) => tx.select().from(notificationDeliveries))
      assert.equal(journal.length, 1)
      assert.equal(journal[0].event, 'booking_request_submitted')
      assert.equal(journal[0].audience, 'centre')
      assert.equal(journal[0].clientId, DURAND)
      assert.equal(journal[0].relatedType, 'booking')
      assert.equal(journal[0].relatedId, demande.id)
      // SMTP non configuré : rien n'est parti, l'adresse du centre est notée.
      assert.equal(journal[0].status, 'not_configured')
      assert.deepEqual(journal[0].recipients, ['accueil@centre.test'])
      assert.match(journal[0].subject, /^Demande de réservation — Salle Europe, /)
    })
  })
})
