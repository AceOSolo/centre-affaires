import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_CHECK_VIOLATION, DB_INSUFFICIENT_PRIVILEGE, dbErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { purgeExpiredMail } from './conservation.ts'
import {
  cancelOpeningRequest,
  findScanForAccounts,
  listMailForAccounts,
  listOpenings,
  requestOpening,
} from './queries.ts'

/**
 * Courrier des entreprises domiciliées, éprouvé contre la base (ADR 015).
 *
 * Deux choses ne doivent jamais arriver : qu'une entreprise lise le courrier
 * d'une autre, et qu'une ouverture échappe au relevé — ou y figure deux fois.
 * Les requêtes sont appelées telles que l'application les appelle, sous
 * l'identité applicative. MySQL ne filtre pas les lectures : la portée client
 * tient aux filtres explicites des requêtes, que ces tests éprouvent.
 */
describe('courrier', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases
  const owner = { get client() { return bases.owner.client } }

  const DURAND = '01a00000-0000-7000-8000-00000000c1a1'
  const PETIT = '01a00000-0000-7000-8000-00000000c1a2'
  const JEANNE = '01a00000-0000-7000-8000-00000000c1b1'
  const PAUL = '01a00000-0000-7000-8000-00000000c1b2'
  const CAMILLE = '01a00000-0000-7000-8000-00000000c1d1'
  const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000fb'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>, tenant = DEFAULT_TENANT_ID) =>
    withTenant(tenant, run, bases.app.db)

  /** Les lignes d'une requête : `execute` rend `[lignes, champs]` sous mysql2. */
  const lire = async (tx: Transaction, requete: ReturnType<typeof sql>) =>
    ((await tx.execute(requete)) as unknown as [Record<string, unknown>[]])[0]

  const codeErreur = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  /** Un pli, fermé par défaut. */
  const pli = async (
    clientId: string,
    {
      openedAt = null as string | null,
      requestedAt = null as string | null,
      deleted = false,
    } = {},
  ): Promise<string> => {
    const status = openedAt ? 'opened' : requestedAt ? 'opening_requested' : 'received'
    // MySQL lit `2026-09-02 08:00:00.000`, pas le format ISO avec `T` et `Z`.
    const datetime = (iso: string | null) => (iso ? iso.replace('T', ' ').replace('Z', '') : null)
    const id = uuidv7()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into mail_items (
          id, client_id, sender, status, received_at,
          opening_requested_at, opening_requested_by, opened_at, opened_by, deleted_at
        ) values (
          ${id}, ${clientId}, 'URSSAF', ${status}, '2026-09-01 08:00:00.000',
          ${datetime(requestedAt)}, ${requestedAt ? (clientId === DURAND ? JEANNE : PAUL) : null},
          ${datetime(openedAt)}, ${openedAt ? CAMILLE : null}, ${deleted ? sql`CURRENT_TIMESTAMP(3)` : null}
        )
      `),
    )
    return id
  }

  const numeriser = async (mailItemId: string, side = 'envelope'): Promise<string> => {
    const id = uuidv7()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into mail_scans (id, mail_item_id, side, storage_key, content_type, byte_size)
        values (${id}, ${mailItemId}, ${side}, ${`courrier/test/${mailItemId}-${side}.pdf`}, 'application/pdf', 1200)
      `),
    )
    return id
  }

  const statut = async (id: string) => {
    const [row] = await asTenant((tx) =>
      lire(tx, sql`select status, opening_requested_by from mail_items where id = ${id}`),
    )
    return row
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    // Les requêtes du module passent par la base globale : on la fait pointer
    // sur l'identité applicative de la base de test.
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await viderTables(
      bases.owner,
      'mail_scan_views',
      'mail_scans',
      'mail_requests',
      'mail_items',
      'client_members',
      'clients',
      'staff_members',
    )
    await bases.owner.client.query('delete from tenants where id <> ?', [DEFAULT_TENANT_ID])
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'),
          (${PETIT}, 'Boulangerie Petit', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand', 'u-jeanne'),
          (${PAUL}, ${PETIT}, 'paul@petit.fr', 'Paul Petit', 'u-paul')`)
      await tx.execute(sql`
        insert into staff_members (id, email, full_name) values
          (${CAMILLE}, 'camille@centre.fr', 'Camille')`)
    })
  })

  after(async () => {
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  describe('cohérence en base', () => {
    it('refuse un pli ouvert sans date d’ouverture', async () => {
      // Le relevé compte sur `opened_at` : un pli « ouvert » sans date y
      // échapperait.
      const code = await codeErreur(() =>
        asTenant((tx) =>
          tx.execute(sql`insert into mail_items (client_id, status) values (${DURAND}, 'opened')`),
        ),
      )
      assert.equal(code, DB_CHECK_VIOLATION)
    })

    it('refuse une demande d’ouverture sans demandeur', async () => {
      const code = await codeErreur(() =>
        asTenant((tx) =>
          tx.execute(sql`
            insert into mail_items (client_id, status, opening_requested_at)
            values (${DURAND}, 'opening_requested', CURRENT_TIMESTAMP(3))`),
        ),
      )
      assert.equal(code, DB_CHECK_VIOLATION)
    })

    it('distingue un objet stocké en clair d’un objet chiffré, et sa version de clé', async () => {
      // R22, ADR 020 : nul = déposé en clair avant le chiffrement, encore
      // lisible tel quel ; sinon la version de la clé qui l'a chiffré.
      const id = await pli(DURAND)
      const clair = await numeriser(id, 'envelope')
      await asTenant((tx) =>
        tx.execute(sql`
          insert into mail_scans (mail_item_id, side, storage_key, content_type, byte_size, encryption_key_version)
          values (${id}, 'content', 'courrier/test/chiffre.pdf', 'application/pdf', 1200, 1)`),
      )
      const rows = await asTenant((tx) =>
        lire(tx, sql`select id, encryption_key_version from mail_scans order by side`),
      )
      assert.deepEqual(
        rows.map((row) => [row.id === clair, row.encryption_key_version]),
        [
          [true, null],
          [false, 1],
        ],
      )
      const code = await codeErreur(() =>
        asTenant((tx) => tx.execute(sql`update mail_scans set encryption_key_version = 0`)),
      )
      assert.equal(code, DB_CHECK_VIOLATION)
    })

    it('refuse une numérisation d’un type qui s’exécuterait dans le navigateur', async () => {
      const id = await pli(DURAND)
      const code = await codeErreur(() =>
        asTenant((tx) =>
          tx.execute(sql`
            insert into mail_scans (mail_item_id, side, storage_key, content_type, byte_size)
            values (${id}, 'envelope', 'k', 'text/html', 10)`),
        ),
      )
      assert.equal(code, DB_CHECK_VIOLATION)
    })

    it('n’accepte qu’une enveloppe et un contenu par pli', async () => {
      const id = await pli(DURAND)
      await numeriser(id, 'envelope')
      await assert.rejects(numeriser(id, 'envelope'))
    })

    it('refuse d’écrire un pli pour un autre centre', async () => {
      // Remplace l'ancienne isolation par RLS : la base refuse l'écriture
      // (CA014), la lecture filtre sur `tenant_id` dès qu'un second centre existe.
      await bases.owner.client.query(
        'insert into tenants (id, name, slug) values (?, ?, ?)',
        [AUTRE_CENTRE, 'Autre centre', 'autre-centre-courrier'],
      )
      const code = await codeErreur(() =>
        asTenant(
          (tx) =>
            tx.execute(sql`
              insert into mail_items (id, tenant_id, client_id) values (${uuidv7()}, ${DEFAULT_TENANT_ID}, ${DURAND})`),
          AUTRE_CENTRE,
        ),
      )
      assert.equal(code, 'CA014')
    })
  })

  describe('journal d’accès', () => {
    const consulter = async (scanId: string) =>
      asTenant((tx) =>
        tx.execute(sql`
          insert into mail_scan_views (mail_scan_id, viewer, client_member_id, auth_user_id)
          values (${scanId}, 'client', ${JEANNE}, 'u-jeanne')`),
      )

    it('ne se corrige pas', async () => {
      const scanId = await numeriser(await pli(DURAND))
      await consulter(scanId)
      const code = await codeErreur(() =>
        asTenant((tx) => tx.execute(sql`update mail_scan_views set viewed_at = date_sub(CURRENT_TIMESTAMP(3), interval 1 year)`)),
      )
      assert.equal(code, DB_INSUFFICIENT_PRIVILEGE)
    })

    it('ne s’efface pas', async () => {
      const scanId = await numeriser(await pli(DURAND))
      await consulter(scanId)
      const code = await codeErreur(() =>
        asTenant((tx) => tx.execute(sql`delete from mail_scan_views`)),
      )
      assert.equal(code, DB_INSUFFICIENT_PRIVILEGE)
    })

    it('nomme toujours la personne, du côté qu’elle déclare', async () => {
      const scanId = await numeriser(await pli(DURAND))
      const code = await codeErreur(() =>
        asTenant((tx) =>
          tx.execute(sql`
            insert into mail_scan_views (mail_scan_id, viewer, staff_member_id, auth_user_id)
            values (${scanId}, 'client', ${CAMILLE}, 'u-camille')`),
        ),
      )
      assert.equal(code, DB_CHECK_VIOLATION)
    })
  })

  describe('boîte aux lettres', () => {
    it('ne montre que le courrier des entreprises du compte', async () => {
      const aDurand = await pli(DURAND)
      await pli(PETIT)
      const boite = await listMailForAccounts(durand)
      assert.deepEqual(
        boite.map((item) => item.id),
        [aDurand],
      )
    })

    it('ne montre pas un pli retiré', async () => {
      await pli(DURAND, { deleted: true })
      assert.equal((await listMailForAccounts(durand)).length, 0)
    })

    it('donne l’accès aux numérisations de ses plis, pas à celles des autres', async () => {
      const sien = await numeriser(await pli(DURAND))
      const autre = await numeriser(await pli(PETIT))
      assert.ok(await findScanForAccounts(sien, durand))
      assert.equal(await findScanForAccounts(autre, durand), undefined)
    })

    it('ferme l’accès aux numérisations d’un pli retiré', async () => {
      const scan = await numeriser(await pli(DURAND, { deleted: true }))
      assert.equal(await findScanForAccounts(scan, durand), undefined)
    })

    it('répond « introuvable » à un identifiant mal formé plutôt que d’échouer', async () => {
      assert.equal(await findScanForAccounts('pas-un-uuid', durand), undefined)
      assert.equal(await requestOpening('pas-un-uuid', durand), false)
    })
  })

  describe('demande d’ouverture', () => {
    it('enregistre la demande au nom de la personne', async () => {
      const id = await pli(DURAND)
      assert.equal(await requestOpening(id, durand), true)
      const row = await statut(id)
      assert.equal(row.status, 'opening_requested')
      assert.equal(row.opening_requested_by, JEANNE)
    })

    it('ne compte pas deux fois une demande répétée', async () => {
      const id = await pli(DURAND)
      assert.equal(await requestOpening(id, durand), true)
      assert.equal(await requestOpening(id, durand), false)
    })

    it('refuse de demander l’ouverture du courrier d’une autre entreprise', async () => {
      const id = await pli(PETIT)
      assert.equal(await requestOpening(id, durand), false)
      assert.equal((await statut(id)).status, 'received')
    })

    it('s’annule tant que le pli est fermé', async () => {
      const id = await pli(DURAND, { requestedAt: '2026-09-02T08:00:00Z' })
      assert.equal(await cancelOpeningRequest(id, durand), true)
      const row = await statut(id)
      assert.equal(row.status, 'received')
      assert.equal(row.opening_requested_by, null)
    })

    it('ne s’annule plus une fois le pli ouvert', async () => {
      const id = await pli(DURAND, {
        requestedAt: '2026-09-02T08:00:00Z',
        openedAt: '2026-09-02T10:00:00Z',
      })
      assert.equal(await cancelOpeningRequest(id, durand), false)
      assert.equal((await statut(id)).status, 'opened')
    })

    it('ne laisse pas une autre entreprise annuler la demande', async () => {
      const id = await pli(PETIT, { requestedAt: '2026-09-02T08:00:00Z' })
      assert.equal(await cancelOpeningRequest(id, durand), false)
    })
  })

  describe('relevé des ouvertures', () => {
    const septembre = {
      startsAt: new Date('2026-08-31T22:00:00Z'),
      endsAt: new Date('2026-09-30T22:00:00Z'),
    }

    it('relève les ouvertures du mois, avec qui les a demandées et faites', async () => {
      await pli(DURAND, { requestedAt: '2026-09-02T08:00:00Z', openedAt: '2026-09-02T10:00:00Z' })
      await pli(PETIT, { openedAt: '2026-09-03T10:00:00Z' })

      const lignes = await listOpenings(septembre)
      const durandLigne = lignes.find((ligne) => ligne.clientId === DURAND)
      assert.equal(lignes.length, 2)
      assert.equal(durandLigne?.requestedBy, 'Jeanne Durand')
      assert.equal(durandLigne?.openedBy, 'Camille')
    })

    it('ignore les plis fermés, ceux d’un autre mois et les plis retirés', async () => {
      await pli(DURAND)
      await pli(DURAND, { requestedAt: '2026-09-02T08:00:00Z' })
      await pli(DURAND, { openedAt: '2026-10-01T10:00:00Z' })
      await pli(DURAND, { openedAt: '2026-09-10T10:00:00Z', deleted: true })
      assert.deepEqual(await listOpenings(septembre), [])
    })

    it('borne le mois à l’heure du centre', async () => {
      // 30 septembre 23h30 UTC = 1er octobre 1h30 à Paris : octobre.
      await pli(DURAND, { openedAt: '2026-09-30T23:30:00Z' })
      assert.deepEqual(await listOpenings(septembre), [])
    })
  })

  describe('conservation', () => {
    /** Numérisation déposée il y a `mois` mois. */
    const numeriserIlYa = async (mailItemId: string, mois: number, side = 'envelope') => {
      const id = uuidv7()
      const key = `courrier/test/${mailItemId}-${side}.pdf`
      await asTenant((tx) =>
        tx.execute(sql`
          insert into mail_scans (id, mail_item_id, side, storage_key, content_type, byte_size, created_at)
          values (${id}, ${mailItemId}, ${side}, ${key}, 'application/pdf', 1200,
                  TIMESTAMPADD(MONTH, ${-mois}, CURRENT_TIMESTAMP(3)))`),
      )
      return { id, key }
    }

    const consulterIlYa = (scanId: string, mois: number) =>
      asTenant((tx) =>
        tx.execute(sql`
          insert into mail_scan_views (mail_scan_id, viewer, client_member_id, auth_user_id, viewed_at)
          values (${scanId}, 'client', ${JEANNE}, 'u-jeanne', TIMESTAMPADD(MONTH, ${-mois}, CURRENT_TIMESTAMP(3)))`),
      )

    const purger = async () => {
      const effaces: string[] = []
      const result = await asTenant((tx) =>
        purgeExpiredMail(tx, async (key) => {
          effaces.push(key)
        }),
      )
      return { ...result, effaces }
    }

    it('efface les numérisations échues, fichier compris, et garde les autres', async () => {
      const ancienne = await numeriserIlYa(await pli(DURAND), 13)
      const recente = await numeriserIlYa(await pli(DURAND), 2)

      const { scans, effaces } = await purger()
      assert.equal(scans, 1)
      assert.deepEqual(effaces, [ancienne.key])

      const rows = await asTenant((tx) =>
        lire(tx, sql`select id, deleted_at from mail_scans order by created_at`),
      )
      assert.notEqual(rows.find((r) => r.id === ancienne.id)?.deleted_at, null)
      assert.equal(rows.find((r) => r.id === recente.id)?.deleted_at, null)
    })

    it('garde le pli et son ouverture au relevé quand le document est effacé', async () => {
      const id = await pli(DURAND, { openedAt: '2026-09-02T10:00:00Z' })
      await numeriserIlYa(id, 13, 'content')
      await purger()
      const [row] = await asTenant((tx) =>
        lire(tx, sql`select status, deleted_at from mail_items where id = ${id}`),
      )
      assert.equal(row.status, 'opened')
      assert.equal(row.deleted_at, null)
    })

    it('suit la durée fixée par le centre', async () => {
      await owner.client.query('update tenants set mail_scan_retention_months = 24 where id = ?', [
        DEFAULT_TENANT_ID,
      ])
      try {
        await numeriserIlYa(await pli(DURAND), 13)
        assert.equal((await purger()).scans, 0)
      } finally {
        await owner.client.query('update tenants set mail_scan_retention_months = 12 where id = ?', [
          DEFAULT_TENANT_ID,
        ])
      }
    })

    it('purge le journal échu, et lui seul', async () => {
      const scan = await numeriserIlYa(await pli(DURAND), 1)
      await consulterIlYa(scan.id, 14)
      await consulterIlYa(scan.id, 1)

      assert.equal((await purger()).views, 1)
      const rows = await asTenant((tx) => lire(tx, sql`select id from mail_scan_views`))
      assert.equal(rows.length, 1)
    })

    it('ne purge pas le journal d’un autre centre', async () => {
      const scan = await numeriserIlYa(await pli(DURAND), 1)
      await consulterIlYa(scan.id, 14)
      await owner.client.query('insert into tenants (id, name, slug) values (?, ?, ?)', [
        AUTRE_CENTRE,
        'Autre centre',
        'autre-centre-courrier',
      ])

      const [row] = await asTenant(
        (tx) => lire(tx, sql`select purge_expired_mail_scan_views() as purged`),
        AUTRE_CENTRE,
      )
      assert.equal(Number(row.purged), 0)
    })

    it('refuse une durée de conservation nulle', async () => {
      const code = await codeErreur(() =>
        owner.client.query('update tenants set mail_access_log_retention_months = 0'),
      )
      assert.equal(code, DB_CHECK_VIOLATION)
    })
  })
})
