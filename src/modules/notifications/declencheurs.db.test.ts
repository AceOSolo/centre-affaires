import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql, type SQL } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { Message, SendResult } from '../../lib/courriel.ts'
import { notifyContractActivated, notifyMemberInvited, notifyOfferRequested } from './declencheurs-clients.ts'
import {
  notifyMailReceived,
  notifyMailRequestDone,
  notifyMailRequestRefused,
  notifyMailRequestSubmitted,
  notifyMailScanned,
} from './declencheurs-courrier.ts'
import { notifyInspectionSigned, notifyInspectionToSign } from './declencheurs-etats-des-lieux.ts'
import { notifyInvoiceIssued } from './declencheurs-facturation.ts'
import {
  notifyBookingCancelled,
  notifyBookingConfirmed,
  notifyBookingRequestAccepted,
  notifyBookingRequestRefused,
  notifyBookingRequestSubmitted,
} from './declencheurs-reservations.ts'

/**
 * Déclencheurs des notifications (R26, ADR 038), éprouvés contre la base :
 * chacun relit l'état, ne prévient que si l'événement a eu lieu, choisit les
 * bons destinataires et ne met dans le message ni document, ni expéditeur, ni
 * texte saisi par le client.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('déclencheurs des notifications', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const DURAND = '01a00000-0000-7000-8000-0000000f2c01'
  const JEANNE = '01a00000-0000-7000-8000-0000000f2d01'
  const JULES = '01a00000-0000-7000-8000-0000000f2d02'
  const CAMILLE = '01a00000-0000-7000-8000-0000000f2e01'
  const SALLE = '01a00000-0000-7000-8000-0000000f2b01'
  const BUREAU = '01a00000-0000-7000-8000-0000000f2b02'
  const CONTRAT = '01a00000-0000-7000-8000-0000000f2f01'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, app.db)

  let envoyes: Message[] = []
  const send = async (message: Message): Promise<SendResult> => {
    envoyes.push(message)
    return { status: 'sent', recipients: message.to.map((to) => to.toLowerCase()), failed: [], error: null }
  }
  const options = { database: app.db, send }

  const journal = () =>
    owner.client`select event, audience, client_id, recipients, status, related_type, related_id
                   from notification_deliveries order by sent_at, id`

  const id = async (query: Promise<Record<string, unknown>[]>) => (await query)[0].id as string

  let centre: Record<string, unknown>

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
    ;[centre] = await owner.client`
      select email, legal_name, address_line1, postal_code, city, siren, vat_number, bank_iban
        from tenants where id = ${DEFAULT_TENANT_ID}`
  })

  beforeEach(async () => {
    envoyes = []
    await owner.client`truncate table bookings, contracts, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`truncate table inspection_templates cascade`
    await owner.client`truncate table notification_deliveries, notification_templates, notification_preferences`
    await owner.client`
      update tenants set email = 'accueil@centre.exemple', legal_name = 'Centre de démonstration SAS',
        address_line1 = '1 rue de l''Exemple', postal_code = '38070', city = 'Saint-Quentin-Fallavier',
        siren = '123456789', vat_number = 'FR32123456789', bank_iban = 'FR7630006000011234567890189'
      where id = ${DEFAULT_TENANT_ID}`
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, full_name) values (${CAMILLE}, 'camille@centre.exemple', 'Camille')`)
      await tx.execute(sql`
        insert into clients (id, name, status, address_line1, postal_code, city)
        values (${DURAND}, 'Atelier Durand', 'active', '2 place du Marché', '38000', 'Grenoble')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand'),
          (${JULES}, ${DURAND}, 'jules@durand.fr', null)`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${SALLE}, 'salle', 'S-NOT', 'Salle Atlas'), (${BUREAU}, 'bureau', 'B-NOT', 'Bureau 12')`)
      await tx.execute(sql`
        insert into contracts (id, client_id, reference, contract_type, starts_on, amount_cents)
        values (${CONTRAT}, ${DURAND}, 'CT-NOTIF-1', 'bureau', '2026-11-01', 90000)`)
    })
  })

  after(async () => {
    await owner.client`truncate table notification_deliveries, notification_templates, notification_preferences`
    await owner.client`truncate table inspection_templates cascade`
    await owner.client`
      update tenants set email = ${centre.email as string | null}, legal_name = ${centre.legal_name as string | null},
        address_line1 = ${centre.address_line1 as string | null}, postal_code = ${centre.postal_code as string | null},
        city = ${centre.city as string | null}, siren = ${centre.siren as string | null},
        vat_number = ${centre.vat_number as string | null}, bank_iban = ${centre.bank_iban as string | null}
      where id = ${DEFAULT_TENANT_ID}`
    await Promise.all([owner.client.end(), app.client.end()])
  })

  describe('courrier', () => {
    const pli = (ouvert = false) =>
      id(
        asTenant((tx) =>
          tx.execute(sql`
            insert into mail_items (client_id, kind, sender, note, received_at, status, opened_at, opened_by)
            values (${DURAND}, 'recommande', 'URSSAF', 'Mise en demeure', '2026-09-30T22:30:00Z',
                    ${ouvert ? 'opened' : 'received'}, ${ouvert ? sql`now()` : null}, ${ouvert ? CAMILLE : null})
            returning id`),
        ),
      )

    const reexpedition = (mailItemId: string) =>
      id(
        asTenant((tx) =>
          tx.execute(sql`
            insert into mail_requests (mail_item_id, client_id, kind, requested_by_member_id, client_note,
              forward_recipient, forward_address_line1, forward_postal_code, forward_city, forward_country)
            values (${mailItemId}, ${DURAND}, 'forward', ${JEANNE}, 'Consigne confidentielle',
                    'Jeanne Durand', '12 rue des Lilas', '38000', 'Grenoble', 'FR')
            returning id`),
        ),
      )

    it('annonce l’arrivée d’un pli sans l’expéditeur ni la note, à l’heure du centre', async () => {
      const mail = await pli()
      const issue = await notifyMailReceived(mail, options)
      assert.equal(issue?.status, 'sent')
      assert.equal(envoyes[0].subject, 'Nouveau courrier pour Atelier Durand')
      assert.match(envoyes[0].text, /recommandé/)
      assert.match(envoyes[0].text, /1 oct\. 2026 à 00:30/)
      assert.doesNotMatch(envoyes[0].text, /URSSAF|Mise en demeure/)
      const [ligne] = await journal()
      assert.deepEqual([ligne.event, ligne.related_type, ligne.related_id], ['mail_received', 'mail_item', mail])
    })

    it('annonce un pli enregistré déjà ouvert comme numérisé', async () => {
      await notifyMailReceived(await pli(true), options)
      const [ligne] = await journal()
      assert.equal(ligne.event, 'mail_scanned')
    })

    it('prévient le centre d’une demande, sans l’adresse ni la consigne du client', async () => {
      const demande = await reexpedition(await pli())
      const issue = await notifyMailRequestSubmitted(demande, options)
      assert.equal(issue?.status, 'sent')
      assert.deepEqual(envoyes[0].to, ['accueil@centre.exemple'])
      assert.equal(envoyes[0].subject, 'Demande de courrier (réexpédition) — Atelier Durand')
      assert.match(envoyes[0].text, /^Jeanne Durand demande/)
      assert.doesNotMatch(envoyes[0].text, /Lilas|Consigne confidentielle|URSSAF/)
      const [ligne] = await journal()
      assert.deepEqual([ligne.audience, ligne.client_id, ligne.related_type], ['centre', DURAND, 'mail_request'])
    })

    it('dit qu’une réexpédition est faite, avec son suivi, et seulement une fois faite', async () => {
      const demande = await reexpedition(await pli())
      assert.equal(await notifyMailRequestDone(demande, options), null)
      await asTenant((tx) =>
        tx.execute(sql`
          update mail_requests set status = 'done', completed_by_staff_id = ${CAMILLE},
                 forward_tracking_number = '6A12345678901'
           where id = ${demande}`),
      )
      const issue = await notifyMailRequestDone(demande, options)
      assert.equal(issue?.status, 'sent')
      assert.equal(envoyes[0].subject, 'Demande de courrier traitée (réexpédition) — Atelier Durand')
      assert.match(envoyes[0].text, /Numéro de suivi : 6A12345678901/)
      assert.deepEqual([...envoyes[0].to].sort(), ['jeanne@durand.fr', 'jules@durand.fr'])
    })

    it('dit le motif d’un refus', async () => {
      const demande = await reexpedition(await pli())
      await asTenant((tx) =>
        tx.execute(sql`
          update mail_requests set status = 'refused', refused_by_staff_id = ${CAMILLE},
                 refusal_reason = 'Adresse hors de France.'
           where id = ${demande}`),
      )
      await notifyMailRequestRefused(demande, options)
      assert.match(envoyes[0].text, /Motif : Adresse hors de France\./)
    })

    it('ne double pas le message d’ouverture : la demande faite par l’ouverture ne prévient pas', async () => {
      const mail = await pli()
      const demande = await id(
        asTenant((tx) =>
          tx.execute(sql`
            insert into mail_requests (mail_item_id, client_id, kind, requested_by_member_id)
            values (${mail}, ${DURAND}, 'open_and_scan', ${JEANNE}) returning id`),
        ),
      )
      assert.equal(await notifyMailScanned(mail, options), null)
      await asTenant((tx) =>
        tx.execute(sql`update mail_items set status = 'opened', opened_at = now(), opened_by = ${CAMILLE} where id = ${mail}`),
      )
      assert.equal(await notifyMailRequestDone(demande, options), null)
      assert.equal((await notifyMailScanned(mail, options))?.status, 'sent')
      assert.equal(envoyes.length, 1)
      assert.equal(envoyes[0].subject, 'Votre courrier a été numérisé — Atelier Durand')
    })
  })

  describe('réservations', () => {
    /** Créneau d'une heure dans trois jours, à 8 h UTC. */
    let heure = 6
    const creneau = (): SQL => {
      heure += 1
      return sql`date_trunc('day', now()) + make_interval(days => 3, hours => ${heure}),
                 date_trunc('day', now()) + make_interval(days => 3, hours => ${heure + 1})`
    }

    const reserver = (colonnes: SQL, valeurs: SQL) =>
      id(
        asTenant((tx) =>
          tx.execute(sql`
            insert into bookings (resource_id, title, starts_at, ends_at, ${colonnes})
            values (${SALLE}, 'Réunion', ${creneau()}, ${valeurs}) returning id`),
        ),
      )

    it('prévient le centre d’une demande de l’espace, puis la personne qui l’a faite quand elle est acceptée', async () => {
      const reservation = await reserver(
        sql`client_id, channel, booked_by_member_id`,
        sql`${DURAND}, 'client', ${JEANNE}`,
      )
      assert.equal((await notifyBookingRequestSubmitted(reservation, options))?.status, 'sent')
      assert.deepEqual(envoyes[0].to, ['accueil@centre.exemple'])
      assert.match(envoyes[0].text, /^Jeanne Durand demande à réserver Salle Atlas le /)

      // En attente : rien n'est annoncé comme accepté.
      assert.equal(await notifyBookingRequestAccepted(reservation, options), null)
      await asTenant((tx) => tx.execute(sql`update bookings set status = 'confirmed' where id = ${reservation}`))
      await notifyBookingRequestAccepted(reservation, options)
      assert.deepEqual(envoyes[1].to, ['jeanne@durand.fr'])
      assert.match(envoyes[1].subject, /^Réservation confirmée — Salle Atlas, /)
    })

    it('prévient le demandeur d’un refus, avec le motif, selon ses préférences', async () => {
      const demande = () =>
        reserver(
          sql`client_id, channel, status, requester_name, requester_email, requester_phone`,
          sql`${DURAND}, 'client', 'pending', 'Jules', 'Jules@Durand.fr', '0600000000'`,
        )
      const refuser = (reservation: string) =>
        asTenant((tx) =>
          tx.execute(sql`
            update bookings set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'Salle fermée ce jour-là.'
             where id = ${reservation}`),
        )
      const premiere = await demande()
      await refuser(premiere)
      await notifyBookingRequestRefused(premiere, options)
      assert.deepEqual(envoyes[0].to, ['jules@durand.fr'])
      assert.match(envoyes[0].text, /Motif : Salle fermée ce jour-là\./)

      // Jules a un accès : son renoncement aux réservations vaut aussi ici.
      await asTenant((tx) =>
        tx.execute(sql`
          insert into notification_preferences (client_id, client_member_id, category, enabled)
          values (${DURAND}, ${JULES}, 'bookings', false)`),
      )
      const seconde = await demande()
      await refuser(seconde)
      assert.equal((await notifyBookingRequestRefused(seconde, options))?.status, 'skipped')
      assert.equal(envoyes.length, 1)
    })

    it('ne prévient pas de client pour une demande anonyme ; le centre, oui', async () => {
      const reservation = await reserver(
        sql`channel, status, requester_name, requester_email, requester_phone`,
        sql`'public', 'pending', 'Camille Rousseau', 'camille@exemple.fr', '0600000000'`,
      )
      await notifyBookingRequestSubmitted(reservation, options)
      assert.match(envoyes[0].text, /^Camille Rousseau demande à réserver/)
      assert.doesNotMatch(envoyes[0].text, /Entreprise :/)
      await asTenant((tx) => tx.execute(sql`update bookings set status = 'confirmed' where id = ${reservation}`))
      assert.equal(await notifyBookingRequestAccepted(reservation, options), null)
      assert.equal((await journal()).length, 1)
    })

    it('annonce une réservation de l’équipe pour l’entreprise, puis son annulation', async () => {
      const reservation = await reserver(sql`client_id, channel`, sql`${DURAND}, 'staff'`)
      assert.equal(await notifyBookingCancelled(reservation, options), null)
      await notifyBookingConfirmed(reservation, options)
      assert.deepEqual([...envoyes[0].to].sort(), ['jeanne@durand.fr', 'jules@durand.fr'])
      await asTenant((tx) =>
        tx.execute(sql`update bookings set status = 'cancelled', cancelled_at = now() where id = ${reservation}`),
      )
      await notifyBookingCancelled(reservation, options)
      assert.match(envoyes[1].subject, /^Réservation annulée — Salle Atlas, /)
      assert.doesNotMatch(envoyes[1].text, /Motif/)
      const lignes = await journal()
      assert.deepEqual(
        lignes.map((ligne) => ligne.event),
        ['booking_confirmed', 'booking_cancelled'],
      )
    })
  })

  describe('facturation et contrats', () => {
    it('annonce une facture émise, montant et échéance, sans la joindre ; rien pour un brouillon', async () => {
      const facture = await id(
        asTenant((tx) =>
          tx.execute(sql`
            insert into invoices (client_id, period_start, period_end)
            values (${DURAND}, '2026-09-01', '2026-09-30') returning id`),
        ),
      )
      await asTenant((tx) =>
        tx.execute(sql`
          insert into invoice_lines (invoice_id, kind, description, unit_price_cents, vat_rate_bp)
          values (${facture}, 'other', 'Prestation', 10000, 2000)`),
      )
      assert.equal(await notifyInvoiceIssued(facture, options), null)

      const [{ numero }] = await asTenant((tx) =>
        tx.execute(sql`select issue_invoice(${facture}::uuid, ${CAMILLE}::uuid) as numero`),
      )
      const issue = await notifyInvoiceIssued(facture, options)
      assert.equal(issue?.status, 'sent')
      assert.ok(envoyes[0].subject.startsWith(`Votre facture ${numero as string} — `))
      assert.match(envoyes[0].text, /Montant TTC : 120,00/)
      assert.match(envoyes[0].text, /Échéance : \d{2}\/\d{2}\/\d{4}/)
      assert.match(envoyes[0].text, /ne contient pas le document/)
      const [ligne] = await journal()
      assert.deepEqual([ligne.event, ligne.related_type, ligne.related_id], ['invoice_issued', 'invoice', facture])
    })

    it('annonce un contrat une fois activé, et pas avant', async () => {
      assert.equal(await notifyContractActivated(CONTRAT, options), null)
      await asTenant((tx) => tx.execute(sql`update contracts set status = 'active' where id = ${CONTRAT}`))
      await notifyContractActivated(CONTRAT, options)
      assert.equal(envoyes[0].subject.startsWith('Votre contrat CT-NOTIF-1 est en vigueur'), true)
      assert.match(envoyes[0].text, /prend effet le 01\/11\/2026/)
      // Sans ressource : la ligne qui la citerait n'est pas envoyée.
      assert.doesNotMatch(envoyes[0].text, /Ressource :/)
    })
  })

  describe('espace client', () => {
    it('invite la seule personne inscrite, quelles que soient ses préférences', async () => {
      await notifyMemberInvited(DURAND, ' JEANNE@durand.fr ', options)
      assert.deepEqual(envoyes[0].to, ['jeanne@durand.fr'])
      assert.match(envoyes[0].text, /jeanne@durand\.fr/)
      const [ligne] = await journal()
      assert.deepEqual([ligne.event, ligne.related_type, ligne.related_id], ['member_invited', 'client_member', JEANNE])
    })

    it('prévient le centre d’une offre demandée, seulement si elle est montrée aux clients', async () => {
      const offre = await id(
        asTenant((tx) =>
          tx.execute(sql`insert into offers (name, client_visible) values ('Domiciliation premium', false) returning id`),
        ),
      )
      const demande = { offerId: offre, clientId: DURAND, memberId: JEANNE, message: 'Dès novembre ?' }
      assert.equal(await notifyOfferRequested(demande, options), null)
      await asTenant((tx) => tx.execute(sql`update offers set client_visible = true where id = ${offre}`))
      await notifyOfferRequested(demande, options)
      assert.deepEqual(envoyes[0].to, ['accueil@centre.exemple'])
      assert.equal(envoyes[0].subject, 'Offre demandée — Domiciliation premium, Atelier Durand')
      assert.match(envoyes[0].text, /Message : Dès novembre \?/)
    })
  })

  describe('états des lieux', () => {
    it('demande la validation d’un état clos, puis prévient le centre de la validation, sans les remarques', async () => {
      const version = await asTenant(async (tx) => {
        const [modele] = await tx.execute(sql`
          insert into inspection_templates (resource_type, name) values ('bureau', 'Bureau') returning id`)
        const [row] = await tx.execute(sql`
          insert into inspection_template_versions (template_id, version, name, fields, created_by)
          values (${modele.id as string}, 1, 'Bureau',
                  '[{"id":"murs","label":"Murs","type":"condition","required":true}]'::jsonb, ${CAMILLE})
          returning id`)
        return row.id as string
      })
      const etat = await id(
        asTenant((tx) =>
          tx.execute(sql`
            insert into inspections (kind, resource_id, client_id, contract_id, template_version_id, created_by,
                                     performed_at)
            values ('entry', ${BUREAU}, ${DURAND}, ${CONTRAT}, ${version}, ${CAMILLE}, '2026-10-02T08:00:00Z')
            returning id`),
        ),
      )
      assert.equal(await notifyInspectionToSign(etat, options), null)

      await asTenant((tx) =>
        tx.execute(sql`
          update inspections set status = 'closed', closed_by = ${CAMILLE}, values = '{"murs":"bon"}'::jsonb
           where id = ${etat}`),
      )
      await notifyInspectionToSign(etat, options)
      assert.equal(envoyes[0].subject, 'État des lieux à valider — Bureau 12')
      assert.match(envoyes[0].text, /L’état des lieux d’entrée de Bureau 12, fait le 2 oct\. 2026 à 10:00/)
      assert.deepEqual([...envoyes[0].to].sort(), ['jeanne@durand.fr', 'jules@durand.fr'])

      await asTenant((tx) =>
        tx.execute(sql`
          update inspections set signed_by_member_id = ${JEANNE}, client_remarks = 'Rayure sur la porte'
           where id = ${etat}`),
      )
      assert.equal(await notifyInspectionToSign(etat, options), null)
      await notifyInspectionSigned(etat, options)
      assert.deepEqual(envoyes[1].to, ['accueil@centre.exemple'])
      assert.match(envoyes[1].text, /^Jeanne Durand a validé pour Atelier Durand l’état des lieux d’entrée/)
      assert.match(envoyes[1].text, /Le client a ajouté des remarques\./)
      assert.doesNotMatch(envoyes[1].text, /Rayure/)
    })
  })
})
