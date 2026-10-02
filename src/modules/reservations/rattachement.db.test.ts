import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import {
  ContractOccupationLockedError,
  assignBookingClient,
  cancelBooking,
  createBooking,
  createBookingRequest,
  findBooking,
  findBookingClientLock,
  moveBooking,
} from './queries.ts'
import { BookingContractError } from './rattachement.ts'

/**
 * Canal et contrat d'une réservation (R05), par les requêtes du module :
 * chaque chemin de création dit d'où vient la réservation ; le rattachement à
 * un contrat exige le même client, un contrat actif et un créneau couvert ;
 * une occupation de contrat ne se modifie pas comme une réservation (ADR 018).
 *
 * Éprouvé sous `app_centre`, par le code qu'utilisent les écrans.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('canal et contrat des réservations', { skip: raison }, () => {
  // Les requêtes du module ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const ACME = '01a00000-0000-7000-8000-0000000e0c01'
  const BETA = '01a00000-0000-7000-8000-0000000e0c02'
  const SALLE = '01a00000-0000-7000-8000-0000000e0b01'
  const BUREAU = '01a00000-0000-7000-8000-0000000e0b02'
  const INCONNU = '01a00000-0000-7000-8000-0000000e0fff'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  /** Contrat d'Acme, du 1er mars au 30 juin 2026, dans l'état demandé. */
  const contrat = async (
    { status = 'active', clientId = ACME, resourceId = null as string | null } = {},
  ): Promise<string> => {
    const [row] = await asTenant((tx) =>
      tx.execute(sql`
        insert into contracts
          (client_id, contract_type, status, starts_on, ends_on, amount_cents, resource_id)
        values (${clientId}, 'bureau', ${status}, '2026-03-01', '2026-06-30', 90000, ${resourceId})
        returning id`),
    )
    return row.id as string
  }

  /** Réservation de salle, en heure de Paris (UTC+2 en avril). */
  const reservation = (contractId: string | null, overrides: { clientId?: string | null; day?: string } = {}) =>
    createBooking({
      resourceId: SALLE,
      startsAt: new Date(`${overrides.day ?? '2026-04-10'}T07:00:00Z`),
      endsAt: new Date(`${overrides.day ?? '2026-04-10'}T09:00:00Z`),
      title: 'Comité',
      clientId: overrides.clientId === undefined ? ACME : overrides.clientId,
      contractId,
    })

  const refus = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      assert.ok(error instanceof BookingContractError, `erreur inattendue : ${String(error)}`)
      return error.problem
    }
    assert.fail('le rattachement aurait dû être refusé')
  }

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources cascade`
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (id, name) values (${ACME}, 'Acme SAS'), (${BETA}, 'Beta SARL')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${SALLE}, 'salle', 'S-01', 'Salle Europe'),
          (${BUREAU}, 'bureau', 'BUR-01', 'Bureau 1')`)
    })
  })

  after(async () => {
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  describe('canal de chaque chemin de création', () => {
    it('back-office : accueil', async () => {
      const booking = await reservation(null)
      assert.equal(booking.channel, 'staff')
    })

    it('espace client : client', async () => {
      const booking = await createBookingRequest({
        resourceId: SALLE,
        startsAt: new Date('2026-04-11T07:00:00Z'),
        endsAt: new Date('2026-04-11T08:00:00Z'),
        title: 'Formation',
        clientId: ACME,
        requesterName: 'Jeanne Martin',
        requesterEmail: 'jeanne@example.test',
        requesterPhone: '0102030405',
      })
      assert.equal(booking.channel, 'client')
    })

    it('page publique : public', async () => {
      const booking = await createBookingRequest({
        resourceId: SALLE,
        startsAt: new Date('2026-04-12T07:00:00Z'),
        endsAt: new Date('2026-04-12T08:00:00Z'),
        title: 'Entretien',
        requesterName: 'Paul Durand',
        requesterEmail: 'paul@example.test',
        requesterPhone: '0102030406',
      })
      assert.equal(booking.channel, 'public')
    })
  })

  describe('rattachement à un contrat', () => {
    it('rattache une réservation du même client, pendant le contrat actif', async () => {
      const contractId = await contrat()
      const booking = await reservation(contractId)
      assert.equal(booking.contractId, contractId)
      assert.equal(booking.clientId, ACME)

      const detail = await findBooking(booking.id)
      assert.equal(detail?.contract?.id, contractId)
      assert.equal(detail?.contract?.status, 'active')
    })

    it('refuse le contrat d’un autre client', async () => {
      const contractId = await contrat({ clientId: BETA })
      assert.equal(await refus(() => reservation(contractId)), 'autre-client')
    })

    it('refuse sans client sur la réservation', async () => {
      const contractId = await contrat()
      assert.equal(await refus(() => reservation(contractId, { clientId: null })), 'sans-client')
    })

    it('refuse un brouillon', async () => {
      const contractId = await contrat({ status: 'draft' })
      assert.equal(await refus(() => reservation(contractId)), 'pas-actif')
    })

    it('refuse un contrat archivé', async () => {
      const contractId = await contrat()
      await asTenant((tx) =>
        tx.execute(sql`update contracts set deleted_at = now() where id = ${contractId}`),
      )
      assert.equal(await refus(() => reservation(contractId)), 'pas-actif')
    })

    it('refuse un créneau hors de la période du contrat', async () => {
      const contractId = await contrat()
      assert.equal(await refus(() => reservation(contractId, { day: '2026-07-01' })), 'hors-periode')
    })

    it('refuse un contrat inconnu', async () => {
      assert.equal(await refus(() => reservation(INCONNU)), 'introuvable')
    })

    it('n’écrit rien quand le rattachement est refusé', async () => {
      const contractId = await contrat({ clientId: BETA })
      await refus(() => reservation(contractId))
      const [row] = await asTenant((tx) =>
        tx.execute(sql`select count(*)::int as n from bookings`),
      )
      assert.equal(row.n, 0)
    })

    it('refuse de déplacer la réservation hors de la période, et la laisse en place', async () => {
      const contractId = await contrat()
      const booking = await reservation(contractId)
      assert.equal(
        await refus(() =>
          moveBooking({
            id: booking.id,
            resourceId: SALLE,
            startsAt: new Date('2026-07-02T07:00:00Z'),
            endsAt: new Date('2026-07-02T08:00:00Z'),
          }),
        ),
        'hors-periode',
      )
      assert.equal((await findBooking(booking.id))?.startsAt.toISOString(), '2026-04-10T07:00:00.000Z')
    })

    it('déplace la réservation à l’intérieur de la période', async () => {
      const contractId = await contrat()
      const booking = await reservation(contractId)
      const moved = await moveBooking({
        id: booking.id,
        resourceId: SALLE,
        startsAt: new Date('2026-05-02T07:00:00Z'),
        endsAt: new Date('2026-05-02T08:00:00Z'),
      })
      assert.equal(moved.contractId, contractId)
    })

    it('détache le contrat quand la réservation change de client', async () => {
      const contractId = await contrat()
      const booking = await reservation(contractId)

      await assignBookingClient(booking.id, ACME)
      assert.equal((await findBooking(booking.id))?.contractId, contractId)

      assert.deepEqual(await assignBookingClient(booking.id, BETA), { ok: true })
      const detail = await findBooking(booking.id)
      assert.equal(detail?.clientId, BETA)
      assert.equal(detail?.contractId, null)
    })

    it('refuse, avec sa raison, de changer le client d’une réservation faite depuis l’espace client', async () => {
      const [row] = await asTenant(async (tx) => {
        await tx.execute(sql`update resources set client_booking_mode = 'approval' where id = ${SALLE}`)
        const [membre] = await tx.execute(sql`
          insert into client_members (client_id, email, full_name, auth_user_id)
          values (${ACME}, 'jeanne@acme.test', 'Jeanne Martin', 'u-jeanne') returning id`)
        return tx.execute(sql`
          insert into bookings (resource_id, client_id, channel, booked_by_member_id, starts_at, ends_at, title)
          values (${SALLE}, ${ACME}, 'client', ${membre.id as string}, '2026-04-10T07:00:00Z', '2026-04-10T08:00:00Z', 'Atelier')
          returning id`)
      })
      const id = row.id as string
      for (const autre of [BETA, null]) {
        const outcome = await assignBookingClient(id, autre)
        assert.equal(outcome.ok, false)
        assert.match(outcome.ok ? '' : outcome.message, /espace client/)
      }
      assert.equal(await findBookingClientLock(id), 'espace-client')
      assert.equal((await findBooking(id))?.clientId, ACME)
      // Le même client : rien à changer, rien de refusé.
      assert.deepEqual(await assignBookingClient(id, ACME), { ok: true })
    })
  })

  describe('occupation de contrat', () => {
    const occupation = async () => {
      const contractId = await contrat({ resourceId: BUREAU })
      const [row] = await asTenant((tx) =>
        tx.execute(sql`select id from bookings where contract_id = ${contractId} and kind = 'contract'`),
      )
      return { contractId, id: row.id as string }
    }

    it('renvoie au contrat sur sa fiche', async () => {
      const { id, contractId } = await occupation()
      const detail = await findBooking(id)
      assert.equal(detail?.kind, 'contract')
      assert.equal(detail?.contract?.id, contractId)
      assert.equal(detail?.channel, 'staff')
    })

    it('ne s’annule pas comme une réservation, sans erreur brute', async () => {
      const { id } = await occupation()
      await cancelBooking(id, 'Essai')
      assert.equal((await findBooking(id))?.status, 'confirmed')
    })

    it('ne se déplace pas comme une réservation', async () => {
      const { id } = await occupation()
      await assert.rejects(
        moveBooking({
          id,
          resourceId: SALLE,
          startsAt: new Date('2026-04-10T07:00:00Z'),
          endsAt: new Date('2026-04-10T08:00:00Z'),
        }),
        ContractOccupationLockedError,
      )
    })

    it('ne change pas de client comme une réservation', async () => {
      const { id } = await occupation()
      await assignBookingClient(id, BETA)
      assert.equal((await findBooking(id))?.clientId, ACME)
    })
  })
})
