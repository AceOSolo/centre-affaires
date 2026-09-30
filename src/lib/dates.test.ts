import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  addDaysToIsoDate,
  addMonthsToIsoMonth,
  dayRangeUtc,
  formatDateTime,
  formatIsoMonth,
  isIsoMonth,
  monthRangeUtc,
  formatDuration,
  formatTime,
  toIsoDate,
  toWallClock,
  wallClockToUtc,
} from './dates.ts'

const PARIS = 'Europe/Paris'
// Un second fuseau, pour que les tests distinguent une vraie conversion d'un
// décalage parisien écrit en dur.
const MONTREAL = 'America/Montreal'

describe('heure murale vers UTC', () => {
  it('applique le décalage d’hiver', () => {
    // 9h00 à Paris en janvier = 8h00 UTC (CET, +1).
    assert.equal(wallClockToUtc('2026-01-15T09:00', PARIS).toISOString(), '2026-01-15T08:00:00.000Z')
  })

  it('applique le décalage d’été', () => {
    // Même heure murale en juillet = 7h00 UTC (CEST, +2). Un décalage figé
    // placerait la réunion une heure à côté la moitié de l'année.
    assert.equal(wallClockToUtc('2026-07-15T09:00', PARIS).toISOString(), '2026-07-15T07:00:00.000Z')
  })

  it('convertit dans un autre fuseau que celui du serveur', () => {
    // 9h00 à Montréal en janvier = 14h00 UTC (EST, -5).
    assert.equal(
      wallClockToUtc('2026-01-15T09:00', MONTREAL).toISOString(),
      '2026-01-15T14:00:00.000Z',
    )
  })

  it('décale une heure qui n’existe pas, la nuit du passage à l’heure d’été', () => {
    // Le 29 mars 2026 à 2h00, les horloges parisiennes sautent à 3h00 : 2h30
    // n'existe pas. Elle est reportée sur 3h30 CEST, soit 1h30 UTC.
    assert.equal(wallClockToUtc('2026-03-29T02:30', PARIS).toISOString(), '2026-03-29T01:30:00.000Z')
  })

  it('retient la seconde occurrence d’une heure vécue deux fois', () => {
    // Le 25 octobre 2026, 2h30 arrive deux fois. La seconde — CET, +1 — est
    // retenue : le verdict doit être déterminé, pas dépendre du serveur.
    assert.equal(wallClockToUtc('2026-10-25T02:30', PARIS).toISOString(), '2026-10-25T01:30:00.000Z')
  })

  it('refuse une saisie illisible plutôt que d’inventer une date', () => {
    assert.throws(() => wallClockToUtc('25/10/2026 09:00', PARIS), /illisible/)
  })

  it('fait l’aller-retour sans dérive', () => {
    const instant = wallClockToUtc('2026-07-15T14:45', PARIS)
    assert.equal(toWallClock(instant, PARIS), '2026-07-15T14:45')
  })
})

describe('journée du centre', () => {
  it('borne la journée sur le fuseau du centre, pas sur celui du serveur', () => {
    const { startsAt, endsAt } = dayRangeUtc('2026-07-15', PARIS)
    assert.equal(startsAt.toISOString(), '2026-07-14T22:00:00.000Z')
    assert.equal(endsAt.toISOString(), '2026-07-15T22:00:00.000Z')
  })

  it('dure 23 heures au passage à l’heure d’été', () => {
    const { startsAt, endsAt } = dayRangeUtc('2026-03-29', PARIS)
    assert.equal((endsAt.getTime() - startsAt.getTime()) / 3_600_000, 23)
  })

  it('dure 25 heures au retour à l’heure d’hiver', () => {
    // Une borne haute calculée en ajoutant 24 heures ferait disparaître une
    // heure de planning ce jour-là.
    const { startsAt, endsAt } = dayRangeUtc('2026-10-25', PARIS)
    assert.equal((endsAt.getTime() - startsAt.getTime()) / 3_600_000, 25)
  })

  it('change de jour à minuit dans le centre', () => {
    // 23h30 UTC le 14 juillet, c'est déjà le 15 à Paris.
    assert.equal(toIsoDate(new Date('2026-07-14T23:30:00Z'), PARIS), '2026-07-15')
    assert.equal(toIsoDate(new Date('2026-07-14T23:30:00Z'), MONTREAL), '2026-07-14')
  })

  it('franchit les fins de mois et les années bissextiles', () => {
    assert.equal(addDaysToIsoDate('2026-01-31', 1), '2026-02-01')
    assert.equal(addDaysToIsoDate('2026-03-01', -1), '2026-02-28')
    assert.equal(addDaysToIsoDate('2028-03-01', -1), '2028-02-29')
  })
})

describe('affichage', () => {
  it('affiche l’heure du centre, pas celle du serveur', () => {
    const instant = new Date('2026-07-15T07:00:00Z')
    assert.equal(formatTime(instant, PARIS), '09:00')
    assert.equal(formatTime(instant, MONTREAL), '03:00')
  })

  it('met en forme les durées', () => {
    const duration = (start: string, end: string) =>
      formatDuration(new Date(start), new Date(end))
    assert.equal(duration('2026-07-15T09:00:00Z', '2026-07-15T09:45:00Z'), '45 min')
    assert.equal(duration('2026-07-15T09:00:00Z', '2026-07-15T11:00:00Z'), '2 h')
    assert.equal(duration('2026-07-15T09:00:00Z', '2026-07-15T10:30:00Z'), '1 h 30')
  })
})

describe('mois du centre', () => {
  it('commence à minuit dans le centre, pas à minuit UTC', () => {
    // 1er octobre 0h00 à Paris = 30 septembre 22h00 UTC (CEST, +2).
    const { startsAt, endsAt } = monthRangeUtc('2026-10', PARIS)
    assert.equal(startsAt.toISOString(), '2026-09-30T22:00:00.000Z')
    // Le mois se termine après le retour à l'heure d'hiver : +1 le 1er novembre.
    assert.equal(endsAt.toISOString(), '2026-10-31T23:00:00.000Z')
  })

  it('suit le fuseau du centre', () => {
    const { startsAt } = monthRangeUtc('2026-10', MONTREAL)
    assert.equal(startsAt.toISOString(), '2026-10-01T04:00:00.000Z')
  })

  it('franchit la fin d’année', () => {
    assert.equal(addMonthsToIsoMonth('2026-12', 1), '2027-01')
    assert.equal(addMonthsToIsoMonth('2026-01', -1), '2025-12')
    assert.equal(monthRangeUtc('2026-12', PARIS).endsAt.toISOString(), '2026-12-31T23:00:00.000Z')
  })

  it('refuse un mois illisible plutôt que d’inventer une période', () => {
    assert.equal(isIsoMonth('2026-13'), false)
    assert.equal(isIsoMonth('2026-9'), false)
    assert.equal(isIsoMonth(undefined), false)
    assert.throws(() => monthRangeUtc('septembre', PARIS))
  })

  it('date et heure du centre, jointes par « à »', () => {
    // 30 septembre 22h30 UTC = 1er octobre 0h30 à Paris.
    assert.equal(formatDateTime(new Date('2026-09-30T22:30:00Z'), PARIS), '1 oct. 2026 à 00:30')
  })

  it('nomme le mois en français', () => {
    assert.equal(formatIsoMonth('2026-09'), 'septembre 2026')
  })
})
