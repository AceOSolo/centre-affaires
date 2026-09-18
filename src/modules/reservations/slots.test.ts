import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { wallClockToUtc } from '../../lib/dates.ts'
import { freeMinutes, freeRanges, slotsWithin } from './slots.ts'

const PARIS = 'Europe/Paris'
const JOUR = '2026-10-01'

const at = (time: string) => wallClockToUtc(`${JOUR}T${time}`, PARIS)
const range = (start: string, end: string) => ({ startsAt: at(start), endsAt: at(end) })

/** « 09:00–12:00 » pour lire les assertions sans décoder des Date. */
const show = (ranges: readonly { startsAt: Date; endsAt: Date }[]) =>
  ranges.map(
    (r) =>
      `${new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, hour: '2-digit', minute: '2-digit' }).format(r.startsAt)}–${new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, hour: '2-digit', minute: '2-digit' }).format(r.endsAt)}`,
  )

const OUVERTURE = range('08:00', '19:00')

describe('créneaux libres', () => {
  it('rend la fenêtre entière quand rien n’est réservé', () => {
    assert.deepEqual(show(freeRanges(OUVERTURE, [])), ['08:00–19:00'])
  })

  it('creuse un trou autour d’une réservation', () => {
    assert.deepEqual(show(freeRanges(OUVERTURE, [range('10:00', '11:30')])), [
      '08:00–10:00',
      '11:30–19:00',
    ])
  })

  it('ne propose rien entre deux réservations jointives', () => {
    // 10h-11h puis 11h-12h ne se chevauchent pas au sens de la contrainte, mais
    // ne laissent aucune place : proposer « 11:00–11:00 » serait absurde.
    assert.deepEqual(
      show(freeRanges(OUVERTURE, [range('10:00', '11:00'), range('11:00', '12:00')])),
      ['08:00–10:00', '12:00–19:00'],
    )
  })

  it('fusionne des réservations qui se chevauchent', () => {
    assert.deepEqual(
      show(freeRanges(OUVERTURE, [range('10:00', '12:00'), range('11:00', '13:00')])),
      ['08:00–10:00', '13:00–19:00'],
    )
  })

  it('absorbe une réservation contenue dans une autre', () => {
    assert.deepEqual(
      show(freeRanges(OUVERTURE, [range('09:00', '17:00'), range('10:00', '11:00')])),
      ['08:00–09:00', '17:00–19:00'],
    )
  })

  it('rogne ce qui déborde de l’ouverture', () => {
    // Une réservation de 6h à 9h ne doit pas faire commencer la journée à 6h.
    assert.deepEqual(show(freeRanges(OUVERTURE, [range('06:00', '09:00')])), ['09:00–19:00'])
  })

  it('ignore une réservation entièrement hors de l’ouverture', () => {
    assert.deepEqual(show(freeRanges(OUVERTURE, [range('20:00', '22:00')])), ['08:00–19:00'])
  })

  it('ne rend rien quand la journée est prise de bout en bout', () => {
    assert.deepEqual(freeRanges(OUVERTURE, [range('08:00', '19:00')]), [])
  })

  it('ne rend rien sur une fenêtre vide', () => {
    assert.deepEqual(freeRanges(range('09:00', '09:00'), []), [])
  })

  it('accepte des réservations dans le désordre', () => {
    assert.deepEqual(
      show(freeRanges(OUVERTURE, [range('15:00', '16:00'), range('09:00', '10:00')])),
      ['08:00–09:00', '10:00–15:00', '16:00–19:00'],
    )
  })
})

describe('découpe en créneaux', () => {
  it('aligne les créneaux sur le début du trou, pas sur l’heure ronde', () => {
    assert.deepEqual(show(slotsWithin(range('09:30', '11:00'), 30)), [
      '09:30–10:00',
      '10:00–10:30',
      '10:30–11:00',
    ])
  })

  it('écarte le reste qui ne fait pas un créneau entier', () => {
    // 09:00–10:15 ne contient qu'une heure pleine : la place restante ne se
    // propose pas.
    assert.deepEqual(show(slotsWithin(range('09:00', '10:15'), 60)), ['09:00–10:00'])
  })

  it('ne propose rien quand le trou est plus court que le créneau', () => {
    assert.deepEqual(slotsWithin(range('09:00', '09:45'), 60), [])
  })

  it('refuse une durée nulle plutôt que de boucler sans fin', () => {
    assert.deepEqual(slotsWithin(range('09:00', '10:00'), 0), [])
  })
})

describe('durée libre cumulée', () => {
  it('additionne les trous', () => {
    assert.equal(freeMinutes(freeRanges(OUVERTURE, [range('10:00', '11:30')])), 570)
  })

  it('reste juste le jour du changement d’heure', () => {
    // Le 25 octobre, 02h00–03h00 en heure murale dure deux heures réelles.
    // La fenêtre est en instants, donc le calcul suit le temps vécu.
    const nuit = {
      startsAt: wallClockToUtc('2026-10-25T01:00', PARIS),
      endsAt: wallClockToUtc('2026-10-25T04:00', PARIS),
    }
    assert.equal(freeMinutes(freeRanges(nuit, [])), 240)
  })
})
