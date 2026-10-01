import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { wallClockToUtc } from '../../lib/dates.ts'
import { isoWeekday, openingWindows } from '../ressources/ouverture.ts'
import { OPEN_ENDED_BOOKING_END } from './schema.ts'
import { weekDays } from './semaine.ts'
import {
  contractRuns,
  firstFreeStart,
  weekGridColumns,
  weekResourceRows,
  type GridBooking,
} from './semaine-ressources.ts'

const PARIS = 'Europe/Paris'
const at = (wall: string) => wallClockToUtc(wall, PARIS)

/** Ouverture 9h-18h du lundi au vendredi, fermé le week-end. */
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

// Semaine du lundi 5 octobre 2026.
const jours = weekDays('2026-10-07')
const colonnes = weekGridColumns(jours, PARIS, { openHour: 9, closeHour: 18 })
const ressources = [{ id: 'salle' }, { id: 'bureau' }]
const openingByResource = { salle: ouverture('salle', jours), bureau: ouverture('bureau', jours) }

describe('firstFreeStart', () => {
  const [lundi] = jours
  const plages = openingByResource.salle[lundi]

  it('propose l’ouverture quand rien n’est réservé', () => {
    assert.deepEqual(firstFreeStart(plages, []), at(`${lundi}T09:00`))
  })

  it('saute les réservations et arrondit au quart d’heure suivant', () => {
    const busy = [reservation('salle', `${lundi}T09:00`, `${lundi}T10:10`)]
    assert.deepEqual(firstFreeStart(plages, busy), at(`${lundi}T10:15`))
  })

  it('ne compte pas un reste de moins d’un quart d’heure', () => {
    const busy = [
      reservation('salle', `${lundi}T09:00`, `${lundi}T10:50`),
      reservation('salle', `${lundi}T11:00`, `${lundi}T18:00`),
    ]
    assert.equal(firstFreeStart(plages, busy), undefined)
  })
})

describe('weekResourceRows', () => {
  it('rend une ligne par ressource et une case par jour, dans l’ordre reçu', () => {
    const rows = weekResourceRows({
      resources: ressources,
      columns: colonnes,
      bookings: [],
      openingByResource,
      timeZone: PARIS,
    })
    assert.deepEqual(
      rows.map((row) => row.resource.id),
      ['salle', 'bureau'],
    )
    assert.ok(rows.every((row) => row.cells.length === 7))
    assert.deepEqual(
      rows[0].cells.map((cell) => cell.closed),
      jours.map((jour) => isoWeekday(jour) > 5),
    )
  })

  it('place une réservation dans sa case, à sa place sur la barre', () => {
    const [lundi, mardi] = jours
    const rows = weekResourceRows({
      resources: ressources,
      columns: colonnes,
      // 9h-12h sur une amplitude de 9h à 18h : le premier tiers de la barre.
      bookings: [reservation('salle', `${lundi}T09:00`, `${lundi}T12:00`)],
      openingByResource,
      timeZone: PARIS,
    })
    const [caseLundi, caseMardi] = rows[0].cells
    assert.equal(caseLundi.isoDate, lundi)
    assert.equal(caseLundi.bookings.length, 1)
    assert.equal(caseLundi.segments[0].leftPercent, 0)
    assert.ok(Math.abs(caseLundi.segments[0].widthPercent - 100 / 3) < 1e-9)
    assert.equal(caseLundi.firstFree, '12:00')
    assert.equal(caseMardi.isoDate, mardi)
    assert.equal(caseMardi.bookings.length, 0)
    assert.equal(caseMardi.firstFree, '09:00')
    // Le bureau n'est pas touché par la réservation de la salle.
    assert.equal(rows[1].cells[0].bookings.length, 0)
  })

  it('ignore les annulées, qui ont libéré leur créneau', () => {
    const [lundi] = jours
    const rows = weekResourceRows({
      resources: ressources,
      columns: colonnes,
      bookings: [reservation('salle', `${lundi}T09:00`, `${lundi}T18:00`, { status: 'cancelled' })],
      openingByResource,
      timeZone: PARIS,
    })
    assert.equal(rows[0].cells[0].bookings.length, 0)
    assert.equal(rows[0].cells[0].full, false)
  })

  it('dit complète une case ouverte sans quart d’heure libre', () => {
    const [lundi] = jours
    const rows = weekResourceRows({
      resources: ressources,
      columns: colonnes,
      bookings: [reservation('salle', `${lundi}T08:00`, `${lundi}T19:00`)],
      openingByResource,
      timeZone: PARIS,
    })
    assert.equal(rows[0].cells[0].full, true)
    assert.equal(rows[0].cells[0].firstFree, undefined)
    // Un jour fermé n'est jamais « complet » : il est fermé.
    assert.equal(rows[0].cells[5].full, false)
  })

  it('montre une réservation à cheval sur deux jours dans les deux cases', () => {
    const [lundi, mardi] = jours
    const rows = weekResourceRows({
      resources: ressources,
      columns: colonnes,
      bookings: [reservation('salle', `${lundi}T16:00`, `${mardi}T11:00`)],
      openingByResource,
      timeZone: PARIS,
    })
    assert.equal(rows[0].cells[0].bookings.length, 1)
    assert.equal(rows[0].cells[1].bookings.length, 1)
    assert.equal(rows[0].cells[1].firstFree, '11:00')
  })

  it('repère l’occupation d’un contrat sans terme sur toute la semaine', () => {
    const occupation = reservation('bureau', '2026-09-01T00:00', '2026-09-02T00:00', {
      kind: 'contract',
      title: 'Contrat CT-2026-0001',
      contractId: 'c1',
      endsAt: OPEN_ENDED_BOOKING_END,
    })
    const rows = weekResourceRows({
      resources: ressources,
      columns: colonnes,
      bookings: [occupation],
      openingByResource,
      timeZone: PARIS,
    })
    const bureau = rows[1]
    assert.ok(bureau.cells.every((cell) => cell.contract?.id === occupation.id))
    // Toute l'amplitude affichée est prise, et rien ne se propose à la réservation.
    assert.deepEqual(
      bureau.cells[0].segments.map(({ leftPercent, widthPercent }) => [leftPercent, widthPercent]),
      [[0, 100]],
    )
    assert.ok(bureau.cells.every((cell) => cell.firstFree === undefined))
  })
})

describe('contractRuns', () => {
  const contrat = (id: string) => ({ contract: reservation('bureau', '2026-10-05T00:00', '2026-10-06T00:00', { id }) })
  const libre = { contract: undefined }

  it('fusionne les jours consécutifs d’un même contrat', () => {
    const runs = contractRuns([libre, contrat('c1'), contrat('c1'), contrat('c1'), libre])
    assert.deepEqual(
      runs.map(({ start, span, contract }) => [start, span, contract?.id]),
      [
        [0, 1, undefined],
        [1, 3, 'c1'],
        [4, 1, undefined],
      ],
    )
  })

  it('sépare deux contrats qui se suivent, et ne fusionne jamais les cases libres', () => {
    const runs = contractRuns([contrat('c1'), contrat('c2'), libre, libre])
    assert.deepEqual(
      runs.map(({ start, span }) => [start, span]),
      [
        [0, 1],
        [1, 1],
        [2, 1],
        [3, 1],
      ],
    )
  })
})
