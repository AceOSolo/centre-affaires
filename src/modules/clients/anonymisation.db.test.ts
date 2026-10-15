import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_ANONYMIZATION_REFUSED, dbErrorCode } from '../../db/errors.ts'
import { withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { addDaysToIsoDate, todayIsoDate } from '../../lib/dates.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { jsonEnTableau, lire, toutVider } from './test-support.ts'

/**
 * Anonymisation RGPD (R29, ADR 040), éprouvée contre la base sous
 * l'identité applicative.
 *
 * Deux choses ne doivent jamais arriver : qu'une entreprise dont la relation
 * vit encore — une facture non soldée, un contrat en cours — soit
 * anonymisée, et qu'une facture émise perde ce qu'elle doit garder dix ans.
 * Rien n'est supprimé : les champs personnels partent, les lignes restent.
 */
describe('anonymisation RGPD', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const DURAND = '01a00000-0000-7000-8000-000000a90c01'
  const PROSPECT_SANS_FACTURE = '01a00000-0000-7000-8000-000000a90c06'
  const PROSPECT = '01a00000-0000-7000-8000-000000a90c02'
  const ANCIEN = '01a00000-0000-7000-8000-000000a90c03'
  const MANDATE = '01a00000-0000-7000-8000-000000a90c04'
  const JEANNE = '01a00000-0000-7000-8000-000000a90d01'
  const ACCUEIL = '01a00000-0000-7000-8000-000000a90e01'
  const SALLE = '01a00000-0000-7000-8000-000000a90b01'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const codeErreur = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  /** Le message du refus tel que la base le signale (`SIGNAL`, 128 caractères au plus). */
  const messageErreur = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
        const { sqlMessage } = cause as { sqlMessage?: unknown }
        if (typeof sqlMessage === 'string' && dbErrorCode(error) === DB_ANONYMIZATION_REFUSED) {
          return sqlMessage
        }
      }
      throw error
    }
    return undefined
  }

  /** À la demande : fin de la relation constatée par l'accueil (ADR 041). */
  const anonymiser = (clientId: string) =>
    asTenant((tx) =>
      tx.execute(sql`select anonymize_client(${clientId}, ${ACCUEIL}, 'relationship_ended', null)`),
    )

  const bloquants = async (clientId: string): Promise<string[]> => {
    const [row] = await asTenant((tx) =>
      lire(tx, sql`select client_anonymization_blockers(${clientId}) as raisons`),
    )
    return jsonEnTableau<string>(row.raisons)
  }

  /** Facture émise de 100 € HT à 20 %, pour le client. */
  const factureEmise = async (clientId = DURAND) => {
    const id = uuidv7()
    const numero = await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into invoices (id, client_id, period_start, period_end)
        values (${id}, ${clientId}, '2026-09-01', '2026-09-30')`)
      await tx.execute(sql`
        insert into invoice_lines (invoice_id, kind, description, unit_price_cents, vat_rate_bp)
        values (${id}, 'other', 'Prestation', 10000, 2000)`)
      const [row] = await lire(tx, sql`select issue_invoice(${id}, ${ACCUEIL}) as numero`)
      return row.numero as string
    })
    return { id, numero }
  }

  /**
   * Règle la facture d'un seul paiement. Le total est lu avant : MySQL refuse
   * un `insert … select` sur `invoices` quand un trigger de `payments` écrit
   * dans `invoices` (erreur 1442).
   */
  const solder = (invoiceId: string) =>
    asTenant(async (tx) => {
      const [facture] = await lire(
        tx,
        sql`select total_incl_tax_cents as total from invoices where id = ${invoiceId}`,
      )
      await tx.execute(sql`
        insert into payments (invoice_id, amount_cents, paid_on, method, recorded_by)
        values (${invoiceId}, ${Number(facture.total)}, '2026-10-01', 'transfer', ${ACCUEIL})`)
    })

  /** La facture telle qu'en base, hors `updated_at`. */
  const facture = async (invoiceId: string) => {
    const [row] = await asTenant((tx) => lire(tx, sql`select * from invoices where id = ${invoiceId}`))
    const { updated_at: _ignore, ...reste } = row
    return reste
  }

  const identiteDuCentre = sql`
    update tenants set
      legal_name = 'Centre de démonstration SAS', legal_form = 'SAS', share_capital_cents = 1000000,
      address_line1 = '1 rue de l''Exemple', postal_code = '38070', city = 'Saint-Quentin-Fallavier',
      siren = '123456789', siret = '12345678900012', vat_number = 'FR32123456789', rcs_city = 'Vienne',
      bank_iban = 'FR7630006000011234567890189', bank_bic = 'AGRIFRPP'
    where id = ${DEFAULT_TENANT_ID}`

  before(async () => {
    bases = await ouvrirBasesDeTest()
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await bases.owner.db.execute(identiteDuCentre)
    await bases.owner.client.query(
      `update tenants set prospect_retention_months = 36, client_retention_months = 60,
                          removed_member_retention_months = 12
        where id = ?`,
      [DEFAULT_TENANT_ID],
    )
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, full_name) values (${ACCUEIL}, 'accueil@centre.fr', 'Camille Accueil')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values (${SALLE}, 'salle', 'S-RGPD', 'Salle Europe')`)
      await tx.execute(sql`
        insert into clients (id, name, status, siret, email, phone, address_line1, postal_code, city, notes, accounting_code)
        values (${DURAND}, 'Atelier Durand', 'active', '98765432100015', 'contact@durand.fr', '0600000000',
                '2 place du Marché', '38000', 'Grenoble', 'Gérant : Jean Durand', 'DURAND')`)
      await tx.execute(sql`
        insert into client_contacts (client_id, full_name, email, phone, is_primary)
        values (${DURAND}, 'Jean Durand', 'jean@durand.fr', '0611111111', true)`)
      await tx.execute(sql`
        insert into clients (id, name, status) values (${PROSPECT_SANS_FACTURE}, 'Prospect sans facture', 'prospect')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id)
        values (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand', 'u-jeanne')`)
    })
  })

  after(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query(
      `update tenants set legal_name = null, legal_form = null, share_capital_cents = null,
        address_line1 = null, postal_code = null, city = null, siren = null, siret = null,
        vat_number = null, rcs_city = null, bank_iban = null, bank_bic = null
      where id = ?`,
      [DEFAULT_TENANT_ID],
    )
    await bases.fermer()
  })

  describe('exclusions', () => {
    it('refuse une entreprise dont une facture n’est pas soldée, et la nomme', async () => {
      const { numero } = await factureEmise()
      const message = await messageErreur(() => anonymiser(DURAND))
      assert.ok(message?.includes(numero), message)
      assert.deepEqual(await bloquants(DURAND), [`Facture non soldée : ${numero}.`])
    })

    it('refuse un contrat vivant, une réservation à venir, un brouillon de facture', async () => {
      await asTenant(async (tx) => {
        await tx.execute(sql`
          insert into contracts (client_id, reference, contract_type, status, starts_on, amount_cents)
          values (${DURAND}, 'DOM-1', 'domiciliation', 'active', '2026-01-01', 9000)`)
        await tx.execute(sql`
          insert into bookings (resource_id, client_id, channel, starts_at, ends_at, title)
          values (${SALLE}, ${DURAND}, 'staff', date_add(now(3), interval 2 day),
                  date_add(now(3), interval 49 hour), 'Réunion')`)
        await tx.execute(sql`
          insert into invoices (client_id, period_start, period_end) values (${DURAND}, '2026-09-01', '2026-09-30')`)
      })
      assert.equal(await codeErreur(() => anonymiser(DURAND)), DB_ANONYMIZATION_REFUSED)
      assert.deepEqual(await bloquants(DURAND), [
        "Brouillon de facture ou d'avoir à émettre ou à abandonner.",
        'Contrat vivant : DOM-1.',
        'Réservation à venir ou en cours.',
      ])
      // Rien n'a bougé.
      const [row] = await asTenant((tx) =>
        lire(tx, sql`select name, anonymized_at from clients where id = ${DURAND}`),
      )
      assert.equal(row.name, 'Atelier Durand')
      assert.equal(row.anonymized_at, null)
    })

    it('refuse depuis un espace client', async () => {
      assert.equal(
        await codeErreur(() =>
          withClientScope(
            DEFAULT_TENANT_ID,
            [DURAND],
            (tx) => tx.execute(sql`select anonymize_client(${DURAND}, ${ACCUEIL}, 'relationship_ended', null)`),
            bases.app.db,
          ),
        ),
        DB_ANONYMIZATION_REFUSED,
      )
    })

    it('exige un fondement, un auteur vivant et, pour un effacement, le jour de la demande', async () => {
      const refus = (basis: string | null, jour: string | null, par = ACCUEIL) =>
        codeErreur(() =>
          asTenant((tx) => tx.execute(sql`select anonymize_client(${DURAND}, ${par}, ${basis}, ${jour})`)),
        )
      const aujourdhui = todayIsoDate('Europe/Paris')
      assert.equal(await refus(null, null), DB_ANONYMIZATION_REFUSED)
      assert.equal(await refus('retention', null), DB_ANONYMIZATION_REFUSED)
      assert.equal(await refus('erasure_request', null), DB_ANONYMIZATION_REFUSED)
      assert.equal(await refus('relationship_ended', aujourdhui), DB_ANONYMIZATION_REFUSED)
      assert.equal(
        await refus('erasure_request', addDaysToIsoDate(aujourdhui, 3)),
        DB_ANONYMIZATION_REFUSED,
      )
      assert.equal(await refus('relationship_ended', null, uuidv7()), DB_ANONYMIZATION_REFUSED)
    })
  })

  describe('anonymisation d’une entreprise', () => {
    it('efface les champs personnels partout, garde les lignes, ne touche pas aux factures', async () => {
      const { id: factureId, numero } = await factureEmise()
      await solder(factureId)
      const avant = await facture(factureId)
      const [{ n: lignesAvant }] = await asTenant((tx) =>
        lire(tx, sql`select count(*) as n from invoice_lines where invoice_id = ${factureId}`),
      )

      const pliId = uuidv7()
      await asTenant(async (tx) => {
        await tx.execute(sql`
          insert into contracts (client_id, reference, contract_type, status, starts_on, terminated_on,
                                 termination_reason, notes, amount_cents)
          values (${DURAND}, 'DOM-0', 'domiciliation', 'terminated', '2024-01-01', '2026-06-30',
                  'Départ du gérant à l''étranger', 'Clés rendues par M. Durand', 9000)`)
        await tx.execute(sql`
          insert into bookings (resource_id, client_id, channel, starts_at, ends_at, title, notes,
                                requester_name, requester_email, requester_phone)
          values (${SALLE}, ${DURAND}, 'public', '2026-03-10 08:00:00', '2026-03-10 09:00:00', 'Réunion',
                  'Rappeler Jean au 06…', 'Jean Durand', 'jean@durand.fr', '0611111111')`)
        await tx.execute(sql`
          insert into mail_items (id, client_id, sender, note, status, opened_at, opened_by)
          values (${pliId}, ${DURAND}, 'Dr Martin', 'Pli personnel', 'opened',
                  date_sub(now(3), interval 1 day), ${ACCUEIL})`)
        await tx.execute(sql`
          insert into mail_requests (mail_item_id, client_id, kind, requested_by_member_id,
            forward_recipient, forward_address_line1, forward_postal_code, forward_city, forward_country)
          values (${pliId}, ${DURAND}, 'forward', ${JEANNE}, 'Jeanne Durand', '12 rue des Lilas',
                  '38000', 'Grenoble', 'FR')`)
        await tx.execute(sql`
          update mail_requests set status = 'refused', refused_by_staff_id = ${ACCUEIL}, refusal_reason = 'Adresse incomplète'`)
        await tx.execute(sql`
          insert into notification_deliveries (event, audience, client_id, recipients, subject, status)
          values ('mail_received', 'client', ${DURAND}, ${JSON.stringify(['jeanne@durand.fr'])},
                  'Nouveau courrier pour Atelier Durand', 'sent')`)
      })

      await anonymiser(DURAND)

      const [client] = await asTenant((tx) => lire(tx, sql`select * from clients where id = ${DURAND}`))
      assert.match(client.name as string, /^Client anonymisé /)
      for (const champ of ['siret', 'email', 'phone', 'address_line1', 'postal_code', 'city', 'notes']) {
        assert.equal(client[champ], null, champ)
      }
      assert.equal(client.status, 'inactive')
      assert.ok(client.anonymized_at)
      assert.ok(client.deleted_at)
      // Les écritures comptables passées citent ce compte.
      assert.equal(client.accounting_code, 'DURAND')

      const [contact] = await asTenant((tx) =>
        lire(tx, sql`select * from client_contacts where client_id = ${DURAND}`),
      )
      assert.equal(contact.full_name, 'Contact anonymisé')
      assert.equal(contact.email, null)
      assert.ok(contact.anonymized_at)

      const [acces] = await asTenant((tx) => lire(tx, sql`select * from client_members where id = ${JEANNE}`))
      assert.match(acces.email as string, /@anonymise\.invalid$/)
      assert.equal(acces.auth_user_id, null)
      assert.ok(acces.anonymized_at)

      const [pli] = await asTenant((tx) => lire(tx, sql`select * from mail_items where client_id = ${DURAND}`))
      assert.equal(pli.sender, null)
      assert.equal(pli.note, null)
      assert.ok(pli.sender_anonymized_at)

      const [demande] = await asTenant((tx) =>
        lire(tx, sql`select * from mail_requests where client_id = ${DURAND}`),
      )
      assert.equal(demande.forward_recipient, 'Destinataire anonymisé')
      assert.equal(demande.status, 'refused')

      const [reservation] = await asTenant((tx) =>
        lire(tx, sql`select * from bookings where client_id = ${DURAND} and kind = 'booking'`),
      )
      assert.equal(reservation.requester_name, null)
      assert.equal(reservation.notes, null)
      assert.ok(reservation.requester_anonymized_at)
      assert.equal(reservation.title, 'Réunion')

      const [contrat] = await asTenant((tx) =>
        lire(tx, sql`select * from contracts where client_id = ${DURAND}`),
      )
      assert.equal(contrat.notes, null)
      assert.equal(contrat.termination_reason, null)
      assert.equal(contrat.reference, 'DOM-0')

      const [message] = await asTenant((tx) =>
        lire(tx, sql`select recipients, subject from notification_deliveries where client_id = ${DURAND}`),
      )
      assert.deepEqual(jsonEnTableau(message.recipients), ['destinataire@anonymise.invalid'])

      // La facture, ses lignes et son instantané d'acheteur : intacts.
      const apres = await facture(factureId)
      assert.deepEqual(apres, avant)
      assert.equal(apres.number, numero)
      const instantane = apres.buyer_snapshot
      const acheteur = (typeof instantane === 'string' ? JSON.parse(instantane) : instantane) as { name: string }
      assert.equal(acheteur.name, 'Atelier Durand')
      const [{ n: lignesApres }] = await asTenant((tx) =>
        lire(tx, sql`select count(*) as n from invoice_lines where invoice_id = ${factureId}`),
      )
      assert.equal(Number(lignesApres), Number(lignesAvant))
    })

    it('fige le compte auxiliaire d’un client facturé, dérivé de sa raison sociale (ADR 041)', async () => {
      const SOCIETE = '01a00000-0000-7000-8000-000000a90c05'
      await asTenant((tx) =>
        tx.execute(sql`
          insert into clients (id, name, status, address_line1, postal_code, city)
          values (${SOCIETE}, 'Société Générale d’Électricité', 'active', '1 rue Volta', '38000', 'Grenoble')`),
      )
      const { id } = await factureEmise(SOCIETE)
      await solder(id)
      await anonymiser(SOCIETE)
      await anonymiser(PROSPECT_SANS_FACTURE)
      const rows = await asTenant((tx) =>
        lire(tx, sql`select id, accounting_code from clients where id in (${SOCIETE}, ${PROSPECT_SANS_FACTURE})`),
      )
      const codes = new Map(rows.map((row) => [row.id, row.accounting_code]))
      // Celui que l'export lui donnait (`deriveAccountingCode`) : les exports passés ne bougent pas.
      assert.equal(codes.get(SOCIETE), 'SOCIETEGENERALEDE')
      // Jamais facturé : aucun compte à garder.
      assert.equal(codes.get(PROSPECT_SANS_FACTURE), null)
      // Le compte saisi sur une fiche reste le sien.
      await anonymiser(DURAND)
      const [durand] = await asTenant((tx) =>
        lire(tx, sql`select accounting_code from clients where id = ${DURAND}`),
      )
      assert.equal(durand.accounting_code, 'DURAND')
    })

    it('fige une fiche anonymisée, et l’anonymisation ne s’écrit pas à la main', async () => {
      await anonymiser(DURAND)
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => tx.execute(sql`update clients set name = 'Atelier Durand' where id = ${DURAND}`)),
        ),
        DB_ANONYMIZATION_REFUSED,
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => tx.execute(sql`update clients set anonymized_at = null where id = ${DURAND}`)),
        ),
        DB_ANONYMIZATION_REFUSED,
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              insert into clients (name, anonymized_at, deleted_at) values ('Faux', now(3), now(3))`),
          ),
        ),
        DB_ANONYMIZATION_REFUSED,
      )
      // Une seconde fois : refusée, la fiche l'est déjà.
      assert.equal(await codeErreur(() => anonymiser(DURAND)), DB_ANONYMIZATION_REFUSED)
    })

    it('refuse de modifier chaque colonne d’une fiche, d’un contact, d’un accès ou d’un membre anonymisés', async () => {
      await anonymiser(DURAND)
      const ecritures: ReturnType<typeof sql>[] = [
        sql`update clients set city = 'Lyon' where id = ${DURAND}`,
        sql`update clients set last_contact_on = '2026-01-01' where id = ${DURAND}`,
        sql`update client_contacts set notes = 'x' where client_id = ${DURAND}`,
        sql`update client_contacts set is_primary = true where client_id = ${DURAND}`,
        sql`update client_members set full_name = 'x' where id = ${JEANNE}`,
        sql`update client_members set auth_user_id = 'u-x' where id = ${JEANNE}`,
      ]
      for (const ecriture of ecritures) {
        assert.equal(
          await codeErreur(() => asTenant((tx) => tx.execute(ecriture))),
          DB_ANONYMIZATION_REFUSED,
        )
      }
    })
  })

  describe('au terme des durées du centre', () => {
    it('date la fin de la relation à la dernière activité de l’entreprise', async () => {
      await asTenant(async (tx) => {
        await tx.execute(sql`
          insert into clients (id, name, status, created_at) values (${ANCIEN}, 'Ancien client', 'inactive', '2019-01-01')`)
        await tx.execute(sql`
          insert into bookings (resource_id, client_id, channel, starts_at, ends_at, title)
          values (${SALLE}, ${ANCIEN}, 'staff', '2024-03-10 08:00:00', '2024-03-10 09:00:00', 'Réunion')`)
        await tx.execute(sql`
          insert into mail_items (client_id, received_at) values (${ANCIEN}, '2025-02-01 09:00:00')`)
      })
      const [row] = await asTenant((tx) =>
        lire(tx, sql`select cast(client_last_activity_on(${ANCIEN}) as char) as jour`),
      )
      assert.equal(row.jour, '2025-02-01')
    })

    it('anonymise le prospect sans contact et le client parti, passe ceux sous exclusion', async () => {
      await asTenant(async (tx) => {
        await tx.execute(sql`
          insert into clients (id, name, status, created_at) values
            (${PROSPECT}, 'Prospect oublié', 'prospect', '2020-01-01'),
            (${ANCIEN}, 'Ancien client', 'inactive', '2015-01-01'),
            (${MANDATE}, 'Client au mandat actif', 'inactive', '2015-01-01')`)
        // Un prospect rappelé le mois dernier : gardé.
        await tx.execute(sql`
          insert into clients (name, status, created_at, last_contact_on)
          values ('Prospect suivi', 'prospect', '2020-01-01', date_sub(curdate(), interval 30 day))`)
        await tx.execute(sql`
          insert into contracts (client_id, reference, contract_type, status, starts_on, terminated_on, amount_cents)
          values (${ANCIEN}, 'BUR-0', 'bureau', 'terminated', '2018-01-01', '2020-06-30', 90000)`)
        await tx.execute(sql`
          insert into sepa_mandates (client_id, reference, debtor_name, iban_ciphertext, iban_key_version,
                                     iban_last4, signed_on)
          values (${MANDATE}, 'RUM-OUBLI', 'Titulaire', unhex(concat('43414431', repeat('00', 45))), 1,
                  '0189', '2015-01-01')`)
      })
      const [row] = await asTenant((tx) => lire(tx, sql`select anonymize_expired_clients() as n`))
      assert.equal(Number(row.n), 2)
      const anonymises = await asTenant((tx) =>
        lire(tx, sql`select id from clients where anonymized_at is not null order by id`),
      )
      assert.deepEqual(
        anonymises.map((client) => client.id),
        [PROSPECT, ANCIEN].sort(),
      )
      // L'atelier Durand, créé aujourd'hui : rien ne court encore.
      const [durand] = await asTenant((tx) =>
        lire(tx, sql`select anonymized_at from clients where id = ${DURAND}`),
      )
      assert.equal(durand.anonymized_at, null)
    })
  })

  describe('membres retirés', () => {
    it('anonymise la trace d’un membre retiré au terme de la durée, jamais un membre actif', async () => {
      const retireAncien = uuidv7()
      const retireRecent = uuidv7()
      const parti = uuidv7()
      await asTenant(async (tx) => {
        await tx.execute(sql`
          insert into client_members (id, client_id, email, full_name, deleted_at) values
            (${retireAncien}, ${DURAND}, 'ancien@durand.fr', 'Ancien gérant', date_sub(now(3), interval 13 month)),
            (${retireRecent}, ${DURAND}, 'recent@durand.fr', 'Stagiaire', date_sub(now(3), interval 1 month))`)
        await tx.execute(sql`
          insert into staff_members (id, email, full_name, deleted_at)
          values (${parti}, 'parti@centre.fr', 'Ancienne accueil', date_sub(now(3), interval 24 month))`)
      })

      const [row] = await asTenant((tx) => lire(tx, sql`select anonymize_removed_members() as n`))
      assert.equal(Number(row.n), 2)
      const membres = await asTenant((tx) =>
        lire(
          tx,
          sql`select id, anonymized_at is not null as anonyme, email from client_members
               where id in (${retireAncien}, ${retireRecent}, ${JEANNE})`,
        ),
      )
      const parId = new Map(membres.map((membre) => [membre.id, membre]))
      assert.equal(Boolean(parId.get(retireAncien)?.anonyme), true)
      assert.equal(Boolean(parId.get(retireRecent)?.anonyme), false)
      assert.equal(Boolean(parId.get(JEANNE)?.anonyme), false)
      const [equipe] = await asTenant((tx) =>
        lire(tx, sql`select full_name, anonymized_at from staff_members where id = ${parti}`),
      )
      assert.equal(equipe.full_name, 'Membre anonymisé')

      // À la demande, sans attendre : seulement un membre retiré.
      const il_y_a_deux_jours = addDaysToIsoDate(todayIsoDate('Europe/Paris'), -2)
      await asTenant((tx) =>
        tx.execute(sql`select anonymize_client_member(${retireRecent}, ${ACCUEIL}, 'erasure_request', ${il_y_a_deux_jours})`),
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`select anonymize_client_member(${JEANNE}, ${ACCUEIL}, 'erasure_request', ${il_y_a_deux_jours})`),
          ),
        ),
        DB_ANONYMIZATION_REFUSED,
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`select anonymize_staff_member(${ACCUEIL}, ${ACCUEIL}, 'erasure_request', ${il_y_a_deux_jours})`),
          ),
        ),
        DB_ANONYMIZATION_REFUSED,
      )
      // La nuit trace « au terme », sans auteur ; la demande, son auteur et sa date.
      const traces = await asTenant((tx) =>
        lire(
          tx,
          sql`select id, anonymization_basis, anonymized_by, erasure_requested_on is not null as datee
                from client_members where id in (${retireAncien}, ${retireRecent})`,
        ),
      )
      const trace = new Map(traces.map((ligne) => [ligne.id, ligne]))
      assert.deepEqual(
        { ...trace.get(retireAncien), datee: Boolean(trace.get(retireAncien)?.datee) },
        { id: retireAncien, anonymization_basis: 'retention', anonymized_by: null, datee: false },
      )
      assert.deepEqual(
        { ...trace.get(retireRecent), datee: Boolean(trace.get(retireRecent)?.datee) },
        { id: retireRecent, anonymization_basis: 'erasure_request', anonymized_by: ACCUEIL, datee: true },
      )
    })
  })

  describe('l’indicateur de session', () => {
    it('est remis à NULL après une anonymisation réussie comme après un refus', async () => {
      const lireIndicateur = (tx: Transaction) => lire(tx, sql`select @app_anonymization as drapeau`)
      await asTenant(async (tx) => {
        await tx.execute(sql`select anonymize_client(${PROSPECT_SANS_FACTURE}, ${ACCUEIL}, 'relationship_ended', null)`)
        assert.equal((await lireIndicateur(tx))[0].drapeau, null)
      })
      await factureEmise()
      await asTenant(async (tx) => {
        await assert.rejects(() =>
          tx.execute(sql`select anonymize_client(${DURAND}, ${ACCUEIL}, 'relationship_ended', null)`),
        )
        assert.equal((await lireIndicateur(tx))[0].drapeau, null)
      })
      // La connexion revient au pool : la transaction annulée n'a pas laissé le drapeau.
      await asTenant(async (tx) => {
        assert.equal((await lireIndicateur(tx))[0].drapeau, null)
      })
    })
  })
})
