import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { PG_EXCLUSION_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'

/**
 * Cycle de vie d'une demande publique, éprouvé contre la base (ADR 005).
 *
 * Le pari de l'ADR est qu'une demande en attente **occupe** le créneau : c'est
 * ce qui empêche deux personnes de demander la même salle, et ce qui garantit
 * qu'une validation ne peut pas échouer. Ce fichier vérifie ce pari là où il se
 * joue — dans la contrainte d'exclusion, pas dans le code applicatif.
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

describe('demandes de réservation publiques', { skip: raison }, () => {
  {
    const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
    const app = createDatabase(appUrl ?? '')

    const RESOURCE_ID = '01999f00-0000-7000-8000-0000000000b1'

    /** Dépôt d'une demande, comme le fait `createBookingRequest`. */
    const demander = (
      start: string,
      end: string,
      email = 'camille@exemple.fr',
      title = 'Réunion de cadrage',
    ) =>
      withTenant(
        DEFAULT_TENANT_ID,
        (tx) =>
          tx.execute(sql`
            insert into bookings
              (resource_id, channel, starts_at, ends_at, title, status,
               requester_name, requester_email, requester_phone)
            values
              (${RESOURCE_ID}, 'public', ${start}, ${end}, ${title}, 'pending',
               'Camille Rousseau', ${email}, '06 12 34 56 78')
          `),
        app.db,
      )

    const lire = (where = sql`true`) =>
      withTenant(
        DEFAULT_TENANT_ID,
        (tx) => tx.execute(sql`select * from bookings where ${where} order by starts_at`),
        app.db,
      )

    const codeErreur = async (run: () => Promise<unknown>) => {
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
      await owner.client`truncate table bookings, resources cascade`
      await withTenant(
        DEFAULT_TENANT_ID,
        (tx) =>
          tx.execute(sql`
            insert into resources (id, resource_type, code, name, capacity)
            values (${RESOURCE_ID}, 'salle', 'S-MB', 'Salle Mont Blanc', 14)
          `),
        app.db,
      )
    })

    after(async () => {
      await Promise.all([owner.client.end(), app.client.end()])
    })

    describe('une demande en attente occupe le créneau', () => {
      it('empêche une seconde demande sur le même créneau', async () => {
        await demander('2026-10-05T09:00:00Z', '2026-10-05T11:00:00Z')
        assert.equal(
          await codeErreur(() => demander('2026-10-05T10:00:00Z', '2026-10-05T12:00:00Z')),
          PG_EXCLUSION_VIOLATION,
        )
      })

      it('empêche une réservation du staff par-dessus une demande', async () => {
        // Le sens qui compte le plus : le staff ne doit pas poser une
        // réservation ferme sur un créneau déjà demandé, sans s'en apercevoir.
        await demander('2026-10-05T09:00:00Z', '2026-10-05T11:00:00Z')
        const code = await codeErreur(() =>
          withTenant(
            DEFAULT_TENANT_ID,
            (tx) =>
              tx.execute(sql`
                insert into bookings (resource_id, channel, starts_at, ends_at, title)
                values (${RESOURCE_ID}, 'staff', '2026-10-05T10:00:00Z', '2026-10-05T12:00:00Z', 'Interne')
              `),
            app.db,
          ),
        )
        assert.equal(code, PG_EXCLUSION_VIOLATION)
      })

      it('laisse passer une demande jointive — bornes [)', async () => {
        await demander('2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z')
        await demander('2026-10-05T10:00:00Z', '2026-10-05T11:00:00Z')
        assert.equal((await lire()).length, 2)
      })

      it('départage deux dépôts simultanés sur le même créneau', async () => {
        const resultats = await Promise.allSettled([
          demander('2026-10-05T14:00:00Z', '2026-10-05T15:00:00Z', 'a@exemple.fr', 'Première'),
          demander('2026-10-05T14:00:00Z', '2026-10-05T15:00:00Z', 'b@exemple.fr', 'Seconde'),
        ])
        assert.equal(resultats.filter((r) => r.status === 'fulfilled').length, 1)
        assert.equal((await lire()).length, 1)
      })
    })

    describe('validation', () => {
      it('ne peut pas échouer sur un conflit : le créneau était déjà bloqué', async () => {
        // C'est l'argument central de l'ADR 005. Si `pending` ne bloquait pas,
        // la validation pourrait être refusée face à un client déjà prévenu.
        await demander('2026-10-05T09:00:00Z', '2026-10-05T11:00:00Z')
        const code = await codeErreur(() =>
          withTenant(
            DEFAULT_TENANT_ID,
            (tx) => tx.execute(sql`update bookings set status = 'confirmed'`),
            app.db,
          ),
        )
        assert.equal(code, undefined)
        assert.equal((await lire())[0].status, 'confirmed')
      })

      it('conserve les coordonnées du demandeur après validation', async () => {
        await demander('2026-10-05T09:00:00Z', '2026-10-05T11:00:00Z')
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) => tx.execute(sql`update bookings set status = 'confirmed'`),
          app.db,
        )
        const [ligne] = await lire()
        assert.equal(ligne.requester_email, 'camille@exemple.fr')
        assert.equal(ligne.requester_name, 'Camille Rousseau')
        assert.equal(ligne.requester_phone, '06 12 34 56 78')
      })

      it('date la confirmation et garde qui l’a donnée, sans qu’elle se réécrive (ADR 041)', async () => {
        const ACCUEIL = '01999f00-0000-7000-8000-0000000000d1'
        await owner.client`truncate table staff_members cascade`
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) => tx.execute(sql`insert into staff_members (id, email) values (${ACCUEIL}, 'accueil@centre.fr')`),
          app.db,
        )
        await demander('2026-10-05T09:00:00Z', '2026-10-05T11:00:00Z')
        const [enAttente] = await lire()
        assert.equal(enAttente.confirmed_at, null)

        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) => tx.execute(sql`update bookings set status = 'confirmed', confirmed_by_staff_id = ${ACCUEIL}`),
          app.db,
        )
        const [confirmee] = await lire()
        assert.ok(confirmee.confirmed_at)
        assert.equal(confirmee.confirmed_by_staff_id, ACCUEIL)

        // Ni la date ni l'auteur ne se réécrivent ensuite.
        const refus = await codeErreur(() =>
          withTenant(
            DEFAULT_TENANT_ID,
            (tx) => tx.execute(sql`update bookings set confirmed_at = now() - interval '1 day'`),
            app.db,
          ),
        )
        assert.equal(refus, 'P0001')

        // Une réservation du centre est confirmée, et datée, dès sa saisie.
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) =>
            tx.execute(sql`
              insert into bookings (resource_id, channel, starts_at, ends_at, title)
              values (${RESOURCE_ID}, 'staff', '2026-10-06T09:00:00Z', '2026-10-06T10:00:00Z', 'Interne')`),
          app.db,
        )
        const [interne] = await lire(sql`channel = 'staff'`)
        assert.ok(interne.confirmed_at)
        assert.equal(interne.confirmed_by_staff_id, null)
        await owner.client`truncate table staff_members cascade`
      })
    })

    describe('refus', () => {
      it('libère le créneau', async () => {
        await demander('2026-10-05T09:00:00Z', '2026-10-05T11:00:00Z')
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) =>
            tx.execute(sql`
              update bookings
                 set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'Salle indisponible'
            `),
          app.db,
        )

        await demander('2026-10-05T10:00:00Z', '2026-10-05T12:00:00Z')
        assert.equal((await lire(sql`status = 'pending'`)).length, 1)
      })

      it('garde la trace de la demande refusée', async () => {
        // Décision 6 : rien ne s'efface, une demande refusée reste consultable.
        await demander('2026-10-05T09:00:00Z', '2026-10-05T11:00:00Z')
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) =>
            tx.execute(sql`
              update bookings
                 set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'Salle indisponible'
            `),
          app.db,
        )
        const [ligne] = await lire()
        assert.equal(ligne.status, 'cancelled')
        assert.equal(ligne.cancellation_reason, 'Salle indisponible')
        assert.equal(ligne.requester_email, 'camille@exemple.fr')
      })
    })

    describe('réservation interne', () => {
      it('accepte une réservation sans demandeur', async () => {
        // Les colonnes du demandeur sont nulles pour une réservation posée par
        // le staff : aucune contrainte ne doit l'exiger.
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) =>
            tx.execute(sql`
              insert into bookings (resource_id, channel, starts_at, ends_at, title)
              values (${RESOURCE_ID}, 'staff', '2026-10-06T09:00:00Z', '2026-10-06T10:00:00Z', 'Interne')
            `),
          app.db,
        )
        const [ligne] = await lire()
        assert.equal(ligne.requester_email, null)
        assert.equal(ligne.status, 'confirmed')
      })
    })
  }
})
