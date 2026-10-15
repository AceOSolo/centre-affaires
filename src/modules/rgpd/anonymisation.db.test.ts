import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { eq, sql } from 'drizzle-orm'

import { DB_CHECK_VIOLATION, dbErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID, tenants } from '../../db/tenants.ts'
import { addDaysToIsoDate, todayIsoDate } from '../../lib/dates.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { lire, sansTriggers, toutVider } from '../clients/test-support.ts'
import {
  anonymizeClientMemberOnRequest,
  anonymizeClientOnRequest,
  anonymizeExpiredClients,
  anonymizeRemovedMembers,
  anonymizeStaffMemberOnRequest,
  readAnonymizationOutlook,
  readClientRetention,
  readRemovedClientMembers,
  readRemovedStaffMembers,
  writeLastContact,
} from './anonymisation.ts'
import { parseRetentionDurations, retentionDurations, retentionValues, type RetentionDurations } from './durees.ts'

/**
 * Anonymisation RGPD côté application (R29, ADR 040), contre la base sous
 * l'identité applicative : la tâche de nuit, l'anonymisation à la demande et
 * son refus motivé, la date de dernier contact, les personnes retirées, les
 * bornes des durées.
 *
 * Les règles elles-mêmes (ce qui part, ce qui reste) sont éprouvées en SQL
 * par `src/modules/clients/anonymisation.db.test.ts` ; ici, ce que le code en
 * fait et ce qu'il en rapporte.
 */
describe('anonymisation RGPD, côté application', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const DURAND = '01a00000-0000-7000-8000-000000b90c01'
  const PROSPECT = '01a00000-0000-7000-8000-000000b90c02'
  const ANCIEN = '01a00000-0000-7000-8000-000000b90c03'
  const IMPAYE = '01a00000-0000-7000-8000-000000b90c04'
  const MANDAT = '01a00000-0000-7000-8000-000000b90c05'
  const JEANNE = '01a00000-0000-7000-8000-000000b90d01'
  const ACCUEIL = '01a00000-0000-7000-8000-000000b90e01'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  /** Demande d'effacement reçue il y a trois jours, traitée par l'accueil (ADR 041). */
  const RECUE_LE = addDaysToIsoDate(todayIsoDate('Europe/Paris'), -3)
  const effacement = { staffMemberId: ACCUEIL, basis: 'erasure_request' as const, erasureRequestedOn: RECUE_LE }

  const defauts: RetentionDurations = Object.fromEntries(
    retentionDurations.map((duration) => [duration.key, duration.defaultMonths]),
  ) as RetentionDurations

  /** `2020-01-01T09:00:00Z` en littéral `datetime` (MySQL n'admet pas le `Z`). */
  const instant = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$|Z$/, '')

  /** Les lignes d'une requête brute sur la connexion du propriétaire. */
  const lireOwner = async (requete: string, params: unknown[] = []) => {
    const [rows] = await bases.owner.client.query(requete, params)
    return rows as Record<string, unknown>[]
  }

  /** Une entreprise avec une adresse : l'émission d'une facture l'exige. */
  const entreprise = (id: string, name: string, status: string, createdAt: string) =>
    asTenant((tx) =>
      tx.execute(sql`
        insert into clients (id, name, status, created_at, email, address_line1, postal_code, city, notes)
        values (${id}, ${name}, ${status}, ${instant(createdAt)},
                ${`contact@${id.slice(-4)}.fr`}, '2 place du Marché', '38000', 'Grenoble', 'Note personnelle')`),
    )

  /** Facture de 100 € HT émise pour le client ; rend son identifiant et son numéro. */
  const factureEmise = async (clientId: string) => {
    const id = uuidv7()
    const numero = await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into invoices (id, client_id, period_start, period_end)
        values (${id}, ${clientId}, '2020-06-01', '2020-06-30')`)
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
        values (${invoiceId}, ${Number(facture.total)}, curdate(), 'transfer', ${ACCUEIL})`)
    })

  /**
   * Antidate une facture émise et ses paiements, comme si elle datait de
   * l'été 2020. Une facture émise est figée (CA002) : seul le propriétaire,
   * déclencheurs retirés le temps de l'écriture, peut réécrire l'histoire —
   * pour le test.
   */
  const antidater = (invoiceId: string) =>
    sansTriggers(bases.owner, ['invoices', 'invoice_lines', 'payments'], async (connection) => {
      await connection.query(
        `update invoices set issue_date = '2020-07-01', issued_at = '2020-07-01 08:00:00',
                             due_date = '2020-07-31'
          where id = ?`,
        [invoiceId],
      )
      await connection.query(`update payments set paid_on = '2020-07-15' where invoice_id = ?`, [invoiceId])
    })

  /** La facture telle qu'en base, hors `updated_at`, avec ses lignes et ses paiements. */
  const pieces = async (invoiceId: string) => {
    const sans = (rows: Record<string, unknown>[]) =>
      rows.map(({ updated_at: _ignore, ...reste }) => ({ ...reste }))
    const [facture] = sans(await lireOwner('select * from invoices where id = ?', [invoiceId]))
    const lignes = sans(await lireOwner('select * from invoice_lines where invoice_id = ? order by id', [invoiceId]))
    const paiements = sans(await lireOwner('select * from payments where invoice_id = ? order by id', [invoiceId]))
    return { facture, lignes, paiements }
  }

  const anonymisee = async (clientId: string) => {
    const [row] = await lireOwner('select anonymized_at from clients where id = ?', [clientId])
    return (row.anonymized_at as Date | null) ?? null
  }

  const identiteDuCentre = sql`
    update tenants set
      legal_name = 'Centre de démonstration SAS', legal_form = 'SAS', share_capital_cents = 1000000,
      address_line1 = '1 rue de l''Exemple', postal_code = '38070', city = 'Saint-Quentin-Fallavier',
      siren = '123456789', siret = '12345678900012', vat_number = 'FR32123456789', rcs_city = 'Vienne',
      bank_iban = 'FR7630006000011234567890189', bank_bic = 'AGRIFRPP'
    where id = ${DEFAULT_TENANT_ID}`

  const restaurerDurees = () =>
    bases.owner.db.update(tenants).set(defauts).where(eq(tenants.id, DEFAULT_TENANT_ID))

  before(async () => {
    bases = await ouvrirBasesDeTest()
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await bases.owner.db.execute(identiteDuCentre)
    await restaurerDurees()
    await asTenant((tx) =>
      tx.execute(sql`insert into staff_members (id, email, full_name) values (${ACCUEIL}, 'accueil@centre.fr', 'Camille Accueil')`),
    )
    await entreprise(DURAND, 'Atelier Durand', 'active', new Date().toISOString())
    await asTenant((tx) =>
      tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id)
        values (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand', 'u-jeanne')`),
    )
  })

  after(async () => {
    await toutVider(bases.owner)
    await restaurerDurees()
    await bases.owner.client.query(
      `update tenants set legal_name = null, legal_form = null, share_capital_cents = null,
        address_line1 = null, postal_code = null, city = null, siren = null, siret = null,
        vat_number = null, rcs_city = null, bank_iban = null, bank_bic = null
      where id = ?`,
      [DEFAULT_TENANT_ID],
    )
    await bases.fermer()
  })

  describe('tâche de nuit', () => {
    /**
     * Un prospect oublié depuis 2020, un client parti en 2020 dont la facture
     * est soldée, deux anciens clients retenus par une exclusion (facture
     * impayée, mandat actif), et l'atelier Durand, actif.
     */
    const anciens = async () => {
      await entreprise(PROSPECT, 'Prospect oublié', 'prospect', '2020-01-01T09:00:00Z')
      await entreprise(ANCIEN, 'Ancien client', 'inactive', '2015-01-01T09:00:00Z')
      await entreprise(IMPAYE, 'Client impayé', 'inactive', '2015-01-01T09:00:00Z')
      await entreprise(MANDAT, 'Client au mandat', 'inactive', '2015-01-01T09:00:00Z')
      await asTenant(async (tx) => {
        await tx.execute(sql`
          insert into client_contacts (client_id, full_name, email, is_primary)
          values (${PROSPECT}, 'Paul Prospect', 'paul@prospect.fr', true)`)
        await tx.execute(sql`
          insert into mail_items (client_id, sender, note, received_at)
          values (${ANCIEN}, 'Dr Martin', 'Pli personnel', '2020-02-01 09:00:00')`)
        await tx.execute(sql`
          insert into client_members (client_id, email, full_name, auth_user_id)
          values (${ANCIEN}, 'gerant@ancien.fr', 'Gérant parti', 'u-ancien')`)
        await tx.execute(sql`
          insert into contracts (client_id, reference, contract_type, status, starts_on, terminated_on, amount_cents)
          values (${ANCIEN}, 'BUR-0', 'bureau', 'terminated', '2018-01-01', '2020-06-30', 90000)`)
        await tx.execute(sql`
          insert into sepa_mandates (client_id, reference, debtor_name, iban_ciphertext, iban_key_version,
                                     iban_last4, signed_on)
          values (${MANDAT}, 'RUM-OUBLI', 'Titulaire', unhex(concat('43414431', repeat('00', 45))), 1,
                  '0189', '2015-01-01')`)
      })
      const soldee = await factureEmise(ANCIEN)
      await solder(soldee.id)
      await antidater(soldee.id)
      const impayee = await factureEmise(IMPAYE)
      await antidater(impayee.id)
      return { soldee, impayee }
    }

    it('anonymise au terme des durées, passe les exclusions, et ne rapporte que des nombres', async () => {
      const { soldee, impayee } = await anciens()
      const avant = await pieces(soldee.id)

      const rapport = await asTenant(anonymizeExpiredClients)
      assert.deepEqual(rapport, { clients: 2, contacts: 1, accesses: 1, mailSenders: 1 })

      assert.ok(await anonymisee(PROSPECT))
      assert.ok(await anonymisee(ANCIEN))
      // Exclusions : facture non soldée, mandat actif.
      assert.equal(await anonymisee(IMPAYE), null)
      assert.equal(await anonymisee(MANDAT), null)
      // Relation en cours : rien ne court encore.
      assert.equal(await anonymisee(DURAND), null)

      // Les pièces comptables du client parti : intactes, instantané compris.
      const apres = await pieces(soldee.id)
      assert.deepEqual(apres, avant)
      const instantane = apres.facture.buyer_snapshot
      const acheteur = (typeof instantane === 'string' ? JSON.parse(instantane) : instantane) as { name: string }
      assert.equal(acheteur.name, 'Ancien client')
      const [impayeeApres] = await lireOwner('select status, number from invoices where id = ?', [impayee.id])
      assert.equal(impayeeApres.number, impayee.numero)
    })

    it('est idempotente : un second passage ne trouve rien et ne réécrit rien', async () => {
      await anciens()
      await asTenant(anonymizeExpiredClients)
      const [premier] = await lireOwner('select anonymized_at, name from clients where id = ?', [ANCIEN])

      const second = await asTenant(anonymizeExpiredClients)
      assert.deepEqual(second, { clients: 0, contacts: 0, accesses: 0, mailSenders: 0 })
      const [ensuite] = await lireOwner('select anonymized_at, name from clients where id = ?', [ANCIEN])
      assert.deepEqual({ ...ensuite }, { ...premier })
    })

    it('annonce à l’écran ce que la nuit fera, exclusions nommées', async () => {
      await anciens()
      await asTenant((tx) =>
        tx.execute(sql`
          insert into staff_members (email, full_name, deleted_at)
          values ('parti@centre.fr', 'Ancienne accueil', date_sub(now(3), interval 24 month))`),
      )
      const prevision = await asTenant((tx) => readAnonymizationOutlook(tx))
      assert.equal(prevision.clients, 2)
      assert.equal(prevision.members, 1)
      assert.equal(prevision.held, 2)
      assert.deepEqual(
        prevision.heldClients.map((client) => client.name),
        ['Client au mandat', 'Client impayé'],
      )
      assert.deepEqual(prevision.heldClients[0].blockers, ['Mandat de prélèvement actif.'])
      assert.match(prevision.heldClients[1].blockers[0], /^Facture non soldée : /)

      // La nuit fait ce qui était annoncé.
      assert.equal((await asTenant(anonymizeExpiredClients)).clients, prevision.clients)
      assert.equal(
        Object.values(await asTenant(anonymizeRemovedMembers)).reduce((a, b) => a + b, 0),
        prevision.members,
      )
    })

    it('suit les durées du centre : un prospect plus récent attend la sienne', async () => {
      await entreprise(PROSPECT, 'Prospect de l’an dernier', 'prospect', '2025-06-01T09:00:00Z')
      assert.equal((await asTenant(anonymizeExpiredClients)).clients, 0)
      await bases.owner.client.query('update tenants set prospect_retention_months = 3 where id = ?', [
        DEFAULT_TENANT_ID,
      ])
      assert.equal((await asTenant(anonymizeExpiredClients)).clients, 1)
    })
  })

  describe('à la demande', () => {
    it('refuse en nommant les exclusions et ce qu’il faut faire, sans rien changer', async () => {
      const { id, numero } = await factureEmise(DURAND)
      const avant = await lireOwner('select * from clients where id = ?', [DURAND])

      const refus = await anonymizeClientOnRequest(DURAND, effacement, bases.app.db)
      assert.equal(refus.ok, false)
      const reason = refus.ok ? '' : refus.reason
      assert.match(reason, /^Anonymisation refusée : /)
      assert.ok(reason.includes(`Facture non soldée : ${numero}.`), reason)
      assert.ok(reason.includes('Soldez'), reason)
      assert.deepEqual(await lireOwner('select * from clients where id = ?', [DURAND]), avant)

      await solder(id)
      const avantPieces = await pieces(id)
      assert.deepEqual(await anonymizeClientOnRequest(DURAND, effacement, bases.app.db), { ok: true })
      assert.ok(await anonymisee(DURAND))
      assert.deepEqual(await pieces(id), avantPieces)

      // Le fondement, sa date et son auteur restent sur la fiche (ADR 041).
      const [trace] = await lireOwner(
        `select anonymization_basis, cast(erasure_requested_on as char) as recue_le, anonymized_by
           from clients where id = ?`,
        [DURAND],
      )
      assert.deepEqual(
        { ...trace },
        { anonymization_basis: 'erasure_request', recue_le: RECUE_LE, anonymized_by: ACCUEIL },
      )

      // Une seconde fois : la fiche l'est déjà.
      const encore = await anonymizeClientOnRequest(DURAND, effacement, bases.app.db)
      assert.equal(encore.ok, false)
      assert.match(encore.ok ? '' : encore.reason, /Fiche déjà anonymisée/)
    })

    it('énumère toutes les exclusions, même quand le message de la base est abrégé', async () => {
      // Plus de 128 caractères d'exclusions : le `SIGNAL` de la base est tronqué,
      // la raison rendue reste complète.
      await asTenant(async (tx) => {
        await tx.execute(sql`
          insert into contracts (client_id, reference, contract_type, status, starts_on, amount_cents) values
            (${DURAND}, 'CONTRAT-LONG-REFERENCE-001', 'domiciliation', 'active', '2026-01-01', 9000),
            (${DURAND}, 'CONTRAT-LONG-REFERENCE-002', 'bureau', 'active', '2026-01-01', 9000)`)
        await tx.execute(sql`
          insert into invoices (client_id, period_start, period_end) values (${DURAND}, '2026-09-01', '2026-09-30')`)
      })
      const refus = await anonymizeClientOnRequest(DURAND, effacement, bases.app.db)
      assert.equal(refus.ok, false)
      const reason = refus.ok ? '' : refus.reason
      assert.ok(reason.includes('CONTRAT-LONG-REFERENCE-001, CONTRAT-LONG-REFERENCE-002'), reason)
      assert.ok(reason.includes('Brouillon de facture'), reason)
      assert.ok(reason.includes('Soldez'), reason)
    })

    it('n’anonymise un accès ou un membre de l’équipe que retiré', async () => {
      const actif = await anonymizeClientMemberOnRequest(JEANNE, effacement, bases.app.db)
      assert.equal(actif.ok, false)
      assert.match(actif.ok ? '' : actif.reason, /retirez-le d’abord|retirez-le d'abord/)
      assert.equal((await anonymizeStaffMemberOnRequest(ACCUEIL, effacement, bases.app.db)).ok, false)

      await asTenant((tx) => tx.execute(sql`update client_members set deleted_at = now(3) where id = ${JEANNE}`))
      const [retire] = await asTenant((tx) => readRemovedClientMembers(tx, DURAND))
      assert.equal(retire.anonymizedAt, null)
      assert.equal(retire.email, 'jeanne@durand.fr')
      // Douze mois après le retrait, par défaut.
      const ecart = retire.dueAfter.getTime() - retire.removedAt.getTime()
      assert.ok(ecart > 364 * 86_400_000 && ecart < 367 * 86_400_000, String(ecart))

      assert.deepEqual(await anonymizeClientMemberOnRequest(JEANNE, effacement, bases.app.db), { ok: true })
      const [anonyme] = await asTenant((tx) => readRemovedClientMembers(tx, DURAND))
      assert.ok(anonyme.anonymizedAt)
      assert.equal(anonyme.fullName, 'Personne anonymisée')
      assert.match(anonyme.email, /@anonymise\.invalid$/)
      assert.equal(anonyme.anonymizationBasis, 'erasure_request')
      assert.equal(anonyme.erasureRequestedOn, RECUE_LE)
      assert.ok(anonyme.anonymizedByName)
    })

    it('refuse une anonymisation à la demande sans fondement, sans auteur ou datée d’un jour à venir', async () => {
      await asTenant((tx) => tx.execute(sql`update client_members set deleted_at = now(3) where id = ${JEANNE}`))
      const demain = addDaysToIsoDate(todayIsoDate('Europe/Paris'), 1)
      const refus = [
        { ...effacement, erasureRequestedOn: null },
        { ...effacement, erasureRequestedOn: demain },
        { ...effacement, basis: 'retention' as unknown as 'erasure_request' },
        { ...effacement, staffMemberId: JEANNE },
        { staffMemberId: ACCUEIL, basis: 'relationship_ended' as const, erasureRequestedOn: RECUE_LE },
      ]
      for (const request of refus) {
        const outcome = await anonymizeClientMemberOnRequest(JEANNE, request, bases.app.db)
        assert.equal(outcome.ok, false, JSON.stringify(request))
      }
      assert.deepEqual(
        await anonymizeClientMemberOnRequest(
          JEANNE,
          { staffMemberId: ACCUEIL, basis: 'relationship_ended', erasureRequestedOn: null },
          bases.app.db,
        ),
        { ok: true },
      )
      const [anonyme] = await asTenant((tx) => readRemovedClientMembers(tx, DURAND))
      assert.equal(anonyme.anonymizationBasis, 'relationship_ended')
      assert.equal(anonyme.erasureRequestedOn, null)
    })
  })

  describe('membres retirés, la nuit', () => {
    it('compte séparément les accès et l’équipe, une seule fois', async () => {
      await asTenant(async (tx) => {
        await tx.execute(sql`
          insert into client_members (client_id, email, full_name, deleted_at) values
            (${DURAND}, 'ancien@durand.fr', 'Ancien gérant', date_sub(now(3), interval 13 month)),
            (${DURAND}, 'recent@durand.fr', 'Stagiaire', date_sub(now(3), interval 1 month))`)
        await tx.execute(sql`
          insert into staff_members (email, full_name, deleted_at)
          values ('parti@centre.fr', 'Ancienne accueil', date_sub(now(3), interval 24 month))`)
      })
      assert.deepEqual(await asTenant(anonymizeRemovedMembers), { accesses: 1, staff: 1 })
      assert.deepEqual(await asTenant(anonymizeRemovedMembers), { accesses: 0, staff: 0 })

      const equipe = await asTenant(readRemovedStaffMembers)
      assert.equal(equipe.length, 1)
      assert.equal(equipe[0].fullName, 'Membre anonymisé')
      assert.ok(equipe[0].anonymizedAt)
    })
  })

  describe('dernier contact et date d’anonymisation', () => {
    it('date l’échéance de la dernière activité, et un contact noté la repousse', async () => {
      await entreprise(PROSPECT, 'Prospect rappelé', 'prospect', '2020-01-01T09:00:00Z')
      const avant = await asTenant((tx) => readClientRetention(tx, PROSPECT))
      assert.deepEqual(avant, {
        lastActivityOn: '2020-01-01',
        retentionMonths: 36,
        dueAfter: '2023-01-01',
        blockers: [],
      })

      const [{ jour }] = await lireOwner(
        'select cast(date_sub(curdate(), interval 30 day) as char) as jour',
      )
      assert.equal(await asTenant((tx) => writeLastContact(tx, PROSPECT, jour as string)), true)
      const apres = await asTenant((tx) => readClientRetention(tx, PROSPECT))
      assert.equal(apres?.lastActivityOn, jour)
      assert.ok((apres?.dueAfter ?? '') > (jour as string))
      assert.equal((await asTenant(anonymizeExpiredClients)).clients, 0)

      // Une fiche anonymisée ne se touche plus.
      await bases.owner.client.query('update clients set last_contact_on = null where id = ?', [PROSPECT])
      assert.equal((await asTenant(anonymizeExpiredClients)).clients, 1)
      assert.equal(await asTenant((tx) => writeLastContact(tx, PROSPECT, jour as string)), false)
    })

    it('rend les exclusions d’une entreprise, en phrases', async () => {
      const { numero } = await factureEmise(DURAND)
      const situation = await asTenant((tx) => readClientRetention(tx, DURAND))
      assert.deepEqual(situation?.blockers, [`Facture non soldée : ${numero}.`])
      assert.equal(situation?.retentionMonths, 60)
    })
  })

  describe('durées du centre', () => {
    it('l’écran et la base ont les mêmes bornes', async () => {
      try {
        for (const { key } of retentionDurations) {
          for (const months of [0, 121]) {
            const ecran = parseRetentionDurations({ ...retentionValues(defauts), [key]: String(months) })
            assert.equal(ecran.ok, false, `${key} = ${months}`)
            let code: string | undefined
            try {
              const update: Partial<typeof tenants.$inferInsert> = { [key]: months }
              await asTenant((tx) => tx.update(tenants).set(update).where(eq(tenants.id, DEFAULT_TENANT_ID)))
            } catch (error) {
              code = dbErrorCode(error)
            }
            assert.equal(code, DB_CHECK_VIOLATION, `${key} = ${months}`)
          }
          for (const months of [1, 120]) {
            const ecran = parseRetentionDurations({ ...retentionValues(defauts), [key]: String(months) })
            assert.ok(ecran.ok, `${key} = ${months}`)
            await asTenant((tx) => tx.update(tenants).set(ecran.update).where(eq(tenants.id, DEFAULT_TENANT_ID)))
          }
        }
      } finally {
        await restaurerDurees()
      }
    })
  })
})
