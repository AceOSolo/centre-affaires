import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { dbErrorCode } from '../../db/errors.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { addDaysToIsoDate, todayIsoDate, wallClockToUtc } from '../../lib/dates.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { findProposal } from '../facturation/propositions-queries.ts'
import { cancelRequestForAccounts } from './compte-queries.ts'
import { listPendingRequests } from './demandes-queries.ts'
import {
  OptionRefusedError,
  addOptionsToBooking,
  listFreeEquipment,
  listOptionsOf,
  syncOptionLinesAfterCancel,
} from './options-queries.ts'
import { createPortalBooking } from './portail-queries.ts'
import {
  BookingConflictError,
  assignBookingClient,
  cancelBooking,
  confirmBooking,
  createBooking,
  createBookingRequest,
  findBooking,
  listPendingBookings,
  moveBooking,
  refuseBooking,
} from './queries.ts'

/**
 * Matériel en option d'une réservation de salle (ADR 062), contre la base :
 *
 * - chaque appareil a son planning : le trigger anti-chevauchement le garde
 *   comme toute réservation, il n'est jamais loué deux fois (décision 3) ;
 * - une option suit sa salle — période, client, validation, déplacement,
 *   annulation — et la base refuse ce qui l'en détacherait (`CA018`) ;
 * - son prix est figé sur elle et s'ajoute au devis de la salle, sur
 *   plusieurs jours aussi (journées entamées, plafonnées à la semaine).
 */
describe('matériel en option d’une salle, de la base à l’écriture', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const SALLE = '01a00000-0000-7000-8000-000000062a01'
  const SALLE_2 = '01a00000-0000-7000-8000-000000062a02'
  const TV = '01a00000-0000-7000-8000-000000062e01'
  const CLIM = '01a00000-0000-7000-8000-000000062e02'
  const DURAND = '01a00000-0000-7000-8000-000000062c01'
  const MARTIN = '01a00000-0000-7000-8000-000000062c02'
  const JEANNE = '01a00000-0000-7000-8000-000000062d01'
  const GRILLE = '01a00000-0000-7000-8000-000000062b01'
  const TZ = 'Europe/Paris'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]
  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  /** Un lundi à venir, dans l'horizon du centre. */
  const lundi = (() => {
    let day = addDaysToIsoDate(todayIsoDate(TZ), 7)
    while (new Date(`${day}T12:00:00Z`).getUTCDay() !== 1) day = addDaysToIsoDate(day, 1)
    return day
  })()
  const jour = (offset: number, time: string) => wallClockToUtc(`${addDaysToIsoDate(lundi, offset)}T${time}`, TZ)

  const salle = (startsAt: Date, endsAt: Date, resourceId = SALLE, clientId: string | null = DURAND) =>
    createBooking({ resourceId, startsAt, endsAt, title: 'Séminaire', clientId })

  const demande = (startsAt: Date, endsAt: Date) =>
    createBookingRequest({
      resourceId: SALLE,
      startsAt,
      endsAt,
      title: 'Formation',
      clientId: DURAND,
      requesterName: 'Camille Dupont',
      requesterEmail: 'camille@exemple.test',
      requesterPhone: '0600000000',
      proposal: { product: 'espace', answers: { participants: 8, usage: 'formation' }, timeZone: TZ },
    })

  const ligne = (id: string) =>
    asTenant(async (tx) => {
      const [rows] = (await tx.execute(sql`
        select id, status, parent_booking_id, client_id, starts_at, ends_at, quote_unit, quote_quantity,
               quote_amount_cents, cancellation_reason
          from bookings where id = ${id}`)) as unknown as [Record<string, unknown>[]]
      return rows[0]
    })

  const refusParLaBase = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  const conflit = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      if (error instanceof BookingConflictError) return error
      throw error
    }
    return undefined
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await viderTables(
      bases.owner,
      'proposal_lines', 'proposals', 'document_sequences',
      'bookings', 'rate_plan_items', 'rate_plans', 'client_members', 'clients',
      'resources', 'opening_hours', 'closures',
    )
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name, client_booking_mode, attributes) values
          (${SALLE}, 'salle', 'S-062', 'Salle Mont Blanc', 'approval', json_object()),
          (${SALLE_2}, 'salle', 'S-063', 'Salle Cervin', 'approval', json_object()),
          (${TV}, 'materiel', 'TV-55', 'Télévision 55 pouces', 'instant', json_object('nature', 'Télévision')),
          (${CLIM}, 'materiel', 'CLIM-1', 'Climatiseur mobile', 'approval', json_object('nature', 'Climatisation'))`)
      await tx.execute(sql`
        insert into opening_hours (weekday, opens_at, closes_at) values
          (1, '08:00', '19:00'), (2, '08:00', '19:00'), (3, '08:00', '19:00'),
          (4, '08:00', '19:00'), (5, '08:00', '19:00'), (6, '08:00', '19:00')`)
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${MARTIN}, 'Cabinet Martin', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.test', 'Jeanne Martin', 'u-jeanne-062')`)
      await tx.execute(sql`insert into rate_plans (id, name, is_default) values (${GRILLE}, 'Tarifs publics', true)`)
      await tx.execute(sql`
        insert into rate_plan_items (rate_plan_id, resource_type, unit, amount_cents) values
          (${GRILLE}, 'salle', 'half_day', 9000),
          (${GRILLE}, 'salle', 'day', 13000),
          (${GRILLE}, 'materiel', 'day', 3000),
          (${GRILLE}, 'materiel', 'week', 12000)`)
    })
  })

  after(async () => {
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  describe('disponibilité d’un appareil', () => {
    it('propose les appareils libres sur la période de la salle, chiffrés ; pas celui déjà loué', async () => {
      const room = await salle(jour(0, '09:00'), jour(0, '18:00'))
      // La télévision est louée seule, à cheval sur la fin de la réunion.
      await createBooking({ resourceId: TV, startsAt: jour(0, '17:00'), endsAt: jour(1, '10:00'), title: 'Location seule' })
      const free = await listFreeEquipment(room)
      assert.deepEqual(free.map((device) => device.id), [CLIM])
      assert.deepEqual([free[0].quote?.unit, free[0].quote?.quantity, free[0].quote?.netCents], ['day', 1, 3000])
      // Bornes [) : une réservation de salle qui s'arrête à 17 h laisse la télévision libre.
      const before = await salle(jour(2, '09:00'), jour(2, '17:00'))
      await createBooking({ resourceId: TV, startsAt: jour(2, '17:00'), endsAt: jour(2, '19:00'), title: 'Soirée' })
      assert.deepEqual((await listFreeEquipment(before)).map((device) => device.id).sort(), [CLIM, TV].sort())
    })

    it('ne loue jamais deux fois le même appareil : la seconde salle se heurte à la base', async () => {
      const first = await salle(jour(0, '09:00'), jour(0, '13:00'))
      const second = await salle(jour(0, '11:00'), jour(0, '18:00'), SALLE_2, MARTIN)
      await addOptionsToBooking(first.id, [TV], null, TZ)
      const refused = await conflit(() => addOptionsToBooking(second.id, [TV, CLIM], null, TZ))
      assert.ok(refused, 'la télévision est déjà prise de 11 h à 13 h')
      assert.equal(refused.conflicts[0]?.resourceId, TV)
      // Tout ou rien : la climatisation demandée avec elle n'a pas été posée.
      assert.equal((await listOptionsOf([second.id])).length, 0)
      await addOptionsToBooking(second.id, [CLIM], null, TZ)
      assert.deepEqual((await listOptionsOf([second.id])).map((option) => option.resourceId), [CLIM])
    })
  })

  describe('une option ajoutée à une salle', () => {
    it('est une réservation liée : même période, même client, prix figé, ligne ajoutée au devis revalidé', async () => {
      const room = await demande(jour(0, '09:00'), jour(0, '13:00'))
      const before = await findProposal(room.proposal!.id)
      assert.equal(before?.status, 'ready')
      const outcome = await addOptionsToBooking(room.id, [TV], null, TZ)
      assert.equal(outcome.proposal, 'mis-a-jour')
      const [option] = outcome.added
      assert.equal(option.parentBookingId, room.id)
      assert.equal(option.clientId, DURAND)
      assert.equal(option.startsAt.getTime(), room.startsAt.getTime())
      assert.equal(option.endsAt.getTime(), room.endsAt.getTime())
      // La salle attend l'accueil : son matériel aussi.
      assert.equal(option.status, 'pending')
      assert.deepEqual([option.quoteUnit, option.quoteQuantity, option.quoteAmountCents], ['day', 1, 3000])

      const proposal = await findProposal(room.proposal!.id)
      assert.equal(proposal?.status, 'ready')
      assert.equal(proposal?.lines.length, 2)
      assert.match(proposal!.lines[1].label, /^Télévision 55 pouces — /)
      assert.equal(proposal!.lines[1].resourceId, TV)
      assert.equal(proposal!.lines[1].amountCents, 3000)
    })

    it('annulée seule, quitte le devis de la salle, qui reste valide', async () => {
      const room = await demande(jour(0, '09:00'), jour(0, '13:00'))
      const [tv] = (await addOptionsToBooking(room.id, [TV, CLIM], null, TZ)).added
      assert.equal((await findProposal(room.proposal!.id))?.lines.length, 3)
      await cancelBooking(tv.id, 'Plus besoin de la télévision')
      assert.equal(await syncOptionLinesAfterCancel(tv.id, null, TZ), 'mis-a-jour')
      const proposal = await findProposal(room.proposal!.id)
      assert.equal(proposal?.status, 'ready')
      assert.deepEqual(proposal?.lines.map((line) => line.resourceId), [SALLE, CLIM])
      // La salle garde sa climatisation.
      assert.equal((await ligne(room.id)).status, 'pending')
    })

    it('se chiffre sur plusieurs jours : journées entamées, plafonnées au prix de la semaine', async () => {
      const three = await salle(jour(0, '09:00'), jour(2, '18:00'))
      const [tv] = (await addOptionsToBooking(three.id, [TV], null, TZ)).added
      assert.deepEqual([tv.quoteUnit, tv.quoteQuantity, tv.quoteAmountCents], ['day', 3, 9000])
      // Du lundi au samedi 9 h : cinq journées (150 €) dépassent la semaine (120 €).
      const week = await salle(jour(7, '09:00'), jour(12, '09:00'))
      const [clim] = (await addOptionsToBooking(week.id, [CLIM], null, TZ)).added
      assert.deepEqual([clim.quoteUnit, clim.quoteQuantity, clim.quoteAmountCents], ['week', 1, 12000])
    })

    it('ne s’ajoute ni à une salle annulée, ni à une autre option', async () => {
      const room = await salle(jour(0, '09:00'), jour(0, '13:00'))
      const [tv] = (await addOptionsToBooking(room.id, [TV], null, TZ)).added
      await assert.rejects(addOptionsToBooking(tv.id, [CLIM], null, TZ), OptionRefusedError)
      await cancelBooking(room.id)
      await assert.rejects(addOptionsToBooking(room.id, [CLIM], null, TZ), OptionRefusedError)
    })
  })

  describe('la base tient les règles de l’option (CA018)', () => {
    const insererOption = (values: { resourceId: string; parentId: string; startsAt: Date; endsAt: Date; clientId: string | null }) =>
      asTenant((tx) =>
        tx.execute(sql`
          insert into bookings (id, resource_id, parent_booking_id, kind, channel, starts_at, ends_at, title, client_id)
          values (${uuidv7()}, ${values.resourceId}, ${values.parentId}, 'booking', 'staff',
                  ${values.startsAt}, ${values.endsAt}, 'Option', ${values.clientId})`),
      )

    it('refuse un appareil qui n’est pas du matériel, hors de la période, d’un autre client, ou sur une option', async () => {
      const room = await salle(jour(0, '09:00'), jour(0, '13:00'))
      const period = { startsAt: room.startsAt, endsAt: room.endsAt }
      assert.equal(await refusParLaBase(() => insererOption({ ...period, resourceId: SALLE_2, parentId: room.id, clientId: DURAND })), 'CA018')
      assert.equal(
        await refusParLaBase(() => insererOption({ resourceId: TV, parentId: room.id, startsAt: room.startsAt, endsAt: jour(0, '14:00'), clientId: DURAND })),
        'CA018',
      )
      assert.equal(await refusParLaBase(() => insererOption({ ...period, resourceId: TV, parentId: room.id, clientId: MARTIN })), 'CA018')
      const [tv] = (await addOptionsToBooking(room.id, [TV], null, TZ)).added
      assert.equal(await refusParLaBase(() => insererOption({ ...period, resourceId: CLIM, parentId: tv.id, clientId: DURAND })), 'CA018')
      // Une option ne change pas de salle.
      const other = await salle(jour(0, '09:00'), jour(0, '13:00'), SALLE_2)
      assert.equal(
        await refusParLaBase(() => asTenant((tx) => tx.execute(sql`update bookings set parent_booking_id = ${other.id} where id = ${tv.id}`))),
        'CA018',
      )
    })

    it('refuse d’annuler la salle tant que son matériel vit : la cascade ne peut pas être oubliée', async () => {
      const room = await salle(jour(0, '09:00'), jour(0, '13:00'))
      await addOptionsToBooking(room.id, [TV], null, TZ)
      const code = await refusParLaBase(() =>
        asTenant((tx) => tx.execute(sql`update bookings set status = 'cancelled', cancelled_at = now(3) where id = ${room.id}`)),
      )
      assert.equal(code, 'CA018')
    })
  })

  describe('l’option suit sa salle, dans la même transaction', () => {
    it('annuler la salle annule son matériel, qui redevient libre', async () => {
      const room = await salle(jour(0, '09:00'), jour(0, '13:00'))
      const [tv] = (await addOptionsToBooking(room.id, [TV], null, TZ)).added
      await cancelBooking(room.id, 'Réunion reportée')
      const option = await ligne(tv.id)
      assert.equal(option.status, 'cancelled')
      assert.equal(option.cancellation_reason, 'Réunion reportée')
      const other = await salle(jour(0, '10:00'), jour(0, '12:00'), SALLE_2)
      assert.ok((await listFreeEquipment(other)).some((device) => device.id === TV))
    })

    it('valider la demande valide son matériel, la refuser l’annule', async () => {
      const accepted = await demande(jour(0, '09:00'), jour(0, '13:00'))
      const [tv] = (await addOptionsToBooking(accepted.id, [TV], null, TZ)).added
      // Le matériel d'une demande en attente ne fait pas une seconde demande.
      const queue = await listPendingRequests()
      assert.deepEqual(queue.map((request) => request.id), [accepted.id])
      assert.deepEqual((await listPendingBookings()).map((booking) => booking.id), [accepted.id])
      // Une option ne se confirme pas avant sa salle.
      assert.equal(
        await refusParLaBase(() => asTenant((tx) => tx.execute(sql`update bookings set status = 'confirmed' where id = ${tv.id}`))),
        'CA018',
      )
      await confirmBooking(accepted.id)
      assert.equal((await ligne(tv.id)).status, 'confirmed')

      const refused = await demande(jour(1, '09:00'), jour(1, '13:00'))
      const [clim] = (await addOptionsToBooking(refused.id, [CLIM], null, TZ)).added
      await refuseBooking(refused.id, 'Salle indisponible')
      assert.equal((await ligne(clim.id)).status, 'cancelled')
    })

    it('déplacer la salle déplace son matériel ; un appareil pris sur la nouvelle période fait tout refuser', async () => {
      const room = await salle(jour(0, '09:00'), jour(0, '13:00'))
      const [tv] = (await addOptionsToBooking(room.id, [TV], null, TZ)).added
      await moveBooking({ id: room.id, resourceId: SALLE, startsAt: jour(2, '09:00'), endsAt: jour(3, '18:00') })
      const [moved] = await listOptionsOf([room.id])
      assert.equal(moved.id, tv.id)
      assert.equal(moved.startsAt.getTime(), jour(2, '09:00').getTime())
      assert.equal(moved.endsAt.getTime(), jour(3, '18:00').getTime())
      // Rechiffrée sur sa nouvelle période : deux journées.
      assert.deepEqual([moved.quote?.unit, moved.quote?.quantity], ['day', 2])

      await createBooking({ resourceId: TV, startsAt: jour(4, '10:00'), endsAt: jour(4, '11:00'), title: 'Location seule' })
      const refused = await conflit(() => moveBooking({ id: room.id, resourceId: SALLE, startsAt: jour(4, '09:00'), endsAt: jour(4, '13:00') }))
      assert.ok(refused)
      // La salle n'est pas partie sans son matériel.
      const still = await findBooking(room.id)
      assert.equal(still?.startsAt.getTime(), jour(2, '09:00').getTime())
      assert.equal((await listOptionsOf([room.id]))[0].startsAt.getTime(), jour(2, '09:00').getTime())
    })

    it('changer le client de la salle change celui de son matériel', async () => {
      const room = await salle(jour(0, '09:00'), jour(0, '13:00'))
      const [tv] = (await addOptionsToBooking(room.id, [TV], null, TZ)).added
      assert.deepEqual(await assignBookingClient(room.id, MARTIN), { ok: true })
      assert.equal((await ligne(tv.id)).client_id, MARTIN)
    })
  })

  describe('depuis l’espace client', () => {
    it('réserve la salle et son matériel en une fois, dans le même devis ; annuler la demande annule le matériel', async () => {
      const created = await createPortalBooking({
        account: durand[0],
        accounts: durand,
        resourceId: SALLE,
        startsAt: jour(0, '09:00'),
        endsAt: jour(0, '13:00'),
        title: 'Formation',
        notes: null,
        equipmentIds: [TV],
        proposal: { product: 'espace', answers: { participants: 8, usage: 'formation' }, requesterName: 'Jeanne Martin', requesterEmail: 'jeanne@durand.test', timeZone: TZ },
      })
      // La salle attend l'accord de l'accueil : la télévision, réglée en
      // confirmation immédiate, l'attend avec elle.
      assert.equal(created.status, 'pending')
      const [option] = await listOptionsOf([created.id])
      assert.equal(option.resourceId, TV)
      assert.equal(option.status, 'pending')
      assert.equal(created.options?.length, 1)

      const lines = await asTenant(async (tx) => {
        const [rows] = (await tx.execute(sql`
          select l.label, l.amount_cents from proposal_lines as l
            join proposals as p on p.id = l.proposal_id
           where p.booking_id = ${created.id} order by l.position`)) as unknown as [{ label: string; amount_cents: number }[]]
        return rows
      })
      assert.equal(lines.length, 2)
      assert.equal(lines[1].amount_cents, 3000)

      // Le matériel ne s'annule pas seul depuis l'espace client : il suit la salle.
      assert.equal(await cancelRequestForAccounts(option.id, durand), false)
      assert.equal(await cancelRequestForAccounts(created.id, durand), true)
      assert.equal((await ligne(option.id)).status, 'cancelled')
    })
  })
})
