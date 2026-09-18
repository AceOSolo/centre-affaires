import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { wallClockToUtc } from '../../lib/dates.ts'
import {
  cellsInRange,
  dayCells,
  isSelectable,
  rangeBetween,
  rangeMinutes,
  SLOT_MINUTES,
} from './selection.ts'

const at = (iso: string) => new Date(iso)
const range = (start: string, end: string) => ({ startsAt: at(start), endsAt: at(end) })

/** Journée type : fenêtre 8h-12h, ouverture 9h-11h, rien de réservé. */
const WINDOW = range('2026-10-01T08:00:00Z', '2026-10-01T12:00:00Z')
const OPENING = [range('2026-10-01T09:00:00Z', '2026-10-01T11:00:00Z')]
const AVANT = at('2026-09-01T00:00:00Z')

describe('dayCells', () => {
  it('découpe la fenêtre au pas de la grille', () => {
    const cells = dayCells(WINDOW, OPENING, [], AVANT)
    assert.equal(cells.length, (4 * 60) / SLOT_MINUTES)
    assert.equal(cells[0].startsAt.toISOString(), '2026-10-01T08:00:00.000Z')
    assert.equal(cells[0].endsAt.toISOString(), '2026-10-01T08:30:00.000Z')
  })

  it('écarte la dernière cellule incomplète', () => {
    const cells = dayCells(range('2026-10-01T09:00:00Z', '2026-10-01T10:20:00Z'), [], [], AVANT)
    assert.equal(cells.length, 2)
    assert.equal(cells.at(-1)?.endsAt.toISOString(), '2026-10-01T10:00:00.000Z')
  })

  it('ferme ce qui est hors des heures d’ouverture', () => {
    const cells = dayCells(WINDOW, OPENING, [], AVANT)
    const etats = cells.map((cell) => cell.state)
    // 8h-9h fermé, 9h-11h libre, 11h-12h fermé.
    assert.deepEqual(etats.slice(0, 2), ['closed', 'closed'])
    assert.deepEqual(etats.slice(2, 6), ['free', 'free', 'free', 'free'])
    assert.deepEqual(etats.slice(6), ['closed', 'closed'])
  })

  it('ferme une cellule à cheval sur la bordure d’ouverture', () => {
    // Ouverture à 9h15 : la cellule 9h00-9h30 n'est pas entièrement ouverte.
    const cells = dayCells(WINDOW, [range('2026-10-01T09:15:00Z', '2026-10-01T11:00:00Z')], [], AVANT)
    assert.equal(cells[2].state, 'closed')
    assert.equal(cells[3].state, 'free')
  })

  it('marque occupé ce qui touche une réservation', () => {
    const cells = dayCells(WINDOW, OPENING, [range('2026-10-01T09:30:00Z', '2026-10-01T10:00:00Z')], AVANT)
    assert.deepEqual(
      cells.slice(2, 6).map((cell) => cell.state),
      ['free', 'busy', 'free', 'free'],
    )
  })

  it('laisse libre la cellule qui commence à la fin d’une réservation', () => {
    // Bornes `[)`, comme la contrainte d'exclusion : une réservation qui finit
    // à 10h00 ne prend pas la cellule de 10h00.
    const cells = dayCells(WINDOW, OPENING, [range('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z')], AVANT)
    assert.deepEqual(
      cells.slice(2, 5).map((cell) => cell.state),
      ['busy', 'busy', 'free'],
    )
  })

  it('marque passé ce qui est révolu, mais garde la réservation visible', () => {
    const maintenant = at('2026-10-01T10:00:00Z')
    const cells = dayCells(WINDOW, OPENING, [range('2026-10-01T09:00:00Z', '2026-10-01T09:30:00Z')], maintenant)
    // 9h00-9h30 est à la fois passé et réservé : « réservé » est l'information
    // utile, « passé » n'en est pas une.
    assert.equal(cells[2].state, 'busy')
    assert.equal(cells[3].state, 'past')
    assert.equal(cells[4].state, 'free')
  })

  it('compte les cellules réellement écoulées au changement d’heure', () => {
    // Le 29 mars 2026 à 2h, l'horloge saute à 3h. Une fenêtre murale de 1h à 5h
    // n'y dure que trois heures : six cellules, pas huit. Compter sur la durée
    // écoulée, et non sur l'amplitude murale, est la seule façon de ne pas
    // proposer un créneau qui n'existe pas (décision 4).
    const zone = 'Europe/Paris'
    const nuit = (isoDate: string) => ({
      startsAt: wallClockToUtc(`${isoDate}T01:00`, zone),
      endsAt: wallClockToUtc(`${isoDate}T05:00`, zone),
    })

    assert.equal(dayCells(nuit('2026-03-30'), [], [], AVANT).length, 8)
    assert.equal(dayCells(nuit('2026-03-29'), [], [], AVANT).length, 6)
    // Le 25 octobre, 3h redevient 2h : la même amplitude murale dure une heure
    // de plus.
    assert.equal(dayCells(nuit('2026-10-25'), [], [], AVANT).length, 10)
  })
})

describe('rangeBetween', () => {
  const cells = dayCells(WINDOW, OPENING, [], AVANT)

  it('couvre les deux cellules, quel que soit l’ordre des clics', () => {
    const attendu = { startsAt: '2026-10-01T09:00:00.000Z', endsAt: '2026-10-01T10:30:00.000Z' }
    const endroit = rangeBetween(cells[2], cells[4])
    const envers = rangeBetween(cells[4], cells[2])

    assert.equal(endroit.startsAt.toISOString(), attendu.startsAt)
    assert.equal(endroit.endsAt.toISOString(), attendu.endsAt)
    assert.deepEqual(envers, endroit)
  })

  it('rend la cellule elle-même quand on clique deux fois au même endroit', () => {
    assert.equal(rangeMinutes(rangeBetween(cells[2], cells[2])), SLOT_MINUTES)
  })
})

describe('isSelectable', () => {
  const cells = dayCells(WINDOW, OPENING, [range('2026-10-01T10:00:00Z', '2026-10-01T10:30:00Z')], AVANT)

  it('accepte un créneau entièrement libre', () => {
    assert.equal(isSelectable(range('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z'), cells), true)
  })

  it('refuse un créneau qui enjambe une réservation', () => {
    // Le piège du choix en deux clics : cliquer 9h puis 11h par-dessus une
    // réservation de 10h à 10h30.
    assert.equal(isSelectable(range('2026-10-01T09:00:00Z', '2026-10-01T11:00:00Z'), cells), false)
  })

  it('refuse un créneau qui déborde de l’ouverture', () => {
    assert.equal(isSelectable(range('2026-10-01T08:30:00Z', '2026-10-01T09:30:00Z'), cells), false)
  })

  it('refuse un créneau vide', () => {
    assert.equal(isSelectable(range('2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z'), cells), false)
  })
})

describe('cellsInRange', () => {
  const cells = dayCells(WINDOW, OPENING, [], AVANT)

  it('rend les index à surligner', () => {
    const indexes = cellsInRange(range('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z'), cells)
    assert.deepEqual([...indexes].sort((a, b) => a - b), [2, 3])
  })

  it('ne surligne rien sans sélection', () => {
    assert.equal(cellsInRange(undefined, cells).size, 0)
  })
})
