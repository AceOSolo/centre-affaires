import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatTime, wallClockToUtc } from '../../lib/dates.ts'
import type { ClosurePeriod, OpeningRule } from '../ressources/ouverture.ts'
import type { TimeRange } from './availability.ts'
import {
  adminSelection,
  dayFreeRanges,
  lastDayOf,
  periodAvailability,
  periodDayCount,
  periodDuration,
  periodEndDates,
  periodEnds,
  periodLabel,
  periodRejection,
  spansSeveralDays,
} from './periode.ts'

/**
 * Demandes sur plusieurs jours (ADR 061) : une période continue, tenue jour et
 * nuit, qui commence et finit dans les heures d'ouverture, sans enjamber une
 * réservation ni une fermeture exceptionnelle. Bornes `[)` comme le trigger.
 */
const PARIS = 'Europe/Paris'
const at = (wallClock: string) => wallClockToUtc(wallClock, PARIS)
const period = (start: string, end: string): TimeRange => ({ startsAt: at(start), endsAt: at(end) })

const SALLE = 'salle'
const CAMION = 'camion'

/** Salle : du lundi au vendredi, coupée à midi. Camion : du lundi au samedi, 8 h – 19 h. */
const rules: OpeningRule[] = [
  ...[1, 2, 3, 4, 5].flatMap((weekday) => [
    { resourceId: SALLE, weekday, opensAt: '09:00', closesAt: '12:30' },
    { resourceId: SALLE, weekday, opensAt: '14:00', closesAt: '18:00' },
  ]),
  ...[1, 2, 3, 4, 5, 6].map((weekday) => ({ resourceId: CAMION, weekday, opensAt: '08:00', closesAt: '19:00' })),
]

function availability(
  resourceId: string,
  firstDate: string,
  dayCount: number,
  busy: TimeRange[] = [],
  closures: ClosurePeriod[] = [],
) {
  return periodAvailability({ firstDate, dayCount, timeZone: PARIS, resourceId, rules, closures, busy })
}

// Du lundi 2 au dimanche 8 novembre 2026 : heure d'hiver, UTC+1.
describe('jours d’une période', () => {
  it('compte les jours du centre touchés, fin exclue', () => {
    assert.equal(periodDayCount(period('2026-11-02T09:00', '2026-11-02T18:00'), PARIS), 1)
    assert.equal(periodDayCount(period('2026-11-02T09:00', '2026-11-04T18:00'), PARIS), 3)
    // Le camion pris lundi 9 h et rendu mardi 9 h touche deux jours.
    assert.equal(periodDayCount(period('2026-11-02T09:00', '2026-11-03T09:00'), PARIS), 2)
    // Une fin à minuit pile reste sur la veille.
    assert.equal(periodDayCount(period('2026-11-02T18:00', '2026-11-03T00:00'), PARIS), 1)
    assert.equal(lastDayOf(period('2026-11-02T18:00', '2026-11-03T00:00'), PARIS), '2026-11-02')
    assert.equal(spansSeveralDays(period('2026-11-02T18:00', '2026-11-03T00:00'), PARIS), false)
    assert.equal(spansSeveralDays(period('2026-11-02T18:00', '2026-11-03T00:15'), PARIS), true)
  })
})

describe('disponibilité sur plusieurs jours', () => {
  it('rend des plages libres continues, nuits comprises, et les plages du jour à l’intérieur de l’ouverture', () => {
    const tuesday = period('2026-11-03T10:00', '2026-11-03T11:00')
    const week = availability(SALLE, '2026-11-02', 3, [tuesday])
    assert.deepEqual(week.free, [
      period('2026-11-02T00:00', '2026-11-03T10:00'),
      period('2026-11-03T11:00', '2026-11-05T00:00'),
    ])
    // Le jour même : la pause de midi et la réservation restent des trous.
    assert.deepEqual(dayFreeRanges(week, '2026-11-03'), [
      period('2026-11-03T09:00', '2026-11-03T10:00'),
      period('2026-11-03T11:00', '2026-11-03T12:30'),
      period('2026-11-03T14:00', '2026-11-03T18:00'),
    ])
  })

  it('le jour même, la règle ne change pas : une seule plage libre, sans enjamber la pause', () => {
    const day = availability(SALLE, '2026-11-02', 1)
    assert.equal(periodRejection(period('2026-11-02T09:00', '2026-11-02T12:30'), day, PARIS, 5), undefined)
    assert.equal(periodRejection(period('2026-11-02T11:00', '2026-11-02T15:00'), day, PARIS, 5), 'creneau-indisponible')
    assert.equal(periodRejection(period('2026-11-02T09:00', '2026-11-02T09:15'), day, PARIS, 5), 'duree-trop-courte')
  })

  it('sur plusieurs jours, la période enjambe les nuits et les pauses : une seule réservation', () => {
    const week = availability(SALLE, '2026-11-02', 5)
    assert.equal(periodRejection(period('2026-11-02T09:00', '2026-11-04T18:00'), week, PARIS, 5), undefined)
    // Du vendredi au lundi : le week-end fermé est compris, il est au client.
    const weekend = availability(SALLE, '2026-11-06', 4)
    assert.equal(periodRejection(period('2026-11-06T14:00', '2026-11-09T12:30'), weekend, PARIS, 5), undefined)
  })

  it('début et fin tombent dans les heures d’ouverture ; une fin à l’ouverture compte', () => {
    const week = availability(CAMION, '2026-11-02', 7)
    assert.equal(periodRejection(period('2026-11-02T07:00', '2026-11-03T18:00'), week, PARIS, 7), 'debut-hors-ouverture')
    assert.equal(periodRejection(period('2026-11-02T09:00', '2026-11-03T20:00'), week, PARIS, 7), 'fin-hors-ouverture')
    // Rendu le dimanche : le camion ne sort ni ne rentre ce jour-là.
    assert.equal(periodRejection(period('2026-11-07T09:00', '2026-11-08T10:00'), week, PARIS, 7), 'fin-hors-ouverture')
    // Pris lundi 9 h, rendu mardi 9 h ; rendu mardi à l'ouverture, 8 h.
    assert.equal(periodRejection(period('2026-11-02T09:00', '2026-11-03T09:00'), week, PARIS, 7), undefined)
    assert.equal(periodRejection(period('2026-11-02T09:00', '2026-11-03T08:00'), week, PARIS, 7), undefined)
  })

  it('refuse une réservation au milieu, accepte les voisines jointives (bornes [))', () => {
    const before = period('2026-11-02T08:00', '2026-11-02T09:00')
    const after = period('2026-11-04T18:00', '2026-11-04T19:00')
    const middle = period('2026-11-03T22:00', '2026-11-03T23:00')
    const free = availability(CAMION, '2026-11-02', 3, [before, after])
    assert.equal(periodRejection(period('2026-11-02T09:00', '2026-11-04T18:00'), free, PARIS, 7), undefined)
    // Une réservation posée la nuit par l'équipe, hors ouverture, bloque aussi.
    const taken = availability(CAMION, '2026-11-02', 3, [before, middle, after])
    assert.equal(periodRejection(period('2026-11-02T09:00', '2026-11-04T18:00'), taken, PARIS, 7), 'creneau-indisponible')
    assert.equal(periodRejection(period('2026-11-02T08:30', '2026-11-04T18:00'), free, PARIS, 7), 'creneau-indisponible')
    assert.equal(periodRejection(period('2026-11-02T09:00', '2026-11-04T18:15'), free, PARIS, 7), 'creneau-indisponible')
  })

  it('une fermeture exceptionnelle comprise dans la période la rend indisponible en ligne', () => {
    const closures = [{ resourceId: null, startsOn: '2026-11-03', endsOn: '2026-11-03' }]
    const week = availability(CAMION, '2026-11-02', 3, [], closures)
    assert.equal(periodRejection(period('2026-11-02T09:00', '2026-11-04T18:00'), week, PARIS, 7), 'creneau-indisponible')
    // La fermeture d'une autre ressource ne compte pas.
    const other = availability(CAMION, '2026-11-02', 3, [], [{ resourceId: SALLE, startsOn: '2026-11-03', endsOn: '2026-11-03' }])
    assert.equal(periodRejection(period('2026-11-02T09:00', '2026-11-04T18:00'), other, PARIS, 7), undefined)
  })

  it('plafonne la période au nombre de jours du produit', () => {
    const week = availability(CAMION, '2026-11-02', 7)
    assert.equal(periodRejection(period('2026-11-02T09:00', '2026-11-04T18:00'), week, PARIS, 3), undefined)
    assert.equal(periodRejection(period('2026-11-02T09:00', '2026-11-05T09:00'), week, PARIS, 3), 'duree-trop-longue')
    // Un produit réglé sur un jour reste au jour même, comme avant.
    assert.equal(periodRejection(period('2026-11-02T18:00', '2026-11-03T09:00'), week, PARIS, 1), 'duree-trop-longue')
  })
})

describe('changement d’heure', () => {
  it('automne : du samedi 24 au lundi 26 octobre 2026, deux jours d’heure murale pour 49 heures réelles', () => {
    const range = period('2026-10-24T10:00', '2026-10-26T10:00')
    assert.equal(range.endsAt.getTime() - range.startsAt.getTime(), 49 * 3_600_000)
    assert.equal(periodDayCount(range, PARIS), 3)
    assert.equal(periodDuration(range, PARIS), '2 jours')
    const days = availability(CAMION, '2026-10-24', 3)
    assert.equal(periodRejection(range, days, PARIS, 7), undefined)
    // La fin se propose à l'heure murale du lundi, pas une heure plus tôt.
    const ends = periodEnds(range.startsAt, '2026-10-26', days, PARIS, 7).map((end) => formatTime(end, PARIS))
    assert.equal(ends[0], '08:00')
    assert.ok(ends.includes('10:00'))
    assert.equal(ends.at(-1), '19:00')
  })

  it('printemps : du samedi 27 au lundi 29 mars 2027, deux jours pour 47 heures réelles', () => {
    const range = period('2027-03-27T10:00', '2027-03-29T10:00')
    assert.equal(range.endsAt.getTime() - range.startsAt.getTime(), 47 * 3_600_000)
    assert.equal(periodDuration(range, PARIS), '2 jours')
    const days = availability(CAMION, '2027-03-27', 3)
    assert.equal(periodRejection(range, days, PARIS, 7), undefined)
    // Une réservation de la nuit de dimanche, hors ouverture, traverse l'heure sautée.
    const night = period('2027-03-28T01:00', '2027-03-28T04:00')
    assert.equal(night.endsAt.getTime() - night.startsAt.getTime(), 2 * 3_600_000)
    assert.equal(periodRejection(range, availability(CAMION, '2027-03-27', 3, [night]), PARIS, 7), 'creneau-indisponible')
  })
})

describe('fins proposées', () => {
  it('le jour même : jusqu’à la fin de la plage libre ; un autre jour : les quarts d’heure de son ouverture', () => {
    const week = availability(SALLE, '2026-11-02', 5)
    const start = at('2026-11-02T10:00')
    const sameDay = periodEnds(start, '2026-11-02', week, PARIS, 5).map((end) => formatTime(end, PARIS))
    assert.equal(sameDay[0], '10:30')
    assert.equal(sameDay.at(-1), '12:30')
    const nextDay = periodEnds(start, '2026-11-03', week, PARIS, 5).map((end) => formatTime(end, PARIS))
    assert.equal(nextDay[0], '09:00')
    assert.ok(nextDay.includes('12:30'))
    assert.ok(!nextDay.includes('13:00'), 'pas de fin pendant la pause de midi')
    assert.equal(nextDay.at(-1), '18:00')
  })

  it('s’arrêtent à la réservation suivante et au nombre de jours du produit', () => {
    const wednesday = period('2026-11-04T14:00', '2026-11-04T16:00')
    const week = availability(CAMION, '2026-11-02', 7, [wednesday])
    const start = at('2026-11-02T10:00')
    assert.deepEqual(periodEndDates(start, week, PARIS, 7), ['2026-11-02', '2026-11-03', '2026-11-04'])
    const wednesdayEnds = periodEnds(start, '2026-11-04', week, PARIS, 7).map((end) => formatTime(end, PARIS))
    assert.equal(wednesdayEnds.at(-1), '14:00')
    assert.deepEqual(periodEndDates(start, week, PARIS, 2), ['2026-11-02', '2026-11-03'])
    assert.deepEqual(periodEndDates(start, week, PARIS, 1), ['2026-11-02'])
  })

  it('ne propose aucun jour de fin fermé, ni de fin à partir d’un départ hors ouverture', () => {
    const week = availability(CAMION, '2026-11-06', 4)
    const dates = periodEndDates(at('2026-11-06T10:00'), week, PARIS, 4)
    assert.deepEqual(dates, ['2026-11-06', '2026-11-07', '2026-11-09'])
    assert.deepEqual(periodEnds(at('2026-11-06T20:00'), '2026-11-07', week, PARIS, 4), [])
  })
})

describe('saisie du back-office', () => {
  it('lit deux jours et deux heures, sans contrôle d’ouverture, et refuse une fin qui ne suit pas le début', () => {
    assert.deepEqual(adminSelection('2026-11-07', '22:00', '2026-11-09', '06:00', PARIS), period('2026-11-07T22:00', '2026-11-09T06:00'))
    assert.equal(adminSelection('2026-11-07', '10:00', '2026-11-07', '09:00', PARIS), undefined)
    assert.equal(adminSelection('2026-11-07', '10:00', '', '11:00', PARIS), undefined)
  })
})

describe('libellés', () => {
  it('dit la période en toutes lettres et sa durée', () => {
    assert.equal(periodLabel(period('2026-11-03T09:00', '2026-11-03T13:00'), PARIS), 'le mardi 3 novembre 2026, de 09:00 à 13:00')
    assert.equal(
      periodLabel(period('2026-11-03T09:00', '2026-11-05T18:00'), PARIS),
      'du mardi 3 novembre 2026 à 09:00 au jeudi 5 novembre 2026 à 18:00',
    )
    assert.equal(periodDuration(period('2026-11-03T09:00', '2026-11-03T10:30'), PARIS), '1 h 30')
    assert.equal(periodDuration(period('2026-11-03T09:00', '2026-11-04T09:00'), PARIS), '1 jour')
    assert.equal(periodDuration(period('2026-11-03T09:00', '2026-11-05T18:00'), PARIS), '2 jours 9 h')
  })
})
