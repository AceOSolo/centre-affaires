import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import {
  DB_CHECK_VIOLATION,
  DB_CLIENT_BOOKING_REFUSED,
  DB_FOREIGN_KEY_VIOLATION,
  dbErrorCode,
} from '../../db/errors.ts'
import { withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { uuidv7 } from '../../lib/uuid.ts'

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
describe('réservation depuis l’espace client', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const SALLE = '01a00000-0000-7000-8000-0000000b0a01'
  const VEHICULE = '01a00000-0000-7000-8000-0000000b0a02'
  const CASIER = '01a00000-0000-7000-8000-0000000b0a03'
  const DURAND = '01a00000-0000-7000-8000-0000000b0c01'
  const PETIT = '01a00000-0000-7000-8000-0000000b0c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000b0d01'
  const PAUL = '01a00000-0000-7000-8000-0000000b0d02'
  const ACCUEIL = '01a00000-0000-7000-8000-0000000b0e01'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)
  const asClients = <T>(clientIds: string[], run: (tx: Transaction) => Promise<T>) =>
    withClientScope(DEFAULT_TENANT_ID, clientIds, run, bases.app.db)

  const codeErreur = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  /** Créneau d'une heure dans `jours` jours, à `heure` heures UTC. */
  const creneau = (jours: number, heure = 8) => {
    const debut = new Date()
    debut.setUTCHours(heure, 0, 0, 0)
    debut.setUTCDate(debut.getUTCDate() + jours)
    return { debut, fin: new Date(debut.getTime() + 3_600_000) }
  }

  /** Réservation déposée par Jeanne pour l'atelier Durand, depuis son espace. */
  const reserver = async (
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
  ) => {
    // Pas de RETURNING en MySQL : l'identifiant est posé ici, la ligne relue
    // ensuite — c'est le statut posé par la base qu'on veut lire.
    const id = uuidv7()
    const { debut, fin } = creneau(jours, heure)
    await tx.execute(sql`
      insert into bookings (
        id, resource_id, client_id, channel, status, title, starts_at, ends_at, booked_by_member_id,
        quote_unit, quote_quantity, quote_unit_price_cents, quote_vat_rate_bp, quote_currency, quoted_at
      ) values (
        ${id}, ${resource}, ${client}, 'client', ${status}, 'Réunion', ${debut}, ${fin}, ${member},
        ${devis ? sql`'hour', 1, 2500, 2000, 'EUR', current_timestamp(3)` : sql`null, null, null, null, null, null`}
      )`)
    const [rows] = (await tx.execute(sql`select id, status from bookings where id = ${id}`)) as unknown as [
      { id: string; status: string }[],
    ]
    return rows
  }

  const ligne = async (id: string) => {
    const [rows] = (await asTenant((tx) =>
      tx.execute(sql`
        select status, cancelled_at, cancelled_by_member_id, cancelled_by_staff_id, booked_by_member_id
          from bookings where id = ${id}`),
    )) as unknown as [Record<string, unknown>[]]
    return rows[0]
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
  })

  beforeEach(async () => {
    await viderTables(bases.owner, 'bookings', 'client_members', 'clients', 'resources', 'staff_members')
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
    await bases.fermer()
  })

  describe('réglage par ressource', () => {
    it('ouvre une nouvelle ressource sur accord de l’accueil : la valeur prudente', async () => {
      const id = uuidv7()
      const [rows] = (await asTenant(async (tx) => {
        await tx.execute(sql`
          insert into resources (id, resource_type, code, name) values (${id}, 'salle', 'S-NEUVE', 'Salle neuve')`)
        return tx.execute(sql`select client_booking_mode from resources where id = ${id}`)
      })) as unknown as [{ client_booking_mode: string }[]]
      assert.equal(rows[0].client_booking_mode, 'approval')
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
        DB_CLIENT_BOOKING_REFUSED,
      )
      await asTenant((tx) =>
        tx.execute(sql`update resources set status = 'maintenance' where id = ${VEHICULE}`),
      )
      assert.equal(
        await codeErreur(() => asClients([DURAND], (tx) => reserver(tx, { resource: VEHICULE, devis: true }))),
        DB_CLIENT_BOOKING_REFUSED,
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
        DB_FOREIGN_KEY_VIOLATION,
      )
    })
  })

  describe('écritures sous portée client', () => {
    it('exige la personne qui réserve', async () => {
      assert.equal(
        await codeErreur(() => asClients([DURAND], (tx) => reserver(tx, { member: null }))),
        DB_CLIENT_BOOKING_REFUSED,
      )
    })

    it('n’autorise d’autre modification que l’annulation d’une demande en attente', async () => {
      const [row] = await asClients([DURAND], (tx) => reserver(tx))
      const id = row.id as string
      assert.equal(
        await codeErreur(() =>
          asClients([DURAND], (tx) => tx.execute(sql`update bookings set title = 'Autre' where id = ${id}`)),
        ),
        DB_CLIENT_BOOKING_REFUSED,
      )
      // Confirmer soi-même sa demande : non.
      assert.equal(
        await codeErreur(() =>
          asClients([DURAND], (tx) =>
            tx.execute(sql`update bookings set status = 'confirmed' where id = ${id}`),
          ),
        ),
        DB_CLIENT_BOOKING_REFUSED,
      )
    })

    it('trace l’annulation par le client : qui, quand', async () => {
      const [row] = await asClients([DURAND], (tx) => reserver(tx))
      const id = row.id as string
      await asClients([DURAND], (tx) =>
        tx.execute(sql`
          update bookings
             set status = 'cancelled', cancelled_at = current_timestamp(3), cancellation_reason = 'Annulée par le client',
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
              update bookings set status = 'cancelled', cancelled_at = current_timestamp(3), cancelled_by_member_id = ${JEANNE}
               where id = ${row.id as string}`),
          ),
        ),
        DB_CLIENT_BOOKING_REFUSED,
      )
    })

    it('refuse l’annulation par le client d’une demande déjà commencée', async () => {
      const [row] = await asTenant((tx) => reserver(tx, { jours: -1 }))
      assert.equal(row.status, 'pending')
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              update bookings set status = 'cancelled', cancelled_at = current_timestamp(3), cancelled_by_member_id = ${JEANNE}
               where id = ${row.id as string}`),
          ),
        ),
        DB_CLIENT_BOOKING_REFUSED,
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
        DB_CLIENT_BOOKING_REFUSED,
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
                 set status = 'cancelled', cancelled_at = current_timestamp(3),
                     cancelled_by_member_id = ${JEANNE}, cancelled_by_staff_id = ${ACCUEIL}
               where id = ${id}`),
          ),
        ),
        DB_CHECK_VIOLATION,
      )
      // Un auteur d'annulation sur une réservation qui ne l'est pas : non.
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`update bookings set cancelled_by_staff_id = ${ACCUEIL} where id = ${id}`),
          ),
        ),
        DB_CHECK_VIOLATION,
      )
      await asTenant((tx) =>
        tx.execute(sql`
          update bookings set status = 'cancelled', cancelled_at = current_timestamp(3), cancelled_by_staff_id = ${ACCUEIL}
           where id = ${id}`),
      )
      assert.equal((await ligne(id)).cancelled_by_staff_id, ACCUEIL)
    })
  })
})
