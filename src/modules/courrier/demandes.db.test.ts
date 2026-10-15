import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import {
  DB_CHECK_VIOLATION,
  DB_INSUFFICIENT_PRIVILEGE,
  DB_INVOICE_INVALID,
  DB_MAIL_REQUEST_REFUSED,
  DB_UNIQUE_VIOLATION,
  dbErrorCode,
} from '../../db/errors.ts'
import { withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { listRequestsForAccounts } from './demandes-queries.ts'
import { cancelOpeningRequest, requestOpening } from './queries.ts'

/**
 * Demandes de courrier (R21, R24, ADR 037), éprouvées contre la base, sous
 * l'identité applicative.
 *
 * Trois garanties : un pli reçoit plusieurs demandes dans le temps, chacune
 * gardée — une annulation ne l'efface pas ; les transitions et leurs auteurs
 * sont tenus par la base ; une demande faite se facture une fois, et une
 * demande refusée jamais.
 */
describe('demandes de courrier', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const DURAND = '01a00000-0000-7000-8000-0000000d0c01'
  const PETIT = '01a00000-0000-7000-8000-0000000d0c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000d0d01'
  const PAUL = '01a00000-0000-7000-8000-0000000d0d02'
  const CAMILLE = '01a00000-0000-7000-8000-0000000d0e01'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)
  const asClients = <T>(clientIds: string[], run: (tx: Transaction) => Promise<T>) =>
    withClientScope(DEFAULT_TENANT_ID, clientIds, run, bases.app.db)

  /** Les lignes d'une requête : `execute` rend `[lignes, champs]` sous mysql2. */
  const lire = async (tx: Transaction, requete: ReturnType<typeof sql>) =>
    ((await tx.execute(requete)) as unknown as [Record<string, unknown>[]])[0]

  /** MySQL lit `2026-09-02 08:00:00.000`, pas le format ISO avec `T` et `Z`. */
  /** Une date lue en SQL brut est une chaîne UTC sans fuseau (ou un Date) : ISO. */
  const utc = (value: unknown) =>
    (value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`)).toISOString()
  const datetime = (iso: string) => iso.replace('T', ' ').replace('Z', '')

  const codeErreur = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  /** Un pli de l'entreprise, fermé ou ouvert par l'accueil. */
  const pli = async (clientId = DURAND, { ouvert = false } = {}): Promise<string> => {
    const id = uuidv7()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into mail_items (id, client_id, sender, status, opened_at, opened_by)
        values (${id}, ${clientId}, 'URSSAF', ${ouvert ? 'opened' : 'received'},
                ${ouvert ? sql`CURRENT_TIMESTAMP(3)` : null}, ${ouvert ? CAMILLE : null})`),
    )
    return id
  }

  const ADRESSE = sql`'Jeanne Durand', '12 rue des Lilas', '38000', 'Grenoble', 'FR'`

  /** Demande déposée par Jeanne, depuis l'espace client de Durand. */
  const demander = async (mailItemId: string, kind: 'open_and_scan' | 'scan' | 'forward') => {
    const id = uuidv7()
    await asClients([DURAND], (tx) =>
      kind === 'forward'
        ? tx.execute(sql`
            insert into mail_requests (id, mail_item_id, client_id, kind, requested_by_member_id,
              forward_recipient, forward_address_line1, forward_postal_code, forward_city, forward_country)
            values (${id}, ${mailItemId}, ${DURAND}, 'forward', ${JEANNE}, ${ADRESSE})`)
        : tx.execute(sql`
            insert into mail_requests (id, mail_item_id, client_id, kind, requested_by_member_id)
            values (${id}, ${mailItemId}, ${DURAND}, ${kind}, ${JEANNE})`),
    )
    return id
  }

  /** L'accueil fait la demande : prise en charge, puis réalisation. */
  const faire = async (id: string, postageCents: number | null = null) => {
    await asTenant((tx) =>
      tx.execute(sql`update mail_requests set status = 'in_progress', started_by_staff_id = ${CAMILLE} where id = ${id}`),
    )
    await asTenant((tx) =>
      tx.execute(sql`
        update mail_requests
           set status = 'done', completed_by_staff_id = ${CAMILLE},
               postage_cents = ${postageCents}, postage_currency = ${postageCents === null ? null : 'EUR'}
         where id = ${id}`),
    )
  }

  const demande = async (id: string) => {
    const [row] = await asTenant((tx) => lire(tx, sql`select * from mail_requests where id = ${id}`))
    return row
  }

  const resume = async (mailItemId: string) => {
    const [row] = await asTenant((tx) =>
      lire(tx, sql`
        select status, opening_requested_at, opening_requested_by from mail_items where id = ${mailItemId}`),
    )
    return row
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    // Les requêtes du module passent par la base globale : l'identité
    // applicative de la base de test.
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await viderTables(
      bases.owner,
      'invoice_lines',
      'invoices',
      'mail_scan_views',
      'mail_scans',
      'mail_requests',
      'mail_items',
      'client_members',
      'clients',
      'services',
      'staff_members',
    )
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Boulangerie Petit', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand', 'u-jeanne'),
          (${PAUL}, ${PETIT}, 'paul@petit.fr', 'Paul Petit', 'u-paul')`)
      await tx.execute(sql`insert into staff_members (id, email) values (${CAMILLE}, 'camille@centre.fr')`)
    })
  })

  after(async () => {
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  describe('plusieurs demandes par pli, dans le temps', () => {
    it('ouvre, puis numérise de nouveau, puis réexpédie le même pli, chaque demande gardée', async () => {
      const id = await pli()
      const ouverture = await demander(id, 'open_and_scan')
      assert.equal((await resume(id)).status, 'opening_requested')
      assert.equal((await resume(id)).opening_requested_by, JEANNE)

      // L'accueil ouvre le pli : la demande d'ouverture est faite, à son nom.
      await asTenant((tx) =>
        tx.execute(sql`
          update mail_items set status = 'opened', opened_at = CURRENT_TIMESTAMP(3), opened_by = ${CAMILLE} where id = ${id}`),
      )
      const ouverte = await demande(ouverture)
      assert.equal(ouverte.status, 'done')
      assert.equal(ouverte.completed_by_staff_id, CAMILLE)

      await faire(await demander(id, 'scan'))
      await faire(await demander(id, 'forward'), 450)

      const historique = await asTenant((tx) =>
        lire(tx, sql`select kind, status from mail_requests where mail_item_id = ${id} order by requested_at, id`),
      )
      assert.deepEqual(
        historique.map((row) => [row.kind, row.status]),
        [
          ['open_and_scan', 'done'],
          ['scan', 'done'],
          ['forward', 'done'],
        ],
      )
      // Réexpédié, le pli a quitté le centre.
      assert.equal(await codeErreur(() => demander(id, 'scan')), DB_MAIL_REQUEST_REFUSED)
    })

    it('ne garde qu’une demande en cours par pli et par nature', async () => {
      const id = await pli(DURAND, { ouvert: true })
      await demander(id, 'scan')
      assert.equal(await codeErreur(() => demander(id, 'scan')), DB_UNIQUE_VIOLATION)
      // Une autre nature, en même temps : oui.
      await demander(id, 'forward')
    })

    it('refuse une ouverture d’un pli ouvert, une numérisation d’un pli fermé, une demande sur un pli retiré', async () => {
      assert.equal(
        await codeErreur(async () => demander(await pli(DURAND, { ouvert: true }), 'open_and_scan')),
        DB_MAIL_REQUEST_REFUSED,
      )
      assert.equal(await codeErreur(async () => demander(await pli(), 'scan')), DB_MAIL_REQUEST_REFUSED)
      const retire = await pli()
      await asTenant((tx) => tx.execute(sql`update mail_items set deleted_at = CURRENT_TIMESTAMP(3) where id = ${retire}`))
      assert.equal(await codeErreur(() => demander(retire, 'forward')), DB_MAIL_REQUEST_REFUSED)
    })

    it('laisse l’ouverture au client : l’accueil ouvre de lui-même, sans demande', async () => {
      const id = await pli()
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              insert into mail_requests (mail_item_id, client_id, kind, requested_by_staff_id)
              values (${id}, ${DURAND}, 'open_and_scan', ${CAMILLE})`),
          ),
        ),
        DB_CHECK_VIOLATION,
      )
    })

    it('date la demande à son dépôt, quoi que le code écrive', async () => {
      const id = await pli(DURAND, { ouvert: true })
      const demandeId = uuidv7()
      await asTenant((tx) =>
        tx.execute(sql`
          insert into mail_requests (id, mail_item_id, client_id, kind, requested_by_staff_id, requested_at)
          values (${demandeId}, ${id}, ${DURAND}, 'scan', ${CAMILLE}, '2020-01-01 00:00:00.000')`),
      )
      const [row] = await asTenant((tx) =>
        lire(tx, sql`
          select requested_at > date_sub(CURRENT_TIMESTAMP(3), interval 1 minute) as recente
            from mail_requests where id = ${demandeId}`),
      )
      assert.equal(Number(row.recente), 1)
    })
  })

  describe('annulation tracée', () => {
    it('annule sans effacer : la demande reste, avec son auteur et sa date, et le pli redevient fermé', async () => {
      const id = await pli()
      assert.equal(await requestOpening(id, durand), true)
      assert.equal(await cancelOpeningRequest(id, durand), true)

      const [annulee] = await asTenant((tx) =>
        lire(tx, sql`select * from mail_requests where mail_item_id = ${id}`),
      )
      assert.equal(annulee.status, 'cancelled')
      assert.equal(annulee.requested_by_member_id, JEANNE)
      assert.equal(annulee.cancelled_by_member_id, JEANNE)
      assert.ok(annulee.cancelled_at)
      const pliFerme = await resume(id)
      assert.equal(pliFerme.status, 'received')
      assert.equal(pliFerme.opening_requested_at, null)

      // Une nouvelle demande s'ajoute à l'historique, elle ne le remplace pas.
      assert.equal(await requestOpening(id, durand), true)
      const lignes = await asTenant((tx) =>
        lire(tx, sql`select status from mail_requests where mail_item_id = ${id} order by requested_at, id`),
      )
      assert.deepEqual(
        lignes.map((row) => row.status),
        ['cancelled', 'requested'],
      )
    })

    it('n’écrit plus le résumé de la demande sur le pli : il suit la demande', async () => {
      const id = await pli()
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              update mail_items set status = 'opening_requested', opening_requested_at = CURRENT_TIMESTAMP(3),
                     opening_requested_by = ${JEANNE}
               where id = ${id}`),
          ),
        ),
        DB_MAIL_REQUEST_REFUSED,
      )
      await demander(id, 'open_and_scan')
      // L'ancienne annulation, qui effaçait la demande : refusée.
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              update mail_items set status = 'received', opening_requested_at = null, opening_requested_by = null
               where id = ${id}`),
          ),
        ),
        DB_MAIL_REQUEST_REFUSED,
      )
    })

    it('ne supprime jamais une demande', async () => {
      const id = await demander(await pli(), 'open_and_scan')
      assert.equal(
        await codeErreur(() => asTenant((tx) => tx.execute(sql`delete from mail_requests where id = ${id}`))),
        DB_MAIL_REQUEST_REFUSED,
      )
    })

    it('reprend la demande d’un pli inséré avec elle', async () => {
      const enCours = uuidv7()
      const ouvert = uuidv7()
      await asTenant((tx) =>
        tx.execute(sql`
          insert into mail_items (id, client_id, status, opening_requested_at, opening_requested_by)
          values (${enCours}, ${DURAND}, 'opening_requested', ${datetime('2026-09-02T08:00:00Z')}, ${JEANNE})`),
      )
      await asTenant((tx) =>
        tx.execute(sql`
          insert into mail_items (id, client_id, status, opening_requested_at, opening_requested_by, opened_at, opened_by)
          values (${ouvert}, ${DURAND}, 'opened', ${datetime('2026-09-02T08:00:00Z')}, ${JEANNE},
                  ${datetime('2026-09-02T10:00:00Z')}, ${CAMILLE})`),
      )
      const reprises = await asTenant((tx) =>
        lire(tx, sql`
          select mail_item_id, status, requested_at, completed_at from mail_requests
           where mail_item_id in (${enCours}, ${ouvert})`),
      )
      const parPli = new Map(reprises.map((row) => [row.mail_item_id as string, row]))
      assert.equal(parPli.get(enCours)?.status, 'requested')
      assert.equal(
        utc(parPli.get(enCours)?.requested_at),
        '2026-09-02T08:00:00.000Z',
      )
      assert.equal(parPli.get(ouvert)?.status, 'done')
      assert.equal(
        utc(parPli.get(ouvert)?.completed_at),
        '2026-09-02T10:00:00.000Z',
      )
    })
  })

  describe('transitions', () => {
    it('ne revient jamais en arrière', async () => {
      const id = await demander(await pli(DURAND, { ouvert: true }), 'scan')
      await faire(id)
      for (const status of ['cancelled', 'requested', 'refused']) {
        assert.equal(
          await codeErreur(() =>
            asTenant((tx) =>
              tx.execute(sql`
                update mail_requests set status = ${status}, cancelled_by_staff_id = ${status === 'cancelled' ? CAMILLE : null},
                       refused_by_staff_id = ${status === 'refused' ? CAMILLE : null},
                       refusal_reason = ${status === 'refused' ? 'Non' : null}
                 where id = ${id}`),
            ),
          ),
          DB_MAIL_REQUEST_REFUSED,
          status,
        )
      }
    })

    it('exige l’auteur de chaque étape, et le motif d’un refus', async () => {
      const id = await demander(await pli(DURAND, { ouvert: true }), 'scan')
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => tx.execute(sql`update mail_requests set status = 'in_progress' where id = ${id}`)),
        ),
        DB_MAIL_REQUEST_REFUSED,
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`update mail_requests set status = 'refused', refusal_reason = 'Illisible' where id = ${id}`),
          ),
        ),
        DB_MAIL_REQUEST_REFUSED,
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`update mail_requests set status = 'refused', refused_by_staff_id = ${CAMILLE} where id = ${id}`),
          ),
        ),
        DB_CHECK_VIOLATION,
      )
      await asTenant((tx) =>
        tx.execute(sql`
          update mail_requests set status = 'refused', refused_by_staff_id = ${CAMILLE},
                 refusal_reason = 'Contenu illisible' where id = ${id}`),
      )
      const refusee = await demande(id)
      assert.equal(refusee.status, 'refused')
      assert.ok(refusee.refused_at)
    })

    it('ne laisse au client que l’annulation d’une demande pas encore prise en charge', async () => {
      const id = await demander(await pli(DURAND, { ouvert: true }), 'scan')
      assert.equal(
        await codeErreur(() =>
          asClients([DURAND], (tx) =>
            tx.execute(sql`
              update mail_requests set status = 'done', completed_by_staff_id = ${CAMILLE} where id = ${id}`),
          ),
        ),
        DB_MAIL_REQUEST_REFUSED,
      )
      await asTenant((tx) =>
        tx.execute(sql`update mail_requests set status = 'in_progress', started_by_staff_id = ${CAMILLE} where id = ${id}`),
      )
      assert.equal(
        await codeErreur(() =>
          asClients([DURAND], (tx) =>
            tx.execute(sql`
              update mail_requests set status = 'cancelled', cancelled_by_member_id = ${JEANNE} where id = ${id}`),
          ),
        ),
        DB_MAIL_REQUEST_REFUSED,
      )
    })

    it('refuse les demandes en cours d’un pli retiré, sans les effacer', async () => {
      const id = await pli()
      const ouverture = await demander(id, 'open_and_scan')
      await asTenant((tx) => tx.execute(sql`update mail_items set deleted_at = CURRENT_TIMESTAMP(3) where id = ${id}`))
      const refusee = await demande(ouverture)
      assert.equal(refusee.status, 'refused')
      assert.equal(refusee.refused_by_staff_id, null)
      assert.match(refusee.refusal_reason as string, /retiré/)
      assert.equal((await resume(id)).status, 'received')
    })

    it('réexpédie en dernier : les autres demandes du pli d’abord', async () => {
      const id = await pli(DURAND, { ouvert: true })
      await demander(id, 'scan')
      const reexpedition = await demander(id, 'forward')
      await asTenant((tx) =>
        tx.execute(sql`
          update mail_requests set status = 'in_progress', started_by_staff_id = ${CAMILLE} where id = ${reexpedition}`),
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              update mail_requests set status = 'done', completed_by_staff_id = ${CAMILLE} where id = ${reexpedition}`),
          ),
        ),
        DB_MAIL_REQUEST_REFUSED,
      )
    })

    it('fige l’adresse de réexpédition', async () => {
      const id = await demander(await pli(), 'forward')
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`update mail_requests set forward_city = 'Lyon' where id = ${id}`),
          ),
        ),
        DB_MAIL_REQUEST_REFUSED,
      )
    })
  })

  describe('facturation d’une demande faite', () => {
    const service = async (code: string, prix: number) => {
      const id = uuidv7()
      await asTenant((tx) =>
        tx.execute(sql`
          insert into services (id, code, name, nature, unit, unit_price_cents)
          values (${id}, ${code}, ${code}, 'act', 'unit', ${prix})`),
      )
      return id
    }

    const brouillon = async (clientId = DURAND) => {
      const id = uuidv7()
      await asTenant((tx) =>
        tx.execute(sql`
          insert into invoices (id, client_id, period_start, period_end)
          values (${id}, ${clientId}, '2026-09-01', '2026-09-30')`),
      )
      return id
    }

    const facturer = (
      invoiceId: string,
      requestId: string,
      { kind = 'act', serviceId = null as string | null, prix = 300 } = {},
    ) =>
      asTenant((tx) =>
        tx.execute(sql`
          insert into invoice_lines (invoice_id, kind, description, quantity, unit_price_cents, vat_rate_bp,
                                     service_id, mail_request_id)
          values (${invoiceId}, ${kind}, 'Demande de courrier', 1, ${prix}, 2000, ${serviceId}, ${requestId})`),
      )

    it('facture une numérisation faite une seule fois, hors avoir', async () => {
      const numerisation = await service('courrier.numerisation', 300)
      const id = await demander(await pli(DURAND, { ouvert: true }), 'scan')
      await faire(id)
      const facture = await brouillon()
      await facturer(facture, id, { serviceId: numerisation })
      assert.equal(
        await codeErreur(() => facturer(facture, id, { serviceId: numerisation })),
        DB_UNIQUE_VIOLATION,
      )
      assert.equal(
        await codeErreur(async () => facturer(await brouillon(), id, { serviceId: numerisation })),
        DB_UNIQUE_VIOLATION,
      )
    })

    it('ne facture jamais une demande refusée, ni une demande en cours', async () => {
      const numerisation = await service('courrier.numerisation', 300)
      const facture = await brouillon()
      const enCours = await demander(await pli(DURAND, { ouvert: true }), 'scan')
      assert.equal(
        await codeErreur(() => facturer(facture, enCours, { serviceId: numerisation })),
        DB_INVOICE_INVALID,
      )
      await asTenant((tx) =>
        tx.execute(sql`
          update mail_requests set status = 'refused', refused_by_staff_id = ${CAMILLE},
                 refusal_reason = 'Pli déjà numérisé' where id = ${enCours}`),
      )
      assert.equal(
        await codeErreur(() => facturer(facture, enCours, { serviceId: numerisation })),
        DB_INVOICE_INVALID,
      )
      // Et une demande refusée ne redevient pas faite pour autant.
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              update mail_requests set status = 'done', completed_by_staff_id = ${CAMILLE} where id = ${enCours}`),
          ),
        ),
        DB_MAIL_REQUEST_REFUSED,
      )
    })

    it('facture une ouverture par son pli, jamais par sa demande', async () => {
      const ouvertureService = await service('courrier.ouverture', 300)
      const id = await pli()
      const ouverture = await demander(id, 'open_and_scan')
      await asTenant((tx) =>
        tx.execute(sql`
          update mail_items set status = 'opened', opened_at = CURRENT_TIMESTAMP(3), opened_by = ${CAMILLE} where id = ${id}`),
      )
      assert.equal(
        await codeErreur(async () => facturer(await brouillon(), ouverture, { serviceId: ouvertureService })),
        DB_INVOICE_INVALID,
      )
    })

    it('exige le service de la nature de la demande', async () => {
      const reexpedition = await service('courrier.reexpedition', 500)
      const id = await demander(await pli(DURAND, { ouvert: true }), 'scan')
      await faire(id)
      assert.equal(
        await codeErreur(async () => facturer(await brouillon(), id, { serviceId: reexpedition })),
        DB_INVOICE_INVALID,
      )
    })

    it('refacture les frais d’affranchissement tels que relevés, une fois, à côté de l’acte', async () => {
      const reexpedition = await service('courrier.reexpedition', 500)
      const id = await demander(await pli(), 'forward')
      await faire(id, 450)
      const facture = await brouillon()
      assert.equal(
        await codeErreur(() => facturer(facture, id, { kind: 'other', prix: 500 })),
        DB_INVOICE_INVALID,
      )
      await facturer(facture, id, { serviceId: reexpedition, prix: 500 })
      await facturer(facture, id, { kind: 'other', prix: 450 })
      assert.equal(
        await codeErreur(() => facturer(facture, id, { kind: 'other', prix: 450 })),
        DB_UNIQUE_VIOLATION,
      )
      // Facturés, les frais ne changent plus.
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => tx.execute(sql`update mail_requests set postage_cents = 600 where id = ${id}`)),
        ),
        DB_MAIL_REQUEST_REFUSED,
      )
      // Le numéro de suivi, lui, se relève encore.
      await asTenant((tx) =>
        tx.execute(sql`update mail_requests set forward_tracking_number = '1A2B3C' where id = ${id}`),
      )
    })

    it('ne facture pas la demande d’un autre client, ni un pli et une demande sur la même ligne', async () => {
      const numerisation = await service('courrier.numerisation', 300)
      const pliPetit = await pli(PETIT, { ouvert: true })
      const autre = uuidv7()
      await asTenant((tx) =>
        tx.execute(sql`
          insert into mail_requests (id, mail_item_id, client_id, kind, requested_by_member_id)
          values (${autre}, ${pliPetit}, ${PETIT}, 'scan', ${PAUL})`),
      )
      await faire(autre)
      assert.equal(
        await codeErreur(async () =>
          facturer(await brouillon(DURAND), autre, { serviceId: numerisation }),
        ),
        DB_INVOICE_INVALID,
      )
      const facturePetit = await brouillon(PETIT)
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              insert into invoice_lines (invoice_id, kind, description, unit_price_cents, vat_rate_bp,
                                         service_id, mail_item_id, mail_request_id)
              values (${facturePetit}, 'act', 'Double', 300, 2000, ${numerisation}, ${pliPetit}, ${autre})`),
          ),
        ),
        DB_CHECK_VIOLATION,
      )
    })
  })

  describe('portée client', () => {
    it('une entreprise ne voit que ses demandes : le filtre est celui de la requête', async () => {
      // MySQL ne filtre plus les lectures : sans RLS, c'est `listRequestsForAccounts`
      // qui porte le filtre sur `client_id`. Un autre client ne voit rien de Durand.
      await demander(await pli(), 'open_and_scan')
      const pliPetit = await pli(PETIT)
      await asTenant((tx) =>
        tx.execute(sql`
          insert into mail_requests (id, mail_item_id, client_id, kind, requested_by_member_id)
          values (${uuidv7()}, ${pliPetit}, ${PETIT}, 'open_and_scan', ${PAUL})`),
      )
      const statuses = ['requested', 'in_progress', 'done', 'refused', 'cancelled'] as const
      const page = { number: 1, size: 50 }
      const duDurand = await listRequestsForAccounts(durand, { statuses }, page)
      assert.deepEqual(
        duDurand.rows.map((row) => row.clientId),
        [DURAND],
      )
      const petit: ClientAccount[] = [{ memberId: PAUL, clientId: PETIT, clientName: 'Boulangerie Petit' }]
      const duPetit = await listRequestsForAccounts(petit, { statuses }, page)
      assert.deepEqual(
        duPetit.rows.map((row) => row.clientId),
        [PETIT],
      )
    })

    it('refuse une demande sur le pli d’une autre entreprise', async () => {
      const pliPetit = await pli(PETIT)
      assert.equal(
        await codeErreur(() =>
          asClients([DURAND], (tx) =>
            tx.execute(sql`
              insert into mail_requests (id, mail_item_id, client_id, kind, requested_by_member_id)
              values (${uuidv7()}, ${pliPetit}, ${PETIT}, 'open_and_scan', ${PAUL})`),
          ),
        ),
        DB_INSUFFICIENT_PRIVILEGE,
      )
    })
  })
})
