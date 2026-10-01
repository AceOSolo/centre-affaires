import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import {
  PG_CHECK_VIOLATION,
  PG_EXCLUSION_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_NOT_NULL_VIOLATION,
  pgErrorCode,
} from '../../db/errors.ts'

/** Valeur hors énumération. */
const PG_INVALID_TEXT_REPRESENTATION = '22P02'
import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'

/**
 * Vérifie ce que le code ne peut pas garantir : les contraintes de la base.
 *
 * Demande un Postgres jetable, jamais la base de développement — les migrations
 * y sont appliquées et les tables vidées entre les tests.
 *
 * Deux connexions, comme en production (ADR 003) : le propriétaire pour les
 * migrations et le nettoyage, `app_centre` pour tout ce qui est éprouvé. Sous
 * le seul propriétaire, les tests d'isolation passeraient sans rien prouver.
 *
 *   docker compose up -d
 *   npx drizzle-kit migrate
 *   node infra/provision-role-applicatif.mjs
 *   npm test
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('contraintes de la table bookings', { skip: raison }, () => {
  {
    // Propriétaire : migrations et nettoyage. Jamais les assertions.
    const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
    // Rôle applicatif, sans BYPASSRLS : la vue que les tests contrôlent.
    const app = createDatabase(appUrl ?? '')

    const RESOURCE_ID = '01999f00-0000-7000-8000-0000000000a1'
    const OTHER_TENANT_ID = '01999f00-0000-7000-8000-0000000000ff'

    const book = (start: string, end: string, title = 'Réunion') =>
      withTenant(
        DEFAULT_TENANT_ID,
        (tx) =>
          tx.execute(sql`
            insert into bookings (resource_id, channel, starts_at, ends_at, title)
            values (${RESOURCE_ID}, 'staff', ${start}, ${end}, ${title})
          `),
        app.db,
      )

    const count = (where = sql`true`) =>
      withTenant(
        DEFAULT_TENANT_ID,
        async (tx) => {
          const rows = await tx.execute(sql`select count(*)::int as n from bookings where ${where}`)
          return rows[0].n as number
        },
        app.db,
      )

    /** SQLSTATE de l'erreur levée, ou `undefined` si l'appel a réussi. */
    const errorCode = async (run: () => Promise<unknown>) => {
      try {
        await run()
      } catch (error) {
        return pgErrorCode(error)
      }
      return undefined
    }

    before(async () => {
      await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
    })

    beforeEach(async () => {
      // Les tables sont liées entre elles : les vider ensemble, et la même
      // liste dans les deux suites de base — sinon l'une laisse des lignes qui
      // bloquent le TRUNCATE de l'autre.
      await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources cascade`
      await owner.client`delete from tenants where id <> ${DEFAULT_TENANT_ID}`
      await withTenant(
        DEFAULT_TENANT_ID,
        (tx) =>
          tx.execute(sql`
            insert into resources (id, resource_type, code, name, capacity)
            values (${RESOURCE_ID}, 'salle', 'S-101', 'Salle Europe', 8)
          `),
        app.db,
      )
    })

    after(async () => {
      await Promise.all([owner.client.end(), app.client.end()])
    })

    describe('anti-double-réservation', () => {
      it('accepte deux réservations jointives — bornes [)', async () => {
        await book('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z')
        await book('2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z')
        assert.equal(await count(), 2)
      })

      it('refuse un chevauchement, quelle que soit la logique applicative', async () => {
        await book('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z')
        assert.equal(
          await errorCode(() => book('2026-10-01T09:30:00Z', '2026-10-01T10:30:00Z')),
          PG_EXCLUSION_VIOLATION,
        )
      })

      it('laisse une réservation glisser sur sa propre place', async () => {
        // Le déplacement est un UPDATE, pas un INSERT. La contrainte
        // d'exclusion s'y applique aussi, et elle compare la ligne modifiée aux
        // autres — pas à elle-même. Sans quoi reculer une réunion d'une
        // demi-heure se heurterait à son propre créneau.
        await book('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', 'À déplacer')
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) =>
            tx.execute(sql`
              update bookings
                 set starts_at = '2026-10-01T09:30:00Z', ends_at = '2026-10-01T10:30:00Z'
               where title = 'À déplacer'
            `),
          app.db,
        )

        assert.equal(await count(sql`starts_at = '2026-10-01T09:30:00Z'`), 1)
      })

      it('refuse un déplacement sur le créneau d’une autre réservation', async () => {
        await book('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', 'À déplacer')
        await book('2026-10-01T14:00:00Z', '2026-10-01T15:00:00Z', 'Occupante')

        assert.equal(
          await errorCode(() =>
            withTenant(
              DEFAULT_TENANT_ID,
              (tx) =>
                tx.execute(sql`
                  update bookings
                     set starts_at = '2026-10-01T14:30:00Z', ends_at = '2026-10-01T15:30:00Z'
                   where title = 'À déplacer'
                `),
              app.db,
            ),
          ),
          PG_EXCLUSION_VIOLATION,
        )
      })

      it('libère le créneau après annulation', async () => {
        await book('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z')
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) => tx.execute(sql`update bookings set status = 'cancelled', cancelled_at = now()`),
          app.db,
        )

        await book('2026-10-01T09:30:00Z', '2026-10-01T10:30:00Z')
        assert.equal(await count(sql`status = 'confirmed'`), 1)
      })

      it('départage deux réservations concurrentes sur le même créneau', async () => {
        const debut = '2026-10-01T14:00:00Z'
        const fin = '2026-10-01T15:00:00Z'
        const resultats = await Promise.allSettled([
          book(debut, fin, 'Premier'),
          book(debut, fin, 'Second'),
        ])

        assert.equal(resultats.filter((r) => r.status === 'fulfilled').length, 1)
        assert.equal(await count(), 1)
      })
    })

    describe('cohérence des lignes', () => {
      it('refuse un intervalle vide', async () => {
        assert.equal(
          await errorCode(() => book('2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z')),
          PG_CHECK_VIOLATION,
        )
      })

      it('exige le canal de la réservation', async () => {
        // Pas de valeur par défaut : chaque chemin d'écriture dit d'où il vient
        // (R05, ADR 018).
        const sansCanal = await errorCode(() =>
          withTenant(
            DEFAULT_TENANT_ID,
            (tx) =>
              tx.execute(sql`
                insert into bookings (resource_id, starts_at, ends_at, title)
                values (${RESOURCE_ID}, '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', 'Sans canal')
              `),
            app.db,
          ),
        )
        assert.equal(sansCanal, PG_NOT_NULL_VIOLATION)

        const canalInconnu = await errorCode(() =>
          withTenant(
            DEFAULT_TENANT_ID,
            (tx) =>
              tx.execute(sql`
                insert into bookings (resource_id, channel, starts_at, ends_at, title)
                values (${RESOURCE_ID}, 'telephone', '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', 'Canal inconnu')
              `),
            app.db,
          ),
        )
        assert.equal(canalInconnu, PG_INVALID_TEXT_REPRESENTATION)
      })

      it('refuse une annulation sans date d’annulation', async () => {
        await book('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z')
        const code = await errorCode(() =>
          withTenant(
            DEFAULT_TENANT_ID,
            (tx) => tx.execute(sql`update bookings set status = 'cancelled'`),
            app.db,
          ),
        )
        assert.equal(code, PG_CHECK_VIOLATION)
      })

      it('attribue le centre unique et un identifiant ordonné', async () => {
        await book('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', 'Première')
        await book('2026-10-01T11:00:00Z', '2026-10-01T12:00:00Z', 'Seconde')

        const rows = await withTenant(
          DEFAULT_TENANT_ID,
          (tx) => tx.execute(sql`select id, tenant_id, title from bookings order by id`),
          app.db,
        )
        assert.deepEqual(
          rows.map((r) => r.title),
          ['Première', 'Seconde'],
        )
        assert.equal(rows[0].tenant_id, DEFAULT_TENANT_ID)
        // Version 7 : 13e caractère hexadécimal de l’uuid.
        assert.equal(String(rows[0].id)[14], '7')
      })

      it('met à jour updated_at sans que le code y pense', async () => {
        await book('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z')
        const [avant] = await owner.client`select created_at, updated_at from bookings`
        await owner.client`update bookings set title = 'Renommée'`
        const [apres] = await owner.client`select created_at, updated_at from bookings`

        assert.deepEqual(apres.created_at, avant.created_at)
        assert.ok(apres.updated_at > avant.updated_at)
      })
    })

    describe('isolation par centre', () => {
      it('interroge la base avec un rôle soumis aux politiques', async () => {
        const [role] = await app.client`
          select current_user::text as name,
                 (select rolbypassrls from pg_roles where rolname = current_user) as bypass`
        // Sans ce garde-fou, tous les tests d'isolation qui suivent passeraient
        // à vide : BYPASSRLS l'emporte sur FORCE ROW LEVEL SECURITY.
        assert.equal(role.bypass, false)
        assert.notEqual(role.name, 'postgres')
      })

      it('ne renvoie rien hors contexte de centre', async () => {
        await book('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z')

        const horsContexte = await app.db.execute(sql`select count(*)::int as n from bookings`)
        assert.equal(horsContexte[0].n, 0)
        assert.equal(await count(), 1)
      })

      it('ne renvoie rien depuis un autre centre', async () => {
        await book('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z')
        await owner.client`
          insert into tenants (id, name, slug)
          values (${OTHER_TENANT_ID}, 'Autre centre', 'autre-centre')`

        const vu = await withTenant(
          OTHER_TENANT_ID,
          async (tx) => {
            const rows = await tx.execute(sql`select count(*)::int as n from bookings`)
            return rows[0].n as number
          },
          app.db,
        )
        assert.equal(vu, 0)
      })

      it('refuse une réservation sur la ressource d’un autre centre', async () => {
        await owner.client`
          insert into tenants (id, name, slug)
          values (${OTHER_TENANT_ID}, 'Autre centre', 'autre-centre')`

        const code = await errorCode(() =>
          withTenant(
            OTHER_TENANT_ID,
            (tx) =>
              tx.execute(sql`
                insert into bookings (resource_id, channel, starts_at, ends_at, title)
                values (${RESOURCE_ID}, 'staff', '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', 'Fuite')
              `),
            app.db,
          ),
        )
        // La ressource n’existe pas pour ce centre.
        assert.equal(code, PG_FOREIGN_KEY_VIOLATION)
      })
    })
  }
})
