import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql, type SQL } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import {
  PG_CHECK_VIOLATION,
  PG_CLIENT_BOOKING_REFUSED,
  PG_FOREIGN_KEY_VIOLATION,
  pgErrorCode,
} from '../../db/errors.ts'
import { createDatabase, withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'

/**
 * Réservation par un client connecté à son espace (R23, ADR 016 décision D4,
 * ADR 036), éprouvée contre la base, sous le rôle applicatif.
 *
 * Le réglage est par ressource : confirmation immédiate (devis figé), accord
 * de l'accueil, ou fermée au portail. C'est la base qui pose le statut d'une
 * réservation du portail : le code ne peut pas confirmer par erreur ce que
 * l'accueil doit valider. L'annulation par le client est tracée, et ne vaut
 * que pour une demande en attente, à venir (`canClientCancel`).
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('réservation depuis l’espace client', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const SALLE = '01a00000-0000-7000-8000-0000000b0a01'
  const VEHICULE = '01a00000-0000-7000-8000-0000000b0a02'
  const CASIER = '01a00000-0000-7000-8000-0000000b0a03'
  const DURAND = '01a00000-0000-7000-8000-0000000b0c01'
  const PETIT = '01a00000-0000-7000-8000-0000000b0c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000b0d01'
  const PAUL = '01a00000-0000-7000-8000-0000000b0d02'
  const ACCUEIL = '01a00000-0000-7000-8000-0000000b0e01'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)
  const asClients = <T>(clientIds: string[], run: (tx: Transaction) => Promise<T>) =>
    withClientScope(DEFAULT_TENANT_ID, clientIds, run, app.db)

  const codeErreur = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return pgErrorCode(error)
    }
    return undefined
  }

  /** Créneau d'une heure dans `jours` jours, à `heure` heures UTC. */
  const creneau = (jours: number, heure = 8): SQL =>
    sql`date_trunc('day', now()) + make_interval(days => ${jours}, hours => ${heure}),
        date_trunc('day', now()) + make_interval(days => ${jours}, hours => ${heure + 1})`

  /** Réservation déposée par Jeanne pour l'atelier Durand, depuis son espace. */
  const reserver = (
    tx: Transaction,
    {
      resource = SALLE,
      client = DURAND,
      member = JEANNE as string | null,
      jours = 3,
      heure = 8,
      devis = false,
      status = 'confirmed',
    } = {},
  ) =>
    tx.execute(sql`
      insert into bookings (
        resource_id, client_id, channel, status, title, starts_at, ends_at, booked_by_member_id,
        quote_unit, quote_quantity, quote_unit_price_cents, quote_vat_rate_bp, quote_currency, quoted_at
      ) values (
        ${resource}, ${client}, 'client', ${status}, 'Réunion', ${creneau(jours, heure)}, ${member},
        ${devis ? sql`'hour', 1, 2500, 2000, 'EUR', now()` : sql`null, null, null, null, null, null`}
      )
      returning id, status`)

  const ligne = async (id: string) => {
    const [row] = await asTenant((tx) =>
      tx.execute(sql`
        select status, cancelled_at, cancelled_by_member_id, cancelled_by_staff_id, booked_by_member_id
          from bookings where id = ${id}`),
    )
    return row
  }

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, clients, resources cascade`
    await owner.client`truncate table staff_members cascade`
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name, client_booking_mode) values
          (${SALLE}, 'salle', 'S-POR', 'Salle Europe', 'approval'),
          (${VEHICULE}, 'vehicule', 'V-POR', 'Utilitaire', 'instant'),
          (${CASIER}, 'casier', 'C-POR', 'Casier 12', 'closed')`)
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Boulangerie Petit', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, auth_user_id) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'u-jeanne'),
          (${PAUL}, ${PETIT}, 'paul@petit.fr', 'u-paul')`)
      await tx.execute(sql`insert into staff_members (id, email) values (${ACCUEIL}, 'accueil@centre.fr')`)
    })
  })

  after(async () => {
    await Promise.all([owner.client.end(), app.client.end()])
  })

  describe('réglage par ressource', () => {
    it('ouvre une nouvelle ressource sur accord de l’accueil : la valeur prudente', async () => {
      const [row] = await asTenant((tx) =>
        tx.execute(sql`
          insert into resources (resource_type, code, name) values ('salle', 'S-NEUVE', 'Salle neuve')
          returning client_booking_mode`),
      )
      assert.equal(row.client_booking_mode, 'approval')
    })

    it('met en attente de l’accueil, quel que soit le statut écrit par le code', async () => {
      const [row] = await asClients([DURAND], (tx) => reserver(tx, { devis: true, status: 'confirmed' }))
      assert.equal(row.status, 'pending')
    })

    it('confirme d’emblée une ressource à confirmation immédiate, devis figé', async () => {
      const [row] = await asClients([DURAND], (tx) =>
        reserver(tx, { resource: VEHICULE, devis: true, status: 'pending' }),
      )
      assert.equal(row.status, 'confirmed')
    })

    it('laisse en attente une confirmation immédiate sans devis : un prix ne s’engage pas à l’aveugle', async () => {
      const [row] = await asClients([DURAND], (tx) => reserver(tx, { resource: VEHICULE }))
      assert.equal(row.status, 'pending')
    })

    it('refuse une ressource fermée au portail, ou indisponible', async () => {
      assert.equal(
        await codeErreur(() => asClients([DURAND], (tx) => reserver(tx, { resource: CASIER }))),
        PG_CLIENT_BOOKING_REFUSED,
      )
      await asTenant((tx) =>
        tx.execute(sql`update resources set status = 'maintenance' where id = ${VEHICULE}`),
      )
      assert.equal(
        await codeErreur(() => asClients([DURAND], (tx) => reserver(tx, { resource: VEHICULE, devis: true }))),
        PG_CLIENT_BOOKING_REFUSED,
      )
    })

    it('suit le réglage aussi quand l’équipe saisit au nom d’une personne de l’entreprise', async () => {
      const [row] = await asTenant((tx) => reserver(tx, { devis: true }))
      assert.equal(row.status, 'pending')
    })

    it('ne touche ni aux réservations de l’équipe ni à la page publique', async () => {
      // Sans personne du portail : le réglage ne s'applique pas (ADR 005).
      const [equipe] = await asTenant((tx) => reserver(tx, { member: null, resource: CASIER }))
      assert.equal(equipe.status, 'confirmed')
    })

    it('n’accepte que la personne d’une entreprise de la réservation', async () => {
      assert.equal(
        await codeErreur(() => asTenant((tx) => reserver(tx, { member: PAUL }))),
        PG_FOREIGN_KEY_VIOLATION,
      )
    })
  })

  describe('écritures sous portée client', () => {
    it('exige la personne qui réserve', async () => {
      assert.equal(
        await codeErreur(() => asClients([DURAND], (tx) => reserver(tx, { member: null }))),
        PG_CLIENT_BOOKING_REFUSED,
      )
    })

    it('n’autorise d’autre modification que l’annulation d’une demande en attente', async () => {
      const [row] = await asClients([DURAND], (tx) => reserver(tx))
      const id = row.id as string
      assert.equal(
        await codeErreur(() =>
          asClients([DURAND], (tx) => tx.execute(sql`update bookings set title = 'Autre' where id = ${id}`)),
        ),
        PG_CLIENT_BOOKING_REFUSED,
      )
      // Confirmer soi-même sa demande : non.
      assert.equal(
        await codeErreur(() =>
          asClients([DURAND], (tx) =>
            tx.execute(sql`update bookings set status = 'confirmed' where id = ${id}`),
          ),
        ),
        PG_CLIENT_BOOKING_REFUSED,
      )
    })

    it('trace l’annulation par le client : qui, quand', async () => {
      const [row] = await asClients([DURAND], (tx) => reserver(tx))
      const id = row.id as string
      await asClients([DURAND], (tx) =>
        tx.execute(sql`
          update bookings
             set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'Annulée par le client',
                 cancelled_by_member_id = ${JEANNE}
           where id = ${id}`),
      )
      const annulee = await ligne(id)
      assert.equal(annulee.status, 'cancelled')
      assert.equal(annulee.cancelled_by_member_id, JEANNE)
      assert.ok(annulee.cancelled_at)
      assert.equal(annulee.booked_by_member_id, JEANNE)
    })
  })

  describe('règles de l’annulation par le client', () => {
    it('refuse au nom du client l’annulation d’une réservation confirmée, même depuis le back-office', async () => {
      const [row] = await asClients([DURAND], (tx) => reserver(tx, { resource: VEHICULE, devis: true }))
      assert.equal(row.status, 'confirmed')
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              update bookings set status = 'cancelled', cancelled_at = now(), cancelled_by_member_id = ${JEANNE}
               where id = ${row.id as string}`),
          ),
        ),
        PG_CLIENT_BOOKING_REFUSED,
      )
    })

    it('refuse l’annulation par le client d’une demande déjà commencée', async () => {
      const [row] = await asTenant((tx) => reserver(tx, { jours: -1 }))
      assert.equal(row.status, 'pending')
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              update bookings set status = 'cancelled', cancelled_at = now(), cancelled_by_member_id = ${JEANNE}
               where id = ${row.id as string}`),
          ),
        ),
        PG_CLIENT_BOOKING_REFUSED,
      )
    })

    it('garde l’auteur d’une réservation du portail', async () => {
      const [row] = await asTenant((tx) => reserver(tx))
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`update bookings set booked_by_member_id = null where id = ${row.id as string}`),
          ),
        ),
        PG_CLIENT_BOOKING_REFUSED,
      )
    })

    it('trace l’annulation par l’équipe, et un seul auteur', async () => {
      const [row] = await asTenant((tx) => reserver(tx))
      const id = row.id as string
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              update bookings
                 set status = 'cancelled', cancelled_at = now(),
                     cancelled_by_member_id = ${JEANNE}, cancelled_by_staff_id = ${ACCUEIL}
               where id = ${id}`),
          ),
        ),
        PG_CHECK_VIOLATION,
      )
      // Un auteur d'annulation sur une réservation qui ne l'est pas : non.
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`update bookings set cancelled_by_staff_id = ${ACCUEIL} where id = ${id}`),
          ),
        ),
        PG_CHECK_VIOLATION,
      )
      await asTenant((tx) =>
        tx.execute(sql`
          update bookings set status = 'cancelled', cancelled_at = now(), cancelled_by_staff_id = ${ACCUEIL}
           where id = ${id}`),
      )
      assert.equal((await ligne(id)).cancelled_by_staff_id, ACCUEIL)
    })
  })
})
