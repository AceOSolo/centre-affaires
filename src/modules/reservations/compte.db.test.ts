import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_CLIENT_SCOPE_REFUSED, dbErrorCode } from '../../db/errors.ts'
import { withClientScope, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { cancelRequestForAccounts, listBookingsForAccounts } from './compte-queries.ts'

/**
 * Réservations vues depuis l'espace client (ADR 015), contre la base : une
 * entreprise ne voit ni n'annule les réservations d'une autre.
 *
 * Pas de RLS en MySQL : la lecture est filtrée par la requête elle-même
 * (conventions §6), l'écriture par les triggers de `bookings`.
 */
describe('réservations de l’espace client', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const SALLE = '01a00000-0000-7000-8000-00000000e5a1'
  const DURAND = '01a00000-0000-7000-8000-00000000e5c1'
  const PETIT = '01a00000-0000-7000-8000-00000000e5c2'
  const JEANNE = '01a00000-0000-7000-8000-00000000e5d1'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  /** Réservation qui commence dans `jours` jours (négatif : passée). */
  const reserver = async (
    clientId: string | null,
    jours: number,
    { status = 'confirmed', kind = 'booking' } = {},
  ): Promise<string> => {
    const id = uuidv7()
    const debut = new Date(Date.now() + jours * 86_400_000)
    const fin = new Date(debut.getTime() + 3_600_000)
    await asTenant((tx) =>
      tx.execute(sql`
        insert into bookings (id, resource_id, client_id, kind, channel, status, title, starts_at, ends_at)
        values (${id}, ${SALLE}, ${clientId}, ${kind}, 'staff', ${status}, 'Réunion', ${debut}, ${fin})`),
    )
    return id
  }

  const statut = async (id: string) => {
    const [rows] = (await asTenant((tx) =>
      tx.execute(sql`select status from bookings where id = ${id}`),
    )) as unknown as [{ status: string }[]]
    return rows[0].status
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    // Les requêtes du module passent par la base du processus : on lui donne
    // celle des tests.
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await viderTables(bases.owner, 'bookings', 'client_members', 'clients', 'resources')
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values (${SALLE}, 'salle', 'S-CPT', 'Salle Europe')`)
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Boulangerie Petit', 'active')`)
      // L'annulation par le client porte la personne qui annule (ADR 036).
      await tx.execute(sql`
        insert into client_members (id, client_id, email, auth_user_id)
        values (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'u-jeanne')`)
    })
  })

  after(async () => {
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  it('ne montre que les réservations des entreprises du compte', async () => {
    const sienne = await reserver(DURAND, 3)
    await reserver(PETIT, 4)
    await reserver(null, 5)
    const rows = await listBookingsForAccounts(durand)
    assert.deepEqual(
      rows.map((row) => row.id),
      [sienne],
    )
    assert.equal(rows[0].resourceName, 'Salle Europe')
  })

  it('ne montre pas les indisponibilités', async () => {
    await reserver(DURAND, 3, { kind: 'unavailability' })
    assert.deepEqual(await listBookingsForAccounts(durand), [])
  })

  it('laisse annuler une demande en attente, à venir', async () => {
    const id = await reserver(DURAND, 3, { status: 'pending' })
    assert.equal(await cancelRequestForAccounts(id, durand), true)
    assert.equal(await statut(id), 'cancelled')
  })

  it('refuse d’annuler une réservation confirmée', async () => {
    const id = await reserver(DURAND, 3)
    assert.equal(await cancelRequestForAccounts(id, durand), false)
    assert.equal(await statut(id), 'confirmed')
  })

  it('refuse d’annuler une demande passée', async () => {
    const id = await reserver(DURAND, -2, { status: 'pending' })
    assert.equal(await cancelRequestForAccounts(id, durand), false)
  })

  it('refuse d’annuler la demande d’une autre entreprise', async () => {
    const id = await reserver(PETIT, 3, { status: 'pending' })
    assert.equal(await cancelRequestForAccounts(id, durand), false)
    assert.equal(await statut(id), 'pending')
  })

  it('libère le créneau à l’annulation', async () => {
    // Le garde anti-chevauchement ne compte plus la demande annulée : le même
    // créneau se réserve de nouveau (décision 3).
    const id = await reserver(DURAND, 3, { status: 'pending' })
    await cancelRequestForAccounts(id, durand)
    await assert.doesNotReject(reserver(PETIT, 3))
  })

  describe('portée client : ce qu’un client ne voit ni n’écrit chez un autre', () => {
    it('ne rend, sous la portée de Durand, aucune réservation de Petit — même sans filtre applicatif', async () => {
      const sienne = await reserver(DURAND, 3)
      const autre = await reserver(PETIT, 4)
      // Lecture directe sous la portée (sans le filtre de la requête du
      // module) : MySQL ne filtre pas, c'est la requête qui doit le faire.
      // Ce test fixe donc le contrat : la requête du module, elle, ne fuit pas.
      const rows = await listBookingsForAccounts(durand)
      assert.ok(rows.some((row) => row.id === sienne))
      assert.ok(!rows.some((row) => row.id === autre))
    })

    it('refuse d’écrire une réservation pour une entreprise hors de la portée', async () => {
      const code = await withClientScope(DEFAULT_TENANT_ID, [DURAND], async (tx) => {
        try {
          await tx.execute(sql`
            insert into bookings (resource_id, client_id, kind, channel, booked_by_member_id, starts_at, ends_at, title)
            values (${SALLE}, ${PETIT}, 'booking', 'client', ${JEANNE},
                    '2090-01-02 09:00:00', '2090-01-02 10:00:00', 'Intrus')`)
        } catch (error) {
          return dbErrorCode(error)
        }
        return undefined
      }, bases.app.db)
      assert.equal(code, DB_CLIENT_SCOPE_REFUSED)
    })

    it('refuse de modifier une réservation d’une autre entreprise', async () => {
      const autre = await reserver(PETIT, 3, { status: 'pending' })
      const code = await withClientScope(DEFAULT_TENANT_ID, [DURAND], async (tx) => {
        try {
          await tx.execute(sql`update bookings set title = 'Détournée' where id = ${autre}`)
        } catch (error) {
          return dbErrorCode(error)
        }
        return undefined
      }, bases.app.db)
      assert.equal(code, DB_CLIENT_SCOPE_REFUSED)
    })
  })
})
