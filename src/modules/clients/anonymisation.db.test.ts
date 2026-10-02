import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { PG_ANONYMIZATION_REFUSED, pgErrorCode } from '../../db/errors.ts'
import { createDatabase, withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'

/**
 * Anonymisation RGPD (R29, ADR 040), éprouvée contre la base sous le rôle
 * applicatif.
 *
 * Deux choses ne doivent jamais arriver : qu'une entreprise dont la relation
 * vit encore — une facture non soldée, un contrat en cours — soit
 * anonymisée, et qu'une facture émise perde ce qu'elle doit garder dix ans.
 * Rien n'est supprimé : les champs personnels partent, les lignes restent.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('anonymisation RGPD', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const DURAND = '01a00000-0000-7000-8000-000000a90c01'
  const PROSPECT_SANS_FACTURE = '01a00000-0000-7000-8000-000000a90c06'
  const PROSPECT = '01a00000-0000-7000-8000-000000a90c02'
  const ANCIEN = '01a00000-0000-7000-8000-000000a90c03'
  const MANDATE = '01a00000-0000-7000-8000-000000a90c04'
  const JEANNE = '01a00000-0000-7000-8000-000000a90d01'
  const ACCUEIL = '01a00000-0000-7000-8000-000000a90e01'
  const SALLE = '01a00000-0000-7000-8000-000000a90b01'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  const codeErreur = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return pgErrorCode(error)
    }
    return undefined
  }

  const messageErreur = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
        if ((cause as { code?: string }).code === PG_ANONYMIZATION_REFUSED) {
          return (cause as Error).message
        }
      }
      throw error
    }
    return undefined
  }

  /** À la demande : fin de la relation constatée par l'accueil (ADR 041). */
  const anonymiser = (clientId: string) =>
    asTenant((tx) =>
      tx.execute(sql`select anonymize_client(${clientId}::uuid, ${ACCUEIL}::uuid, 'relationship_ended', null)`),
    )

  const bloquants = async (clientId: string): Promise<string[]> => {
    const [row] = await asTenant((tx) =>
      tx.execute(sql`select client_anonymization_blockers(${clientId}::uuid) as raisons`),
    )
    return row.raisons as string[]
  }

  /** Facture émise de 100 € HT à 20 %, pour le client. */
  const factureEmise = async (clientId = DURAND) => {
    const [row] = await asTenant(async (tx) => {
      const [invoice] = await tx.execute(sql`
        insert into invoices (client_id, period_start, period_end)
        values (${clientId}, '2026-09-01', '2026-09-30') returning id`)
      await tx.execute(sql`
        insert into invoice_lines (invoice_id, kind, description, unit_price_cents, vat_rate_bp)
        values (${invoice.id as string}, 'other', 'Prestation', 10000, 2000)`)
      return tx.execute(sql`
        select ${invoice.id as string}::uuid as id, issue_invoice(${invoice.id as string}::uuid, ${ACCUEIL}::uuid) as numero`)
    })
    return { id: row.id as string, numero: row.numero as string }
  }

  const solder = (invoiceId: string) =>
    asTenant((tx) =>
      tx.execute(sql`
        insert into payments (invoice_id, amount_cents, paid_on, method, recorded_by)
        select id, total_incl_tax_cents, '2026-10-01', 'transfer', ${ACCUEIL} from invoices where id = ${invoiceId}`),
    )

  const facture = async (invoiceId: string) => {
    const [row] = await asTenant((tx) =>
      tx.execute(sql`select to_jsonb(i) - 'updated_at' as facture from invoices as i where id = ${invoiceId}`),
    )
    return row.facture as Record<string, unknown>
  }

  const identiteDuCentre = sql`
    update tenants set
      legal_name = 'Centre de démonstration SAS', legal_form = 'SAS', share_capital_cents = 1000000,
      address_line1 = '1 rue de l''Exemple', postal_code = '38070', city = 'Saint-Quentin-Fallavier',
      siren = '123456789', siret = '12345678900012', vat_number = 'FR32123456789', rcs_city = 'Vienne',
      bank_iban = 'FR7630006000011234567890189', bank_bic = 'AGRIFRPP'
    where id = ${DEFAULT_TENANT_ID}`

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`truncate table document_sequences, notification_deliveries`
    await owner.db.execute(identiteDuCentre)
    await owner.client`
      update tenants set prospect_retention_months = 36, client_retention_months = 60,
                         removed_member_retention_months = 12
       where id = ${DEFAULT_TENANT_ID}`
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
    await owner.client`truncate table bookings, contracts, clients, resources, services cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`truncate table document_sequences, notification_deliveries`
    await owner.client`
      update tenants set legal_name = null, legal_form = null, share_capital_cents = null,
        address_line1 = null, postal_code = null, city = null, siren = null, siret = null,
        vat_number = null, rcs_city = null, bank_iban = null, bank_bic = null
      where id = ${DEFAULT_TENANT_ID}`
    await Promise.all([owner.client.end(), app.client.end()])
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
          values (${SALLE}, ${DURAND}, 'staff', now() + interval '2 days', now() + interval '2 days 1 hour', 'Réunion')`)
        await tx.execute(sql`
          insert into invoices (client_id, period_start, period_end) values (${DURAND}, '2026-09-01', '2026-09-30')`)
      })
      assert.equal(await codeErreur(() => anonymiser(DURAND)), PG_ANONYMIZATION_REFUSED)
      assert.deepEqual(await bloquants(DURAND), [
        "Brouillon de facture ou d'avoir à émettre ou à abandonner.",
        'Contrat vivant : DOM-1.',
        'Réservation à venir ou en cours.',
      ])
      // Rien n'a bougé.
      const [row] = await asTenant((tx) => tx.execute(sql`select name, anonymized_at from clients where id = ${DURAND}`))
      assert.equal(row.name, 'Atelier Durand')
      assert.equal(row.anonymized_at, null)
    })

    it('refuse depuis un espace client', async () => {
      assert.equal(
        await codeErreur(() =>
          withClientScope(
            DEFAULT_TENANT_ID,
            [DURAND],
            (tx) => tx.execute(sql`select anonymize_client(${DURAND}::uuid, ${ACCUEIL}::uuid, 'relationship_ended', null)`),
            app.db,
          ),
        ),
        PG_ANONYMIZATION_REFUSED,
      )
    })
  })

  describe('anonymisation d’une entreprise', () => {
    it('efface les champs personnels partout, garde les lignes, ne touche pas aux factures', async () => {
      const { id: factureId, numero } = await factureEmise()
      await solder(factureId)
      const avant = await facture(factureId)
      const [{ n: lignesAvant }] = await asTenant((tx) =>
        tx.execute(sql`select count(*)::int as n from invoice_lines where invoice_id = ${factureId}`),
      )

      await asTenant(async (tx) => {
        await tx.execute(sql`
          insert into contracts (client_id, reference, contract_type, status, starts_on, terminated_on,
                                 termination_reason, notes, amount_cents)
          values (${DURAND}, 'DOM-0', 'domiciliation', 'terminated', '2024-01-01', '2026-06-30',
                  'Départ du gérant à l''étranger', 'Clés rendues par M. Durand', 9000)`)
        await tx.execute(sql`
          insert into bookings (resource_id, client_id, channel, starts_at, ends_at, title, notes,
                                requester_name, requester_email, requester_phone)
          values (${SALLE}, ${DURAND}, 'public', '2026-03-10T08:00:00Z', '2026-03-10T09:00:00Z', 'Réunion',
                  'Rappeler Jean au 06…', 'Jean Durand', 'jean@durand.fr', '0611111111')`)
        const [pli] = await tx.execute(sql`
          insert into mail_items (client_id, sender, note, status, opened_at, opened_by)
          values (${DURAND}, 'Dr Martin', 'Pli personnel', 'opened', now() - interval '1 day', ${ACCUEIL})
          returning id`)
        await tx.execute(sql`
          insert into mail_requests (mail_item_id, client_id, kind, requested_by_member_id,
            forward_recipient, forward_address_line1, forward_postal_code, forward_city, forward_country)
          values (${pli.id as string}, ${DURAND}, 'forward', ${JEANNE}, 'Jeanne Durand', '12 rue des Lilas',
                  '38000', 'Grenoble', 'FR')`)
        await tx.execute(sql`
          update mail_requests set status = 'refused', refused_by_staff_id = ${ACCUEIL}, refusal_reason = 'Adresse incomplète'`)
        await tx.execute(sql`
          insert into notification_deliveries (event, audience, client_id, recipients, subject, status)
          values ('mail_received', 'client', ${DURAND}, '{jeanne@durand.fr}', 'Nouveau courrier pour Atelier Durand', 'sent')`)
      })

      await anonymiser(DURAND)

      const [client] = await asTenant((tx) => tx.execute(sql`select * from clients where id = ${DURAND}`))
      assert.match(client.name as string, /^Client anonymisé /)
      for (const champ of ['siret', 'email', 'phone', 'address_line1', 'postal_code', 'city', 'notes']) {
        assert.equal(client[champ], null, champ)
      }
      assert.equal(client.status, 'inactive')
      assert.ok(client.anonymized_at)
      assert.ok(client.deleted_at)
      // Les écritures comptables passées citent ce compte.
      assert.equal(client.accounting_code, 'DURAND')

      const [contact] = await asTenant((tx) => tx.execute(sql`select * from client_contacts where client_id = ${DURAND}`))
      assert.equal(contact.full_name, 'Contact anonymisé')
      assert.equal(contact.email, null)
      assert.ok(contact.anonymized_at)

      const [acces] = await asTenant((tx) => tx.execute(sql`select * from client_members where id = ${JEANNE}`))
      assert.match(acces.email as string, /@anonymise\.invalid$/)
      assert.equal(acces.auth_user_id, null)
      assert.ok(acces.anonymized_at)

      const [pli] = await asTenant((tx) => tx.execute(sql`select * from mail_items where client_id = ${DURAND}`))
      assert.equal(pli.sender, null)
      assert.equal(pli.note, null)
      assert.ok(pli.sender_anonymized_at)

      const [demande] = await asTenant((tx) => tx.execute(sql`select * from mail_requests where client_id = ${DURAND}`))
      assert.equal(demande.forward_recipient, 'Destinataire anonymisé')
      assert.equal(demande.status, 'refused')

      const [reservation] = await asTenant((tx) =>
        tx.execute(sql`select * from bookings where client_id = ${DURAND} and kind = 'booking'`),
      )
      assert.equal(reservation.requester_name, null)
      assert.equal(reservation.notes, null)
      assert.ok(reservation.requester_anonymized_at)
      assert.equal(reservation.title, 'Réunion')

      const [contrat] = await asTenant((tx) => tx.execute(sql`select * from contracts where client_id = ${DURAND}`))
      assert.equal(contrat.notes, null)
      assert.equal(contrat.termination_reason, null)
      assert.equal(contrat.reference, 'DOM-0')

      const [message] = await asTenant((tx) =>
        tx.execute(sql`select recipients, subject from notification_deliveries where client_id = ${DURAND}`),
      )
      assert.deepEqual(message.recipients, ['destinataire@anonymise.invalid'])

      // La facture, ses lignes et son instantané d'acheteur : intacts.
      const apres = await facture(factureId)
      assert.deepEqual(apres, avant)
      assert.equal(apres.number, numero)
      assert.equal((apres.buyer_snapshot as { name: string }).name, 'Atelier Durand')
      const [{ n: lignesApres }] = await asTenant((tx) =>
        tx.execute(sql`select count(*)::int as n from invoice_lines where invoice_id = ${factureId}`),
      )
      assert.equal(lignesApres, lignesAvant)
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
        tx.execute(sql`select id, accounting_code from clients where id in (${SOCIETE}, ${PROSPECT_SANS_FACTURE})`),
      )
      const codes = new Map(rows.map((row) => [row.id, row.accounting_code]))
      // Celui que l'export lui donnait (`deriveAccountingCode`) : les exports passés ne bougent pas.
      assert.equal(codes.get(SOCIETE), 'SOCIETEGENERALEDE')
      // Jamais facturé : aucun compte à garder.
      assert.equal(codes.get(PROSPECT_SANS_FACTURE), null)
      // Le compte saisi sur une fiche reste le sien.
      await anonymiser(DURAND)
      const [durand] = await asTenant((tx) => tx.execute(sql`select accounting_code from clients where id = ${DURAND}`))
      assert.equal(durand.accounting_code, 'DURAND')
    })

    it('fige une fiche anonymisée, et l’anonymisation ne s’écrit pas à la main', async () => {
      await anonymiser(DURAND)
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => tx.execute(sql`update clients set name = 'Atelier Durand' where id = ${DURAND}`)),
        ),
        PG_ANONYMIZATION_REFUSED,
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => tx.execute(sql`update clients set anonymized_at = null where id = ${DURAND}`)),
        ),
        PG_ANONYMIZATION_REFUSED,
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              insert into clients (name, anonymized_at, deleted_at) values ('Faux', now(), now())`),
          ),
        ),
        PG_ANONYMIZATION_REFUSED,
      )
      // Une seconde fois : refusée, la fiche l'est déjà.
      assert.equal(await codeErreur(() => anonymiser(DURAND)), PG_ANONYMIZATION_REFUSED)
    })
  })

  describe('au terme des durées du centre', () => {
    it('date la fin de la relation à la dernière activité de l’entreprise', async () => {
      await asTenant(async (tx) => {
        await tx.execute(sql`
          insert into clients (id, name, status, created_at) values (${ANCIEN}, 'Ancien client', 'inactive', '2019-01-01')`)
        await tx.execute(sql`
          insert into bookings (resource_id, client_id, channel, starts_at, ends_at, title)
          values (${SALLE}, ${ANCIEN}, 'staff', '2024-03-10T08:00:00Z', '2024-03-10T09:00:00Z', 'Réunion')`)
        await tx.execute(sql`
          insert into mail_items (client_id, received_at) values (${ANCIEN}, '2025-02-01T09:00:00Z')`)
      })
      const [row] = await asTenant((tx) =>
        tx.execute(sql`select client_last_activity_on(${ANCIEN}::uuid)::text as jour`),
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
          values ('Prospect suivi', 'prospect', '2020-01-01', current_date - 30)`)
        await tx.execute(sql`
          insert into contracts (client_id, reference, contract_type, status, starts_on, terminated_on, amount_cents)
          values (${ANCIEN}, 'BUR-0', 'bureau', 'terminated', '2018-01-01', '2020-06-30', 90000)`)
        await tx.execute(sql`
          insert into sepa_mandates (client_id, reference, debtor_name, iban_ciphertext, iban_key_version,
                                     iban_last4, signed_on)
          values (${MANDATE}, 'RUM-OUBLI', 'Titulaire', decode('43414431' || repeat('00', 45), 'hex'), 1,
                  '0189', '2015-01-01')`)
      })
      const [row] = await asTenant((tx) => tx.execute(sql`select anonymize_expired_clients() as n`))
      assert.equal(row.n, 2)
      const anonymises = await asTenant((tx) =>
        tx.execute(sql`select id from clients where anonymized_at is not null order by id`),
      )
      assert.deepEqual(
        anonymises.map((client) => client.id),
        [PROSPECT, ANCIEN].sort(),
      )
      // L'atelier Durand, créé aujourd'hui : rien ne court encore.
      const [durand] = await asTenant((tx) => tx.execute(sql`select anonymized_at from clients where id = ${DURAND}`))
      assert.equal(durand.anonymized_at, null)
    })
  })

  describe('membres retirés', () => {
    it('anonymise la trace d’un membre retiré au terme de la durée, jamais un membre actif', async () => {
      const [retireAncien, retireRecent, parti] = await asTenant(async (tx) => {
        const lignes = await tx.execute(sql`
          insert into client_members (client_id, email, full_name, deleted_at) values
            (${DURAND}, 'ancien@durand.fr', 'Ancien gérant', now() - interval '13 months'),
            (${DURAND}, 'recent@durand.fr', 'Stagiaire', now() - interval '1 month')
          returning id`)
        const [staff] = await tx.execute(sql`
          insert into staff_members (email, full_name, deleted_at)
          values ('parti@centre.fr', 'Ancienne accueil', now() - interval '2 years') returning id`)
        return [lignes[0].id as string, lignes[1].id as string, staff.id as string]
      })

      const [row] = await asTenant((tx) => tx.execute(sql`select anonymize_removed_members() as n`))
      assert.equal(row.n, 2)
      const membres = await asTenant((tx) =>
        tx.execute(sql`
          select id, anonymized_at is not null as anonyme, email from client_members
           where id in (${retireAncien}, ${retireRecent}, ${JEANNE})`),
      )
      const parId = new Map(membres.map((membre) => [membre.id, membre]))
      assert.equal(parId.get(retireAncien)?.anonyme, true)
      assert.equal(parId.get(retireRecent)?.anonyme, false)
      assert.equal(parId.get(JEANNE)?.anonyme, false)
      const [equipe] = await asTenant((tx) =>
        tx.execute(sql`select full_name, anonymized_at from staff_members where id = ${parti}`),
      )
      assert.equal(equipe.full_name, 'Membre anonymisé')

      // À la demande, sans attendre : seulement un membre retiré.
      const aLaDemande = sql`${ACCUEIL}::uuid, 'erasure_request', current_date - 2`
      await asTenant((tx) => tx.execute(sql`select anonymize_client_member(${retireRecent}::uuid, ${aLaDemande})`))
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => tx.execute(sql`select anonymize_client_member(${JEANNE}::uuid, ${aLaDemande})`)),
        ),
        PG_ANONYMIZATION_REFUSED,
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => tx.execute(sql`select anonymize_staff_member(${ACCUEIL}::uuid, ${aLaDemande})`)),
        ),
        PG_ANONYMIZATION_REFUSED,
      )
      // La nuit trace « au terme », sans auteur ; la demande, son auteur et sa date.
      const traces = await asTenant((tx) =>
        tx.execute(sql`
          select id, anonymization_basis, anonymized_by, erasure_requested_on is not null as datee
            from client_members where id in (${retireAncien}, ${retireRecent})`),
      )
      const trace = new Map(traces.map((row) => [row.id, row]))
      assert.deepEqual(
        { ...trace.get(retireAncien) },
        { id: retireAncien, anonymization_basis: 'retention', anonymized_by: null, datee: false },
      )
      assert.deepEqual(
        { ...trace.get(retireRecent) },
        { id: retireRecent, anonymization_basis: 'erasure_request', anonymized_by: ACCUEIL, datee: true },
      )
    })
  })
})
