import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql, type SQL } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { permissionsOf } from '../../lib/auth/permissions.ts'
import type { Message, SendResult } from '../../lib/courriel.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import {
  countUnreadStaffNotifications,
  markAllStaffNotificationsRead,
  markStaffNotificationRead,
  signalStaff,
  staffNotificationFeed,
  type StaffReader,
} from './cloche-queries.ts'
import { notifyOfferRequested } from './declencheurs-clients.ts'
import { notifyMailRequestSubmitted } from './declencheurs-courrier.ts'
import { notifyInspectionSigned } from './declencheurs-etats-des-lieux.ts'
import { notifyBookingRequestSubmitted, notifyDomiciliationRequestSubmitted } from './declencheurs-reservations.ts'

/**
 * Cloche de l'équipe (ADR 059), contre la base : chaque demande d'un client
 * y sonne une fois, au même endroit que le courriel au centre ; chaque membre
 * ne voit que ce que ses droits lui ouvrent, et la marque lue pour lui seul.
 */
describe('cloche de l’équipe', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const DURAND = '01a00000-0000-7000-8000-0000000c1c01'
  const JEANNE = '01a00000-0000-7000-8000-0000000c1d01'
  const CAMILLE = '01a00000-0000-7000-8000-0000000c1e01'
  const PAUL = '01a00000-0000-7000-8000-0000000c1e02'
  const SALLE = '01a00000-0000-7000-8000-0000000c1b01'
  const BUREAU = '01a00000-0000-7000-8000-0000000c1b02'
  const AUTRE_CENTRE = '01a00000-0000-7000-8000-0000000c1a01'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const send = async (message: Message): Promise<SendResult> => ({
    status: 'sent',
    recipients: message.to.map((to) => to.toLowerCase()),
    failed: [],
    error: null,
  })
  const options = {
    get database() {
      return bases.app.db
    },
    send,
  }
  const db = {
    get database() {
      return bases.app.db
    },
  }

  /** L'accueil : tous les droits de la cloche. */
  const camille: StaffReader = { id: CAMILLE, allowed: permissionsOf('staff') }
  const paul: StaffReader = { id: PAUL, allowed: permissionsOf('staff') }

  const lire = async (text: string, params: unknown[] = []) =>
    (await bases.owner.client.query(text, params))[0] as Record<string, unknown>[]

  const cloche = () =>
    lire('select kind, client_id, related_id, summary from staff_notifications order by created_at, id')

  const creer = async (ecrire: (tx: Transaction, id: string) => Promise<unknown>) => {
    const nouveau = uuidv7()
    await asTenant((tx) => ecrire(tx, nouveau))
    return nouveau
  }

  let heure = 6
  const reserver = (colonnes: SQL, valeurs: SQL) => {
    heure += 1
    const minuit = new Date()
    minuit.setUTCHours(0, 0, 0, 0)
    const debut = new Date(minuit.getTime() + (3 * 24 + heure) * 3_600_000)
    const fin = new Date(debut.getTime() + 3_600_000)
    return creer((tx, id) =>
      tx.execute(sql`
        insert into bookings (id, resource_id, title, starts_at, ends_at, ${colonnes})
        values (${id}, ${SALLE}, 'Réunion', ${debut}, ${fin}, ${valeurs})`),
    )
  }

  let numero = 0
  const devis = (colonnes: SQL, valeurs: SQL) => {
    numero += 1
    return creer((tx, id) =>
      tx.execute(sql`
        insert into proposals (id, number, ${colonnes}, answers)
        values (${id}, ${`DV-CLOCHE-${numero}`}, ${valeurs}, '{}')`),
    )
  }

  const tables = [
    'staff_notification_reads',
    'staff_notifications',
    'proposal_lines',
    'proposals',
    'bookings',
    'offer_requests',
    'offers',
    'mail_requests',
    'mail_items',
    'inspections',
    'inspection_template_versions',
    'inspection_templates',
    'contracts',
    'client_members',
    'clients',
    'resources',
    'staff_members',
    'notification_deliveries',
    'notification_templates',
  ]

  before(async () => {
    bases = await ouvrirBasesDeTest()
  })

  beforeEach(async () => {
    await viderTables(bases.owner, ...tables)
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into staff_members (id, email, full_name) values
          (${CAMILLE}, 'camille@centre.exemple', 'Camille'), (${PAUL}, 'paul@centre.exemple', 'Paul')`)
      await tx.execute(sql`insert into clients (id, name, status) values (${DURAND}, 'Atelier Durand', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name)
        values (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${SALLE}, 'salle', 'S-CLO', 'Salle Atlas'), (${BUREAU}, 'bureau', 'B-CLO', 'Bureau 12')`)
    })
  })

  after(async () => {
    await viderTables(bases.owner, ...tables)
    await lire('delete from tenants where id = ?', [AUTRE_CENTRE])
    await bases.fermer()
  })

  describe('chaque demande sonne, au même endroit que le courriel', () => {
    it('une demande de réservation de l’espace client, une seule fois même rejouée', async () => {
      const reservation = await reserver(
        sql`client_id, channel, booked_by_member_id`,
        sql`${DURAND}, 'client', ${JEANNE}`,
      )
      await notifyBookingRequestSubmitted(reservation, options)
      await notifyBookingRequestSubmitted(reservation, options)
      const lignes = await cloche()
      assert.equal(lignes.length, 1)
      assert.deepEqual([lignes[0].kind, lignes[0].client_id, lignes[0].related_id], ['booking_request', DURAND, reservation])
      assert.match(String(lignes[0].summary), /^Salle Atlas · \w+ \d+ \w+ \d{4}, de \d{2}:\d{2} à \d{2}:\d{2}$/)
    })

    it('une demande par produit de la page publique, avec son devis : « demande de devis »', async () => {
      const reservation = await reserver(
        sql`channel, status, requester_name, requester_email, requester_phone`,
        sql`'public', 'pending', 'Camille Rousseau', 'camille@exemple.fr', '0600000000'`,
      )
      await devis(
        sql`product, channel, booking_id, requester_name, requester_email`,
        sql`'espace', 'public', ${reservation}, 'Camille Rousseau', 'camille@exemple.fr'`,
      )
      await notifyBookingRequestSubmitted(reservation, options)
      const [ligne] = await cloche()
      assert.deepEqual([ligne.kind, ligne.client_id], ['quote_request', null])

      // Le demandeur se lit sur sa demande : le nom n'est pas recopié dans la cloche.
      assert.doesNotMatch(String(ligne.summary), /Rousseau/)
      const feed = await staffNotificationFeed(camille, db)
      assert.equal(feed.items[0].who, 'Camille Rousseau')
      assert.equal(feed.items[0].label, 'Demande de devis')
      assert.equal(feed.items[0].href, `/demandes#demande-${reservation}`)

      // Ses coordonnées anonymisées (ADR 020), la cloche ne le nomme plus.
      await lire('update bookings set requester_name = null where id = ?', [reservation])
      assert.equal((await staffNotificationFeed(camille, db)).items[0].who, 'Visiteur du site')
    })

    it('sonne même quand le modèle du courriel est désactivé', async () => {
      await asTenant((tx) =>
        tx.execute(sql`
          insert into notification_templates (event, subject, body, active)
          values ('booking_request_submitted', 'Objet', 'Texte', 0)`),
      )
      const reservation = await reserver(sql`client_id, channel, booked_by_member_id`, sql`${DURAND}, 'client', ${JEANNE}`)
      assert.equal((await notifyBookingRequestSubmitted(reservation, options))?.status, 'skipped')
      assert.equal((await cloche()).length, 1)
    })

    it('une demande de domiciliation, qui mène à son devis dans « Demandes »', async () => {
      const demande = await devis(
        sql`product, channel, requester_name, requester_email, requester_company`,
        sql`'domiciliation', 'public', 'Camille Rousseau', 'camille@exemple.fr', 'Rousseau Conseil'`,
      )
      await notifyDomiciliationRequestSubmitted(demande, options)
      const [ligne] = await cloche()
      assert.deepEqual([ligne.kind, ligne.summary], ['domiciliation_request', `Devis DV-CLOCHE-${numero}`])
      const [item] = (await staffNotificationFeed(camille, db)).items
      assert.equal(item.who, 'Rousseau Conseil')
      assert.equal(item.href, `/demandes#devis-${demande}`)
    })

    it('une demande de courrier du client, pas celle que l’accueil consigne lui-même', async () => {
      const pli = await creer((tx, id) =>
        tx.execute(sql`
          insert into mail_items (id, client_id, kind, sender, received_at)
          values (${id}, ${DURAND}, 'recommande', 'URSSAF', '2026-09-30 22:30:00.000')`),
      )
      const demande = await creer((tx, id) =>
        tx.execute(sql`
          insert into mail_requests (id, mail_item_id, client_id, kind, requested_by_member_id)
          values (${id}, ${pli}, ${DURAND}, 'open_and_scan', ${JEANNE})`),
      )
      await notifyMailRequestSubmitted(demande, options)
      const [ligne] = await cloche()
      assert.deepEqual([ligne.kind, ligne.client_id, ligne.related_id], ['mail_request', DURAND, demande])
      // Ni l'expéditeur, ni rien de ce que le pli contient.
      assert.equal(ligne.summary, 'Ouverture et numérisation · Recommandé du 1 oct. 2026 à 00:30')

      const parAccueil = await creer((tx, id) =>
        tx.execute(sql`
          insert into mail_requests (id, mail_item_id, client_id, kind, requested_by_staff_id,
            forward_recipient, forward_address_line1, forward_postal_code, forward_city, forward_country)
          values (${id}, ${pli}, ${DURAND}, 'forward', ${CAMILLE},
                  'Atelier Durand', '2 place du Marché', '38000', 'Grenoble', 'FR')`),
      )
      assert.equal(await notifyMailRequestSubmitted(parAccueil, options), null)
      assert.equal((await cloche()).length, 1)
    })

    it('une offre demandée : la ligne désigne la demande à traiter', async () => {
      const offre = await creer((tx, id) =>
        tx.execute(sql`insert into offers (id, name, client_visible) values (${id}, 'Domiciliation premium', 1)`),
      )
      const demande = await creer((tx, id) =>
        tx.execute(sql`
          insert into offer_requests (id, client_id, offer_id, requested_by_member_id)
          values (${id}, ${DURAND}, ${offre}, ${JEANNE})`),
      )
      await notifyOfferRequested({ offerId: offre, clientId: DURAND, memberId: JEANNE }, options)
      const [ligne] = await cloche()
      assert.deepEqual([ligne.kind, ligne.related_id, ligne.summary], ['offer_request', demande, 'Domiciliation premium'])
    })

    it('un état des lieux signé par le client, qui mène à sa fiche', async () => {
      const modele = uuidv7()
      const version = uuidv7()
      await asTenant(async (tx) => {
        await tx.execute(sql`insert into inspection_templates (id, resource_type, name) values (${modele}, 'bureau', 'Bureau')`)
        await tx.execute(sql`
          insert into inspection_template_versions (id, template_id, version, name, fields, created_by)
          values (${version}, ${modele}, 1, 'Bureau', '[{"id":"murs","label":"Murs","type":"condition","required":true}]', ${CAMILLE})`)
      })
      const contrat = await creer((tx, id) =>
        tx.execute(sql`
          insert into contracts (id, client_id, reference, contract_type, starts_on, amount_cents)
          values (${id}, ${DURAND}, 'CT-CLOCHE-1', 'bureau', '2026-11-01', 90000)`),
      )
      const etat = await creer((tx, id) =>
        tx.execute(sql`
          insert into inspections (id, kind, resource_id, client_id, contract_id, template_version_id, created_by,
                                   performed_at)
          values (${id}, 'exit', ${BUREAU}, ${DURAND}, ${contrat}, ${version}, ${CAMILLE}, '2026-10-02 08:00:00.000')`),
      )
      await asTenant((tx) =>
        tx.execute(sql`update inspections set status = 'closed', closed_by = ${CAMILLE}, \`values\` = '{"murs":"bon"}' where id = ${etat}`),
      )
      await asTenant((tx) => tx.execute(sql`update inspections set signed_by_member_id = ${JEANNE} where id = ${etat}`))
      await notifyInspectionSigned(etat, options)
      const [ligne] = await cloche()
      assert.deepEqual([ligne.kind, ligne.summary], ['inspection_signed', 'Sortie · Bureau 12'])
      assert.equal((await staffNotificationFeed(camille, db)).items[0].href, `/etats-des-lieux/${etat}`)
    })
  })

  describe('lu ou non lu, membre par membre', () => {
    const sonner = (kind: 'booking_request' | 'mail_request', resume = 'Salle Atlas') =>
      signalStaff({ kind, clientId: DURAND, relatedId: uuidv7(), summary: [resume] }, db)

    it('compte les non lues, et chaque membre lit pour lui seul', async () => {
      await sonner('booking_request')
      await sonner('mail_request')
      assert.equal(await countUnreadStaffNotifications(camille, db), 2)

      const feed = await staffNotificationFeed(camille, db)
      assert.equal(feed.unread, 2)
      assert.equal(feed.items.length, 2)
      assert.equal(feed.items[0].who, 'Atelier Durand')

      assert.equal(await markStaffNotificationRead(camille, feed.items[0].id, db), 1)
      assert.equal(await countUnreadStaffNotifications(camille, db), 1)
      // Paul n'a rien lu.
      assert.equal(await countUnreadStaffNotifications(paul, db), 2)
      // Relue : rien ne change.
      assert.equal(await markStaffNotificationRead(camille, feed.items[0].id, db), 1)
      const relu = await staffNotificationFeed(camille, db)
      assert.deepEqual(
        relu.items.map((item) => item.read).sort(),
        [false, true],
      )

      assert.equal(await markAllStaffNotificationsRead(camille, db), 0)
      assert.equal(await countUnreadStaffNotifications(camille, db), 0)
      assert.equal(await countUnreadStaffNotifications(paul, db), 2)
    })

    it('ne montre à un membre que ce que ses droits lui ouvrent', async () => {
      await sonner('booking_request')
      const pli = await sonner('mail_request')
      assert.ok(pli)
      const courrierSeul: StaffReader = { id: PAUL, allowed: ['courrier.gerer'] }
      const feed = await staffNotificationFeed(courrierSeul, db)
      assert.deepEqual(
        feed.items.map((item) => item.kind),
        ['mail_request'],
      )
      assert.equal(feed.unread, 1)

      // Une notification hors de ses droits ne se marque pas, même par son identifiant.
      const [reservation] = (await staffNotificationFeed(camille, db)).items.filter((item) => item.kind === 'booking_request')
      await markStaffNotificationRead(courrierSeul, reservation.id, db)
      assert.equal((await lire('select count(*) as n from staff_notification_reads'))[0].n, 0)

      const aucun: StaffReader = { id: PAUL, allowed: ['espace-client.personnel'] }
      assert.deepEqual(await staffNotificationFeed(aucun, db), { unread: 0, items: [] })
    })

    it('ne montre que les trente derniers jours, et rien d’un autre centre', async () => {
      await sonner('booking_request', 'Récente')
      await asTenant((tx) =>
        tx.execute(sql`
          insert into staff_notifications (id, kind, related_id, summary, created_at)
          values (${uuidv7()}, 'booking_request', ${uuidv7()}, 'Ancienne', CURRENT_TIMESTAMP(3) - interval 40 day)`),
      )
      await lire(
        `insert into tenants (id, name, slug) values (?, 'Centre voisin', 'centre-voisin-cloche')
         on duplicate key update id = id`,
        [AUTRE_CENTRE],
      )
      await withTenant(
        AUTRE_CENTRE,
        (tx) =>
          tx.execute(sql`
            insert into staff_notifications (id, tenant_id, kind, related_id, summary)
            values (${uuidv7()}, ${AUTRE_CENTRE}, 'booking_request', ${uuidv7()}, 'Voisine')`),
        bases.app.db,
      )
      const feed = await staffNotificationFeed(camille, db)
      assert.deepEqual(
        feed.items.map((item) => item.summary),
        ['Récente'],
      )
      assert.equal(feed.unread, 1)
      await lire('delete from staff_notifications where tenant_id = ?', [AUTRE_CENTRE])
    })

    it('borne un résumé trop long, et en donne un à défaut', async () => {
      await signalStaff({ kind: 'offer_request', clientId: DURAND, relatedId: uuidv7(), summary: ['x'.repeat(400)] }, db)
      await signalStaff({ kind: 'offer_request', clientId: DURAND, relatedId: uuidv7(), summary: ['  ', null] }, db)
      const resumes = (await cloche()).map((ligne) => String(ligne.summary)).sort((a, b) => b.length - a.length)
      assert.equal(resumes[0].length, 255)
      assert.equal(resumes[1], 'Offre demandée')
    })
  })
})
