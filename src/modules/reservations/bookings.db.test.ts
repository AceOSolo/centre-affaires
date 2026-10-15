import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import {
  DB_CHECK_VIOLATION,
  DB_CONTRACT_OCCUPATION_LOCKED,
  DB_EXCLUSION_VIOLATION,
  DB_FOREIGN_KEY_VIOLATION,
  DB_NOT_NULL_VIOLATION,
  DB_TENANT_MISMATCH,
  dbErrorCode,
} from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { bookings } from './schema.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'

/**
 * Vérifie ce que le code ne peut pas garantir : les contraintes et les règles
 * de la base (`src/db/regles/20-reservations.sql`).
 *
 * Demande un MySQL jetable (`TEST_DB_NAME`), jamais la base de développement —
 * la structure y est appliquée et les tables vidées entre les tests.
 *
 * Deux identités, comme en production (ADR 003) : le propriétaire pour le
 * nettoyage, l'utilisateur applicatif pour tout ce qui est éprouvé.
 */
describe('contraintes de la table bookings', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const RESOURCE_ID = '01999f00-0000-7000-8000-0000000000a1'
  const OTHER_TENANT_ID = '01999f00-0000-7000-8000-0000000000ff'

  const asApp = <T>(run: Parameters<typeof withTenant<T>>[1], tenantId = DEFAULT_TENANT_ID) =>
    withTenant(tenantId, run, bases.app.db)

  const book = (start: string, end: string, title = 'Réunion') =>
    asApp((tx) =>
      tx.execute(sql`
        insert into bookings (resource_id, channel, starts_at, ends_at, title)
        values (${RESOURCE_ID}, 'staff', ${start}, ${end}, ${title})
      `),
    )

  const count = (where = sql`true`) =>
    asApp(async (tx) => {
      const [rows] = (await tx.execute(sql`select count(*) as n from bookings where ${where}`)) as unknown as [
        { n: number | string }[],
      ]
      return Number(rows[0].n)
    })

  /** Code de l'erreur levée, ou `undefined` si l'appel a réussi. */
  const errorCode = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
  })

  beforeEach(async () => {
    // Les tables sont liées entre elles : les vider ensemble, et la même
    // liste dans toutes les suites de base.
    await viderTables(bases.owner, 'bookings', 'contracts', 'rate_plan_items', 'rate_plans', 'clients', 'resources')
    await bases.owner.client.query('delete from tenants where id <> ?', [DEFAULT_TENANT_ID])
    await asApp((tx) =>
      tx.execute(sql`
        insert into resources (id, resource_type, code, name, capacity)
        values (${RESOURCE_ID}, 'salle', 'S-101', 'Salle Europe', 8)
      `),
    )
  })

  after(async () => {
    await bases.fermer()
  })

  describe('anti-double-réservation', () => {
    it('accepte deux réservations jointives — bornes [)', async () => {
      await book('2026-10-01 09:00:00', '2026-10-01 10:00:00')
      await book('2026-10-01 10:00:00', '2026-10-01 11:00:00')
      assert.equal(await count(), 2)
    })

    it('refuse un chevauchement, quelle que soit la logique applicative', async () => {
      await book('2026-10-01 09:00:00', '2026-10-01 10:00:00')
      assert.equal(
        await errorCode(() => book('2026-10-01 09:30:00', '2026-10-01 10:30:00')),
        DB_EXCLUSION_VIOLATION,
      )
    })

    it('laisse une réservation glisser sur sa propre place', async () => {
      // Le déplacement est un UPDATE, pas un INSERT. Le garde s'y applique
      // aussi, et il compare la ligne modifiée aux autres — pas à elle-même.
      // Sans quoi reculer une réunion d'une demi-heure se heurterait à son
      // propre créneau.
      await book('2026-10-01 09:00:00', '2026-10-01 10:00:00', 'À déplacer')
      await asApp((tx) =>
        tx.execute(sql`
          update bookings
             set starts_at = '2026-10-01 09:30:00', ends_at = '2026-10-01 10:30:00'
           where title = 'À déplacer'
        `),
      )

      assert.equal(await count(sql`starts_at = '2026-10-01 09:30:00'`), 1)
    })

    it('refuse un déplacement sur le créneau d’une autre réservation', async () => {
      await book('2026-10-01 09:00:00', '2026-10-01 10:00:00', 'À déplacer')
      await book('2026-10-01 14:00:00', '2026-10-01 15:00:00', 'Occupante')

      assert.equal(
        await errorCode(() =>
          asApp((tx) =>
            tx.execute(sql`
              update bookings
                 set starts_at = '2026-10-01 14:30:00', ends_at = '2026-10-01 15:30:00'
               where title = 'À déplacer'
            `),
          ),
        ),
        DB_EXCLUSION_VIOLATION,
      )
    })

    it('ne relance pas le contrôle quand l’UPDATE ne touche ni les bornes ni le statut', async () => {
      await book('2026-10-01 09:00:00', '2026-10-01 10:00:00', 'À renommer')
      await asApp((tx) => tx.execute(sql`update bookings set title = 'Renommée'`))
      assert.equal(await count(sql`title = 'Renommée'`), 1)
    })

    it('refuse de ressusciter une annulée sur un créneau repris', async () => {
      await book('2026-10-01 09:00:00', '2026-10-01 10:00:00', 'Première')
      await asApp((tx) =>
        tx.execute(sql`update bookings set status = 'cancelled', cancelled_at = current_timestamp(3)`),
      )
      await book('2026-10-01 09:30:00', '2026-10-01 10:30:00', 'Reprise')

      assert.equal(
        await errorCode(() =>
          asApp((tx) =>
            tx.execute(sql`
              update bookings set status = 'confirmed', cancelled_at = null where title = 'Première'
            `),
          ),
        ),
        DB_EXCLUSION_VIOLATION,
      )
    })

    it('libère le créneau après annulation', async () => {
      await book('2026-10-01 09:00:00', '2026-10-01 10:00:00')
      await asApp((tx) =>
        tx.execute(sql`update bookings set status = 'cancelled', cancelled_at = current_timestamp(3)`),
      )

      await book('2026-10-01 09:30:00', '2026-10-01 10:30:00')
      assert.equal(await count(sql`status = 'confirmed'`), 1)
    })

    it('départage deux réservations concurrentes sur le même créneau', async () => {
      const debut = '2026-10-01 14:00:00'
      const fin = '2026-10-01 15:00:00'
      const resultats = await Promise.allSettled([
        book(debut, fin, 'Premier'),
        book(debut, fin, 'Second'),
      ])

      assert.equal(resultats.filter((r) => r.status === 'fulfilled').length, 1)
      assert.equal(await count(), 1)
    })

    it('ne confond pas deux ressources : même créneau, autre salle', async () => {
      const AUTRE = '01999f00-0000-7000-8000-0000000000a2'
      await asApp((tx) =>
        tx.execute(sql`
          insert into resources (id, resource_type, code, name, capacity)
          values (${AUTRE}, 'salle', 'S-102', 'Salle Asie', 6)
        `),
      )
      await book('2026-10-01 09:00:00', '2026-10-01 10:00:00')
      await asApp((tx) =>
        tx.execute(sql`
          insert into bookings (resource_id, channel, starts_at, ends_at, title)
          values (${AUTRE}, 'staff', '2026-10-01 09:00:00', '2026-10-01 10:00:00', 'Ailleurs')
        `),
      )
      assert.equal(await count(), 2)
    })
  })

  describe('occupation de contrat', () => {
    it('refuse l’écriture directe d’une occupation de contrat (CA001)', async () => {
      const code = await errorCode(() =>
        asApp((tx) =>
          tx.execute(sql`
            insert into bookings (resource_id, channel, kind, contract_id, starts_at, ends_at, title)
            values (${RESOURCE_ID}, 'staff', 'contract', ${'01999f00-0000-7000-8000-0000000000c1'},
                    '2026-10-01 09:00:00', '2026-10-31 09:00:00', 'Contrat C-1')
          `),
        ),
      )
      assert.equal(code, DB_CONTRACT_OCCUPATION_LOCKED)
    })
  })

  describe('cohérence des lignes', () => {
    it('refuse un intervalle vide', async () => {
      assert.equal(
        await errorCode(() => book('2026-10-01 09:00:00', '2026-10-01 09:00:00')),
        DB_CHECK_VIOLATION,
      )
    })

    it('exige le canal de la réservation', async () => {
      // Pas de valeur par défaut : chaque chemin d'écriture dit d'où il vient
      // (R05, ADR 018). Écart MySQL : une table qui porte un trigger BEFORE
      // INSERT reçoit la valeur implicite de l'énumération au lieu de l'erreur
      // 1364 ; l'omission n'est donc plus refusée par la base, mais par le
      // type de Drizzle (`channel` obligatoire, sans défaut).
      const NULL_EXPLICITE = await errorCode(() =>
        asApp((tx) =>
          tx.execute(sql`
            insert into bookings (resource_id, channel, starts_at, ends_at, title)
            values (${RESOURCE_ID}, null, '2026-10-01 09:00:00', '2026-10-01 10:00:00', 'Canal nul')
          `),
        ),
      )
      assert.equal(NULL_EXPLICITE, DB_NOT_NULL_VIOLATION)

      // Valeur hors énumération : refusée par le mode strict de MySQL (pas de
      // code normalisé, l'erreur remonte telle quelle).
      await assert.rejects(
        asApp((tx) =>
          tx.execute(sql`
            insert into bookings (resource_id, channel, starts_at, ends_at, title)
            values (${RESOURCE_ID}, 'telephone', '2026-10-01 09:00:00', '2026-10-01 10:00:00', 'Canal inconnu')
          `),
        ),
      )
    })

    it('refuse une annulation sans date d’annulation', async () => {
      await book('2026-10-01 09:00:00', '2026-10-01 10:00:00')
      const code = await errorCode(() =>
        asApp((tx) => tx.execute(sql`update bookings set status = 'cancelled'`)),
      )
      assert.equal(code, DB_CHECK_VIOLATION)
    })

    it('attribue le centre unique et un identifiant ordonné', async () => {
      // Par Drizzle : c'est l'application qui pose l'UUID v7 (`uuid()` de la
      // base, pour le SQL direct, est une version 1).
      await asApp(async (tx) => {
        for (const [debut, titre] of [[9, 'Première'], [11, 'Seconde']] as const) {
          await tx.insert(bookings).values({
            resourceId: RESOURCE_ID,
            channel: 'staff',
            startsAt: new Date(Date.UTC(2026, 9, 1, debut)),
            endsAt: new Date(Date.UTC(2026, 9, 1, debut + 1)),
            title: titre,
          })
        }
      })

      const [rows] = (await asApp((tx) =>
        tx.execute(sql`select id, tenant_id, title from bookings order by id`),
      )) as unknown as [{ id: string; tenant_id: string; title: string }[]]
      assert.deepEqual(
        rows.map((r) => r.title).sort(),
        ['Première', 'Seconde'],
      )
      assert.equal(rows[0].tenant_id, DEFAULT_TENANT_ID)
      // Version 7 : 13e caractère hexadécimal de l’uuid.
      assert.equal(String(rows[0].id)[14], '7')
    })

    it('met à jour updated_at sans que le code y pense', async () => {
      await book('2026-10-01 09:00:00', '2026-10-01 10:00:00')
      const lire = async () => {
        const [rows] = await bases.owner.client.query('select created_at, updated_at from bookings')
        return (rows as { created_at: Date; updated_at: Date }[])[0]
      }
      const avant = await lire()
      await new Promise((resolve) => setTimeout(resolve, 20))
      await bases.owner.client.query("update bookings set title = 'Renommée'")
      const apres = await lire()

      assert.deepEqual(apres.created_at, avant.created_at)
      assert.ok(apres.updated_at > avant.updated_at)
    })
  })

  describe('isolation par centre', () => {
    // Pas de RLS en MySQL : la base ne filtre plus les lectures, mais refuse
    // d'écrire pour un autre centre que celui du contexte (CA014).
    it('refuse d’écrire pour un autre centre que celui du contexte', async () => {
      await bases.owner.client.query(
        'insert into tenants (id, name, slug) values (?, ?, ?)',
        [OTHER_TENANT_ID, 'Autre centre', 'autre-centre'],
      )

      const code = await errorCode(() =>
        asApp((tx) =>
          tx.execute(sql`
            insert into bookings (tenant_id, resource_id, channel, starts_at, ends_at, title)
            values (${OTHER_TENANT_ID}, ${RESOURCE_ID}, 'staff',
                    '2026-10-01 09:00:00', '2026-10-01 10:00:00', 'Fuite')
          `),
        ),
      )
      assert.equal(code, DB_TENANT_MISMATCH)
    })

    it('refuse une réservation sur la ressource d’un autre centre', async () => {
      await bases.owner.client.query(
        'insert into tenants (id, name, slug) values (?, ?, ?)',
        [OTHER_TENANT_ID, 'Autre centre', 'autre-centre'],
      )

      const code = await errorCode(() =>
        asApp(
          (tx) =>
            tx.execute(sql`
              insert into bookings (tenant_id, resource_id, channel, starts_at, ends_at, title)
              values (${OTHER_TENANT_ID}, ${RESOURCE_ID}, 'staff',
                      '2026-10-01 09:00:00', '2026-10-01 10:00:00', 'Fuite')
            `),
          OTHER_TENANT_ID,
        ),
      )
      // La ressource n’existe pas pour ce centre.
      assert.equal(code, DB_FOREIGN_KEY_VIOLATION)
    })
  })
})
