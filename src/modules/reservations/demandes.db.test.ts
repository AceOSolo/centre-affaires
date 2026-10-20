import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_EXCLUSION_VIOLATION, dbErrorCode } from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'

/**
 * Cycle de vie d'une demande publique, éprouvé contre la base (ADR 005).
 *
 * Le pari de l'ADR est qu'une demande en attente **occupe** le créneau : c'est
 * ce qui empêche deux personnes de demander la même salle, et ce qui garantit
 * qu'une validation ne peut pas échouer. Ce fichier vérifie ce pari là où il se
 * joue — dans la trigger anti-chevauchement, pas dans le code applicatif.
 *
 *   TEST_DB_NAME=centre_affaires_test npm test
 */
describe('demandes de réservation publiques', { skip: raisonDeSaut }, () => {
  {
    let bases: TestDatabases

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
        bases.app.db,
      )

    const lire = async (where = sql`true`) => {
      const [rows] = (await withTenant(
        DEFAULT_TENANT_ID,
        (tx) => tx.execute(sql`select * from bookings where ${where} order by starts_at`),
        bases.app.db,
      )) as unknown as [Record<string, unknown>[]]
      return rows
    }

    const codeErreur = async (run: () => Promise<unknown>) => {
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
      await viderTables(bases.owner, 'bookings', 'resources')
      await withTenant(
        DEFAULT_TENANT_ID,
        (tx) =>
          tx.execute(sql`
            insert into resources (id, resource_type, code, name, capacity)
            values (${RESOURCE_ID}, 'salle', 'S-MB', 'Salle Mont Blanc', 14)
          `),
        bases.app.db,
      )
    })

    after(async () => {
      await bases.fermer()
    })

    describe('une demande en attente occupe le créneau', () => {
      it('empêche une seconde demande sur le même créneau', async () => {
        await demander('2026-10-05 09:00:00', '2026-10-05 11:00:00')
        assert.equal(
          await codeErreur(() => demander('2026-10-05 10:00:00', '2026-10-05 12:00:00')),
          DB_EXCLUSION_VIOLATION,
        )
      })

      it('empêche une réservation du staff par-dessus une demande', async () => {
        // Le sens qui compte le plus : le staff ne doit pas poser une
        // réservation ferme sur un créneau déjà demandé, sans s'en apercevoir.
        await demander('2026-10-05 09:00:00', '2026-10-05 11:00:00')
        const code = await codeErreur(() =>
          withTenant(
            DEFAULT_TENANT_ID,
            (tx) =>
              tx.execute(sql`
                insert into bookings (resource_id, channel, starts_at, ends_at, title)
                values (${RESOURCE_ID}, 'staff', '2026-10-05 10:00:00', '2026-10-05 12:00:00', 'Interne')
              `),
            bases.app.db,
          ),
        )
        assert.equal(code, DB_EXCLUSION_VIOLATION)
      })

      it('laisse passer une demande jointive — bornes [)', async () => {
        await demander('2026-10-05 09:00:00', '2026-10-05 10:00:00')
        await demander('2026-10-05 10:00:00', '2026-10-05 11:00:00')
        assert.equal((await lire()).length, 2)
      })

      it('départage deux dépôts simultanés sur le même créneau', async () => {
        const resultats = await Promise.allSettled([
          demander('2026-10-05 14:00:00', '2026-10-05 15:00:00', 'a@exemple.fr', 'Première'),
          demander('2026-10-05 14:00:00', '2026-10-05 15:00:00', 'b@exemple.fr', 'Seconde'),
        ])
        assert.equal(resultats.filter((r) => r.status === 'fulfilled').length, 1)
        assert.equal((await lire()).length, 1)
      })
    })

    describe('validation', () => {
      it('ne peut pas échouer sur un conflit : le créneau était déjà bloqué', async () => {
        // C'est l'argument central de l'ADR 005. Si `pending` ne bloquait pas,
        // la validation pourrait être refusée face à un client déjà prévenu.
        await demander('2026-10-05 09:00:00', '2026-10-05 11:00:00')
        const code = await codeErreur(() =>
          withTenant(
            DEFAULT_TENANT_ID,
            (tx) => tx.execute(sql`update bookings set status = 'confirmed'`),
            bases.app.db,
          ),
        )
        assert.equal(code, undefined)
        assert.equal((await lire())[0].status, 'confirmed')
      })

      it('conserve les coordonnées du demandeur après validation', async () => {
        await demander('2026-10-05 09:00:00', '2026-10-05 11:00:00')
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) => tx.execute(sql`update bookings set status = 'confirmed'`),
          bases.app.db,
        )
        const [ligne] = await lire()
        assert.equal(ligne.requester_email, 'camille@exemple.fr')
        assert.equal(ligne.requester_name, 'Camille Rousseau')
        assert.equal(ligne.requester_phone, '06 12 34 56 78')
      })

      it('date la confirmation et garde qui l’a donnée, sans qu’elle se réécrive (ADR 041)', async () => {
        const ACCUEIL = '01999f00-0000-7000-8000-0000000000d1'
        await viderTables(bases.owner, 'staff_members')
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) => tx.execute(sql`insert into staff_members (id, email) values (${ACCUEIL}, 'accueil@centre.fr')`),
          bases.app.db,
        )
        await demander('2026-10-05 09:00:00', '2026-10-05 11:00:00')
        const [enAttente] = await lire()
        assert.equal(enAttente.confirmed_at, null)

        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) => tx.execute(sql`update bookings set status = 'confirmed', confirmed_by_staff_id = ${ACCUEIL}`),
          bases.app.db,
        )
        const [confirmee] = await lire()
        assert.ok(confirmee.confirmed_at)
        assert.equal(confirmee.confirmed_by_staff_id, ACCUEIL)

        // Ni la date ni l'auteur ne se réécrivent ensuite.
        // Pas de code `CAnnn` : l'erreur remonte avec son message.
        await assert.rejects(
          withTenant(
            DEFAULT_TENANT_ID,
            (tx) => tx.execute(sql`update bookings set confirmed_at = date_sub(current_timestamp(3), interval 1 day)`),
            bases.app.db,
          ),
          (error) => {
            const message = String((error as { cause?: { sqlMessage?: string } }).cause?.sqlMessage ?? error)
            return /datée par la base/.test(message)
          },
        )

        // Une réservation du centre est confirmée, et datée, dès sa saisie.
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) =>
            tx.execute(sql`
              insert into bookings (resource_id, channel, starts_at, ends_at, title)
              values (${RESOURCE_ID}, 'staff', '2026-10-06 09:00:00', '2026-10-06 10:00:00', 'Interne')`),
          bases.app.db,
        )
        const [interne] = await lire(sql`channel = 'staff'`)
        assert.ok(interne.confirmed_at)
        assert.equal(interne.confirmed_by_staff_id, null)
        await viderTables(bases.owner, 'staff_members')
      })
    })

    describe('refus', () => {
      it('libère le créneau', async () => {
        await demander('2026-10-05 09:00:00', '2026-10-05 11:00:00')
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) =>
            tx.execute(sql`
              update bookings
                 set status = 'cancelled', cancelled_at = current_timestamp(3), cancellation_reason = 'Salle indisponible'
            `),
          bases.app.db,
        )

        await demander('2026-10-05 10:00:00', '2026-10-05 12:00:00')
        assert.equal((await lire(sql`status = 'pending'`)).length, 1)
      })

      it('garde la trace de la demande refusée', async () => {
        // Décision 6 : rien ne s'efface, une demande refusée reste consultable.
        await demander('2026-10-05 09:00:00', '2026-10-05 11:00:00')
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) =>
            tx.execute(sql`
              update bookings
                 set status = 'cancelled', cancelled_at = current_timestamp(3), cancellation_reason = 'Salle indisponible'
            `),
          bases.app.db,
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
              values (${RESOURCE_ID}, 'staff', '2026-10-06 09:00:00', '2026-10-06 10:00:00', 'Interne')
            `),
          bases.app.db,
        )
        const [ligne] = await lire()
        assert.equal(ligne.requester_email, null)
        assert.equal(ligne.status, 'confirmed')
      })
    })
  }
})
