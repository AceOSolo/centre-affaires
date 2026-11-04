import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { addDaysToIsoDate, dayRangeUtc, todayIsoDate, wallClockToUtc } from '../../lib/dates.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { findProposal } from '../facturation/propositions-queries.ts'
import { periodRejection } from './periode.ts'
import { loadPeriodAvailability } from './periode-queries.ts'
import { createPortalBooking, loadPortalPeriodAvailability } from './portail-queries.ts'
import { BookingConflictError, createBooking, createBookingRequest } from './queries.ts'

/**
 * Demandes et réservations sur plusieurs jours (ADR 061), contre la base :
 *
 * - le trigger anti-chevauchement garde une période de plusieurs jours comme
 *   un créneau d'une heure, bornes `[)`, y compris à travers le changement
 *   d'heure (décision 3) ;
 * - la disponibilité d'une période se lit en base, nuits comprises, sans rien
 *   révéler de ce qui occupe ;
 * - une période réservée depuis l'espace client est chiffrée à la journée et
 *   figée ; celle d'une demande publique part dans le devis avec ses deux
 *   jours (ADR 043, Dolibarr).
 */
describe('demandes sur plusieurs jours, de la base à l’écriture', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const CAMION = '01a00000-0000-7000-8000-000000061a01'
  const SALLE = '01a00000-0000-7000-8000-000000061a02'
  const DURAND = '01a00000-0000-7000-8000-000000061c01'
  const JEANNE = '01a00000-0000-7000-8000-000000061d01'
  const GRILLE = '01a00000-0000-7000-8000-000000061b01'
  const TZ = 'Europe/Paris'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]

  const at = (wallClock: string) => wallClockToUtc(wallClock, TZ)
  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  /** Un lundi à venir, dans l'horizon du centre. */
  const lundi = (() => {
    let day = addDaysToIsoDate(todayIsoDate(TZ), 7)
    while (new Date(`${day}T12:00:00Z`).getUTCDay() !== 1) day = addDaysToIsoDate(day, 1)
    return day
  })()
  const jour = (offset: number, time: string) => at(`${addDaysToIsoDate(lundi, offset)}T${time}`)

  const poser = (resourceId: string, startsAt: Date, endsAt: Date, title = 'Location') =>
    createBooking({ resourceId, startsAt, endsAt, title })

  const conflit = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      if (error instanceof BookingConflictError) return true
      throw error
    }
    return false
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
        insert into resources (id, resource_type, code, name, client_booking_mode) values
          (${CAMION}, 'vehicule', 'V-061', 'Camion 12 m³', 'instant'),
          (${SALLE}, 'salle', 'S-061', 'Salle Mont Blanc', 'approval')`)
      // Du lundi au samedi, 8 h – 19 h ; fermé le dimanche.
      await tx.execute(sql`
        insert into opening_hours (weekday, opens_at, closes_at) values
          (1, '08:00', '19:00'), (2, '08:00', '19:00'), (3, '08:00', '19:00'),
          (4, '08:00', '19:00'), (5, '08:00', '19:00'), (6, '08:00', '19:00')`)
      await tx.execute(sql`insert into clients (id, name, status) values (${DURAND}, 'Atelier Durand', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.test', 'Jeanne Martin', 'u-jeanne-061')`)
      await tx.execute(sql`insert into rate_plans (id, name, is_default) values (${GRILLE}, 'Tarifs publics', true)`)
      await tx.execute(sql`
        insert into rate_plan_items (rate_plan_id, resource_type, unit, amount_cents) values
          (${GRILLE}, 'vehicule', 'hour', 1500),
          (${GRILLE}, 'vehicule', 'day', 8000),
          (${GRILLE}, 'vehicule', 'week', 40000),
          (${GRILLE}, 'salle', 'half_day', 9000),
          (${GRILLE}, 'salle', 'day', 13000)`)
    })
  })

  after(async () => {
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  describe('garde anti-chevauchement (décision 3)', () => {
    it('une période de plusieurs jours bloque tout ce qu’elle couvre, nuits comprises ; ses voisines jointives passent', async () => {
      await poser(CAMION, jour(0, '09:00'), jour(2, '18:00'))
      // Mardi à 3 h du matin : la nuit appartient à la location.
      assert.equal(await conflit(() => poser(CAMION, jour(1, '03:00'), jour(1, '04:00'))), true)
      assert.equal(await conflit(() => poser(CAMION, jour(2, '17:45'), jour(2, '19:00'))), true)
      // Bornes [) : finie lundi 9 h, commencée mercredi 18 h.
      assert.equal(await conflit(() => poser(CAMION, jour(0, '08:00'), jour(0, '09:00'))), false)
      assert.equal(await conflit(() => poser(CAMION, jour(2, '18:00'), jour(2, '19:00'))), false)
      // Une autre ressource n'est pas concernée.
      assert.equal(await conflit(() => poser(SALLE, jour(1, '09:00'), jour(1, '12:00'))), false)
    })

    it('à travers le changement d’heure d’automne et de printemps', async () => {
      // Du samedi 24 au lundi 26 octobre 2026 : la nuit du 25 compte 25 heures.
      await poser(CAMION, at('2026-10-24T10:00'), at('2026-10-26T10:00'))
      // 2 h 30 se lit deux fois cette nuit-là : la seconde est retenue, dans la période.
      assert.equal(await conflit(() => poser(CAMION, at('2026-10-25T02:30'), at('2026-10-25T03:30'))), true)
      assert.equal(await conflit(() => poser(CAMION, at('2026-10-26T10:00'), at('2026-10-26T12:00'))), false)
      // Du samedi 27 au lundi 29 mars 2027 : la nuit du 28 compte 23 heures.
      await poser(CAMION, at('2027-03-27T10:00'), at('2027-03-29T10:00'))
      assert.equal(await conflit(() => poser(CAMION, at('2027-03-28T01:00'), at('2027-03-28T04:00'))), true)
      assert.equal(await conflit(() => poser(CAMION, at('2027-03-27T08:00'), at('2027-03-27T10:00'))), false)
    })
  })

  describe('disponibilité d’une période, lue en base', () => {
    it('rend les plages libres en continu, réservations et fermetures exceptionnelles retirées', async () => {
      await poser(CAMION, jour(1, '10:00'), jour(1, '12:00'))
      await asTenant((tx) =>
        tx.execute(sql`insert into closures (starts_on, ends_on, reason) values (${addDaysToIsoDate(lundi, 3)}, ${addDaysToIsoDate(lundi, 3)}, 'Inventaire')`),
      )
      const period = await asTenant((tx) =>
        loadPeriodAvailability(tx, { resourceId: CAMION, firstDate: lundi, dayCount: 5, timeZone: TZ }),
      )
      assert.deepEqual(
        period.free.map((range) => [range.startsAt.toISOString(), range.endsAt.toISOString()]),
        [
          [dayRangeUtc(lundi, TZ).startsAt.toISOString(), jour(1, '10:00').toISOString()],
          [jour(1, '12:00').toISOString(), dayRangeUtc(addDaysToIsoDate(lundi, 3), TZ).startsAt.toISOString()],
          [dayRangeUtc(addDaysToIsoDate(lundi, 4), TZ).startsAt.toISOString(), dayRangeUtc(addDaysToIsoDate(lundi, 4), TZ).endsAt.toISOString()],
        ],
      )
      // Du mardi midi au mercredi soir : libre. Jusqu'au jeudi : la fermeture bloque.
      assert.equal(periodRejection({ startsAt: jour(1, '12:00'), endsAt: jour(2, '18:00') }, period, TZ, 7), undefined)
      assert.equal(periodRejection({ startsAt: jour(1, '12:00'), endsAt: jour(4, '09:00') }, period, TZ, 7), 'creneau-indisponible')
      assert.equal(periodRejection({ startsAt: jour(0, '09:00'), endsAt: jour(1, '11:00') }, period, TZ, 7), 'creneau-indisponible')
    })
  })

  describe('depuis l’espace client', () => {
    it('lit la période dans la portée du client, puis réserve et fige le prix à la journée', async () => {
      const loaded = await loadPortalPeriodAvailability(durand, {
        resourceId: CAMION,
        firstDate: lundi,
        timeZone: TZ,
        maxDaysSettings: { vehicules: 3 },
      })
      assert.equal(loaded?.maxDays, 3)
      assert.equal(loaded?.period.days.length, 3)
      const range = { startsAt: jour(0, '09:00'), endsAt: jour(2, '09:00') }
      assert.equal(periodRejection(range, loaded!.period, TZ, loaded!.maxDays), undefined)

      const created = await createPortalBooking({
        account: durand[0],
        accounts: durand,
        resourceId: CAMION,
        ...range,
        title: 'Déménagement',
        notes: null,
      })
      // Confirmation immédiate, chiffrée : deux journées de 24 heures, jamais 48 heures.
      assert.equal(created.status, 'confirmed')
      assert.deepEqual([created.quote?.unit, created.quote?.quantity, created.quote?.netCents], ['day', 2, 16_000])
    })
  })

  describe('demande publique et devis transmis à Dolibarr', () => {
    it('porte la période en entier : ses deux jours sur la ligne, à la journée', async () => {
      const created = await createBookingRequest({
        resourceId: SALLE,
        startsAt: jour(0, '09:00'),
        endsAt: jour(1, '18:00'),
        title: 'Séminaire',
        requesterName: 'Camille Dupont',
        requesterEmail: 'camille@exemple.fr',
        requesterPhone: '0600000000',
        proposal: { product: 'espace', answers: { participants: 12, usage: 'seminaire' }, timeZone: TZ },
      })
      const detail = await findProposal(created.proposal!.id)
      const [line] = detail!.lines
      assert.equal(line.unit, 'day')
      assert.equal(line.quantity, 2)
      assert.equal(line.amountCents, 26_000)
      assert.match(line.label, /^Salle Mont Blanc — du lundi .+ 09:00 au mardi .+ 18:00$/)
    })
  })
})
