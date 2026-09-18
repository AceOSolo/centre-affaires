import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatTime } from '../../lib/dates.ts'
import {
  blockGeometry,
  hourTicks,
  planningHeightPx,
  planningWindow,
  type PlanningWindow,
} from './planning.ts'

const PARIS = 'Europe/Paris'
const at = (iso: string) => new Date(iso)
const range = (start: string, end: string) => ({ startsAt: at(start), endsAt: at(end) })

/** Durée de la fenêtre en heures, arrondie au centième. */
const hours = (window: PlanningWindow) =>
  Math.round(((window.endsAt.getTime() - window.startsAt.getTime()) / 3_600_000) * 100) / 100

describe('planningWindow', () => {
  it("s'en tient aux heures d'ouverture quand rien n'en déborde", () => {
    const window = planningWindow('2026-07-15', PARIS, [
      range('2026-07-15T08:00:00Z', '2026-07-15T09:00:00Z'), // 10h-11h à Paris
    ])
    assert.equal(formatTime(window.startsAt, PARIS), '07:00')
    assert.equal(formatTime(window.endsAt, PARIS), '20:00')
  })

  it("s'élargit à l'heure pleine pour une réservation matinale", () => {
    // 06h15 à Paris, avant l'ouverture affichée.
    const window = planningWindow('2026-07-15', PARIS, [
      range('2026-07-15T04:15:00Z', '2026-07-15T05:00:00Z'),
    ])
    assert.equal(formatTime(window.startsAt, PARIS), '06:00')
  })

  it("s'élargit pour une réservation qui finit tard", () => {
    // 21h00-22h30 à Paris.
    const window = planningWindow('2026-07-15', PARIS, [
      range('2026-07-15T19:00:00Z', '2026-07-15T20:30:00Z'),
    ])
    assert.equal(formatTime(window.endsAt, PARIS), '23:00')
  })

  it('ne déborde jamais sur le jour suivant', () => {
    // Une réservation qui court jusqu'au lendemain matin : la fenêtre s'arrête
    // à minuit, le reste s'affiche le jour d'après.
    const window = planningWindow('2026-07-15', PARIS, [
      range('2026-07-15T20:00:00Z', '2026-07-16T06:00:00Z'),
    ])
    assert.equal(window.endsAt.toISOString(), '2026-07-15T22:00:00.000Z')
  })

  it('couvre 25 heures au retour à l’heure d’hiver', () => {
    // Nuit du 25 octobre 2026 : 03h00 CEST revient à 02h00 CET.
    const window = planningWindow('2026-10-25', PARIS, [], { openHour: 0, closeHour: 24 })
    assert.equal(hours(window), 25)
  })

  it('couvre 23 heures au passage à l’heure d’été', () => {
    // Nuit du 29 mars 2026 : 02h00 CET saute à 03h00 CEST.
    const window = planningWindow('2026-03-29', PARIS, [], { openHour: 0, closeHour: 24 })
    assert.equal(hours(window), 23)
  })
})

describe('blockGeometry', () => {
  const window = planningWindow('2026-07-15', PARIS) // 07h-20h, 13 heures

  it('place une réservation au prorata de la fenêtre', () => {
    // 08h00-09h00 à Paris : une heure sur treize, après une heure écoulée.
    const geometry = blockGeometry(range('2026-07-15T06:00:00Z', '2026-07-15T07:00:00Z'), window)
    assert.ok(geometry)
    assert.equal(Math.round(geometry.topPercent * 100) / 100, Math.round((100 / 13) * 100) / 100)
    assert.equal(Math.round(geometry.heightPercent * 100) / 100, Math.round((100 / 13) * 100) / 100)
  })

  it('commence en haut quand la réservation ouvre la fenêtre', () => {
    const geometry = blockGeometry(range('2026-07-15T05:00:00Z', '2026-07-15T06:00:00Z'), window)
    assert.equal(geometry?.topPercent, 0)
  })

  it('rogne une réservation qui déborde de la fenêtre', () => {
    // 06h00-08h00 à Paris : la première heure est hors plage.
    const geometry = blockGeometry(range('2026-07-15T04:00:00Z', '2026-07-15T06:00:00Z'), window)
    assert.ok(geometry)
    assert.equal(geometry.topPercent, 0)
    assert.equal(Math.round(geometry.heightPercent * 100) / 100, Math.round((100 / 13) * 100) / 100)
  })

  it('ne dessine rien pour une réservation hors fenêtre', () => {
    // 02h00-03h00 à Paris, bien avant l'ouverture.
    assert.equal(
      blockGeometry(range('2026-07-15T00:00:00Z', '2026-07-15T01:00:00Z'), window),
      undefined,
    )
  })

  it('ne dessine rien pour une réservation jointive à la borne haute', () => {
    // Commence exactement à 20h00, la fin de la fenêtre : bornes `[)`.
    assert.equal(
      blockGeometry(range('2026-07-15T18:00:00Z', '2026-07-15T19:00:00Z'), window),
      undefined,
    )
  })
})

describe('hourTicks', () => {
  it('gradue chaque heure, bornes comprises', () => {
    const window = planningWindow('2026-07-15', PARIS)
    const ticks = hourTicks(window)
    assert.equal(ticks.length, 14) // 07h à 20h inclus
    assert.equal(formatTime(ticks[0].instant, PARIS), '07:00')
    assert.equal(ticks[0].offsetPercent, 0)
    assert.equal(formatTime(ticks.at(-1)!.instant, PARIS), '20:00')
    assert.equal(ticks.at(-1)!.offsetPercent, 100)
  })

  it('affiche deux fois 02:00 le jour du retour à l’heure d’hiver', () => {
    const window = planningWindow('2026-10-25', PARIS, [], { openHour: 0, closeHour: 24 })
    const labels = hourTicks(window).map((tick) => formatTime(tick.instant, PARIS))
    assert.equal(labels.filter((label) => label === '02:00').length, 2)
  })
})

describe('planningHeightPx', () => {
  it('donne la place d’une heure par graduation', () => {
    assert.equal(planningHeightPx(planningWindow('2026-07-15', PARIS), 56), 13 * 56)
  })
})
