import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { wallClockToUtc } from '../../lib/dates.ts'
import { openingWindows } from '../ressources/ouverture.ts'
import {
  dayOccupancy,
  monthDays,
  monthOfDate,
  monthResourceRows,
  occupancyCellDescription,
  occupancyCellText,
  occupancyLevel,
  occupancyPercent,
} from './mois.ts'
import { OPEN_ENDED_BOOKING_END } from './schema.ts'
import type { GridBooking } from './semaine-ressources.ts'

const PARIS = 'Europe/Paris'
const CLIENT = '01a00000-0000-7000-8000-0000000c0c01'
const at = (wall: string) => wallClockToUtc(wall, PARIS)

/** Ouverture 9h-18h (neuf heures) en semaine, fermé le week-end. */
const ouverture = (resourceId: string, jours: readonly string[]) =>
  Object.fromEntries(
    jours.map((jour) => [
      jour,
      openingWindows(jour, PARIS, {
        rules: [1, 2, 3, 4, 5].map((weekday) => ({
          resourceId: null,
          weekday,
          opensAt: '09:00:00',
          closesAt: '18:00:00',
        })),
        resourceId,
      }),
    ]),
  )

let sequence = 0
const reservation = (
  resourceId: string,
  start: string,
  end: string,
  overrides: Partial<GridBooking> = {},
): GridBooking => ({
  id: `b${++sequence}`,
  resourceId,
  kind: 'booking',
  status: 'confirmed',
  title: 'Réunion',
  startsAt: at(start),
  endsAt: at(end),
  clientId: null,
  contractId: null,
  ...overrides,
})

describe('monthDays et monthOfDate', () => {
  it('rend tous les jours du mois, années bissextiles comprises', () => {
    assert.equal(monthDays('2026-10').length, 31)
    assert.equal(monthDays('2026-02').length, 28)
    assert.equal(monthDays('2028-02').length, 29)
    assert.equal(monthDays('2026-12').at(-1), '2026-12-31')
    assert.equal(monthOfDate('2026-10-25'), '2026-10')
  })
})

describe('occupancyPercent', () => {
  it('n’a pas de taux sans heure d’ouverture', () => {
    assert.equal(occupancyPercent(0, 0), null)
  })

  it('ne dit 0 que si rien n’est pris, 100 que si tout l’est', () => {
    assert.equal(occupancyPercent(540, 0), 0)
    assert.equal(occupancyPercent(540, 2), 1)
    assert.equal(occupancyPercent(540, 538), 99)
    assert.equal(occupancyPercent(540, 540), 100)
    assert.equal(occupancyPercent(540, 270), 50)
  })
})

describe('occupancyLevel', () => {
  it('lit un jour fermé, avec ou sans réservation', () => {
    assert.equal(occupancyLevel({ openMinutes: 0, busyMinutes: 0, bookingCount: 0 }), 'ferme')
    assert.equal(occupancyLevel({ openMinutes: 0, busyMinutes: 0, bookingCount: 1 }), 'hors')
  })

  it('range le taux en quatre paliers', () => {
    assert.equal(occupancyLevel({ openMinutes: 540, busyMinutes: 0, bookingCount: 0 }), 'libre')
    assert.equal(occupancyLevel({ openMinutes: 540, busyMinutes: 120, bookingCount: 1 }), 'faible')
    assert.equal(occupancyLevel({ openMinutes: 540, busyMinutes: 270, bookingCount: 1 }), 'fort')
    assert.equal(occupancyLevel({ openMinutes: 540, busyMinutes: 540, bookingCount: 2 }), 'complet')
  })
})

describe('dayOccupancy', () => {
  const jour = '2026-10-05'
  const plages = ouverture('salle', [jour])[jour]

  it('ne compte que le temps pris dans l’ouverture', () => {
    // 8h-10h : seule l'heure de 9h à 10h est dans l'ouverture.
    assert.deepEqual(dayOccupancy(plages, [reservation('salle', `${jour}T08:00`, `${jour}T10:00`)]), {
      openMinutes: 540,
      busyMinutes: 60,
    })
  })

  it('ne compte pas deux fois des réservations jointives ou superposées', () => {
    const busy = [
      reservation('salle', `${jour}T09:00`, `${jour}T11:00`),
      reservation('salle', `${jour}T10:00`, `${jour}T12:00`),
    ]
    assert.equal(dayOccupancy(plages, busy).busyMinutes, 180)
  })
})

describe('monthResourceRows', () => {
  const jours = monthDays('2026-10')
  const openingByResource = { salle: ouverture('salle', jours), bureau: ouverture('bureau', jours) }

  it('calcule un taux par jour et un taux du mois par ressource', () => {
    const [row] = monthResourceRows({
      resources: [{ id: 'salle' }],
      days: jours,
      bookings: [
        // Jeudi 1er octobre : 4h30 sur 9h, soit 50 %.
        reservation('salle', '2026-10-01T09:00', '2026-10-01T13:30'),
        // Annulée : ne compte pas.
        reservation('salle', '2026-10-02T09:00', '2026-10-02T18:00', { status: 'cancelled' }),
      ],
      openingByResource,
      timeZone: PARIS,
    })
    assert.equal(row.cells.length, 31)
    assert.equal(row.cells[0].percent, 50)
    assert.equal(row.cells[0].level, 'fort')
    assert.equal(row.cells[1].percent, 0)
    assert.equal(row.cells[1].bookingCount, 0)
    // Samedi 3 octobre : fermé.
    assert.equal(row.cells[2].level, 'ferme')
    // 22 jours ouvrés de 9 h ; 4 h 30 occupées.
    assert.deepEqual(row.total, { openMinutes: 22 * 540, busyMinutes: 270, percent: 2 })
  })

  it('marque la journée de 25 heures sans fausser l’ouverture', () => {
    // Dimanche 25 octobre, changement d'heure : fermé, et rien ne déborde.
    const [row] = monthResourceRows({
      resources: [{ id: 'salle' }],
      days: jours,
      bookings: [reservation('salle', '2026-10-25T01:00', '2026-10-25T04:00')],
      openingByResource,
      timeZone: PARIS,
    })
    assert.equal(row.cells[24].isoDate, '2026-10-25')
    assert.equal(row.cells[24].level, 'hors')
    assert.equal(row.cells[25].level, 'libre')
  })

  it('lit un contrat sans terme comme une occupation de chaque jour, week-end compris', () => {
    const [row] = monthResourceRows({
      resources: [{ id: 'bureau' }],
      days: jours,
      bookings: [
        reservation('bureau', '2026-09-01T00:00', '2026-09-02T00:00', {
          kind: 'contract',
          title: 'Contrat CT-2026-0001',
          contractId: 'c1',
          clientId: CLIENT,
          endsAt: OPEN_ENDED_BOOKING_END,
        }),
      ],
      openingByResource,
      timeZone: PARIS,
      clientId: CLIENT,
    })
    assert.ok(row.cells.every((cell) => cell.level === 'contrat' && cell.clientPresent))
    assert.equal(row.cells[0].percent, 100)
    assert.equal(row.cells[2].percent, null)
    assert.equal(row.total.percent, 100)
  })

  it('signale la présence du client filtré, et seulement elle', () => {
    const [row] = monthResourceRows({
      resources: [{ id: 'salle' }],
      days: jours,
      bookings: [
        reservation('salle', '2026-10-05T09:00', '2026-10-05T10:00', { clientId: CLIENT }),
        reservation('salle', '2026-10-06T09:00', '2026-10-06T10:00'),
      ],
      openingByResource,
      timeZone: PARIS,
      clientId: CLIENT,
    })
    assert.equal(row.cells[4].clientPresent, true)
    assert.equal(row.cells[5].clientPresent, false)
  })
})

describe('occupancyCellText et occupancyCellDescription', () => {
  it('écrit l’état en toutes lettres pour les lecteurs d’écran', () => {
    const cellule = {
      isoDate: '2026-10-01',
      openMinutes: 540,
      busyMinutes: 270,
      percent: 50,
      level: 'fort' as const,
      bookingCount: 1,
      clientPresent: false,
    }
    assert.equal(occupancyCellText(cellule), '50')
    assert.equal(occupancyCellDescription(cellule), 'occupé à 50 %')
    assert.equal(occupancyCellText({ level: 'ferme', percent: null }), '–')
    assert.equal(
      occupancyCellDescription({ ...cellule, level: 'hors', percent: null, bookingCount: 2 }),
      'fermé, 2 réservations hors ouverture',
    )
  })
})
