import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { wallClockToUtc } from '../../lib/dates.ts'
import type { ClosurePeriod, OpeningRule } from '../ressources/ouverture.ts'
import type { TimeRange } from './availability.ts'
import {
  addMonthsToIsoDate,
  choiceSpanDays,
  choiceUnit,
  DEFAULT_FORMULA_LIMITS,
  emptyChoice,
  endDayIssue,
  evaluateChoice,
  lastDayOfLongFormula,
  openingGroups,
  parseChosenFormula,
  readChoice,
  type ChoiceContext,
  type PeriodChoice,
} from './formules-periode.ts'
import { periodAvailability } from './periode.ts'

/**
 * Formules de location et jour de départ libre (ADR 076) : la période que
 * chaque formule choisit, et ce qui la refuse. Bureau ouvert du lundi au
 * vendredi, 8 h – 19 h ; fermé le week-end.
 */
const PARIS = 'Europe/Paris'
const at = (wallClock: string) => wallClockToUtc(wallClock, PARIS)
const BUREAU = 'bureau'
const rules: OpeningRule[] = [1, 2, 3, 4, 5].map((weekday) => ({ resourceId: BUREAU, weekday, opensAt: '08:00', closesAt: '19:00' }))

function context(
  firstDate: string,
  dayCount: number,
  { busy = [] as TimeRange[], closures = [] as ClosurePeriod[], maxDays = 5, earliest = at('2026-11-01T00:00') } = {},
): ChoiceContext {
  return {
    date: firstDate,
    timeZone: PARIS,
    availability: periodAvailability({ firstDate, dayCount, timeZone: PARIS, resourceId: BUREAU, rules, closures, busy }),
    earliest,
    maxDays,
    limits: DEFAULT_FORMULA_LIMITS,
  }
}

const choice = (formula: PeriodChoice['formula'], changes: Partial<PeriodChoice> = {}): PeriodChoice => ({
  ...emptyChoice(formula, '2026-11-16'),
  ...changes,
})
const iso = (range: TimeRange | undefined) => range && [range.startsAt.toISOString(), range.endsAt.toISOString()]

// Lundi 16 novembre 2026, heure d'hiver (UTC+1).
describe('formule à la journée : le jour du départ est libre', () => {
  const ctx = context('2026-11-16', 5)
  const offered = ['journee', 'semaine'] as const

  it('va de l’ouverture du jour d’arrivée à la fermeture du jour de départ choisi', () => {
    const result = evaluateChoice(choice('journee', { endDate: '2026-11-18' }), ctx, offered)
    assert.equal(result.rejection, undefined)
    assert.deepEqual(iso(result.range), [at('2026-11-16T08:00').toISOString(), at('2026-11-18T19:00').toISOString()])
  })

  it('tient une seule journée, sans couper la journée en deux plages', () => {
    const result = evaluateChoice(choice('journee', { endDate: '2026-11-16' }), ctx, offered)
    assert.deepEqual(iso(result.range), [at('2026-11-16T08:00').toISOString(), at('2026-11-16T19:00').toISOString()])
  })

  it('dit quand le centre est fermé le jour du départ', () => {
    assert.equal(evaluateChoice(choice('journee', { endDate: '2026-11-21' }), context('2026-11-16', 7, { maxDays: 7 }), offered).rejection, 'depart-ferme')
  })

  it('refuse au-delà de la durée maximale du produit', () => {
    const result = evaluateChoice(choice('journee', { endDate: '2026-11-20' }), context('2026-11-16', 5, { maxDays: 3 }), offered)
    assert.equal(result.rejection, 'duree-trop-longue')
  })

  it('refuse une période qui enjambe une réservation', () => {
    const busy = [{ startsAt: at('2026-11-17T10:00'), endsAt: at('2026-11-17T12:00') }]
    assert.equal(evaluateChoice(choice('journee', { endDate: '2026-11-18' }), context('2026-11-16', 5, { busy }), offered).rejection, 'creneau-indisponible')
  })

  it('commence au premier quart d’heure permis quand la journée a commencé', () => {
    const result = evaluateChoice(choice('journee', { endDate: '2026-11-16' }), context('2026-11-16', 1, { earliest: at('2026-11-16T10:07') }), offered)
    assert.equal(result.range?.startsAt.toISOString(), at('2026-11-16T10:15').toISOString())
  })

  it('n’offre que les formules réglées sur la ressource', () => {
    assert.equal(evaluateChoice(choice('heure', { startTime: '09:00', endTime: '10:00' }), ctx, offered).rejection, 'formule-indisponible')
    assert.equal(evaluateChoice(choice('libre'), ctx, offered).rejection, 'formule-indisponible')
    assert.equal(parseChosenFormula('mois', offered), undefined)
    assert.equal(parseChosenFormula('', []), 'libre')
  })
})

describe('formules longues : à la semaine, au mois', () => {
  const offered = ['semaine', 'mois'] as const

  it('loue une semaine du lundi au dernier jour ouvert : le vendredi soir', () => {
    const result = evaluateChoice(choice('semaine', { count: 1 }), context('2026-11-16', 28), offered)
    assert.equal(result.rejection, undefined)
    assert.deepEqual(iso(result.range), [at('2026-11-16T08:00').toISOString(), at('2026-11-20T19:00').toISOString()])
    assert.equal(lastDayOfLongFormula('semaine', '2026-11-16', 2), '2026-11-29')
  })

  it('loue au mois, du jour d’arrivée à la veille du même quantième', () => {
    const ctx = context('2026-11-16', choiceSpanDays(['mois'], '2026-11-16', 5, DEFAULT_FORMULA_LIMITS))
    const result = evaluateChoice(choice('mois', { count: 2 }), ctx, offered)
    assert.equal(result.rejection, undefined)
    // Du lundi 16 novembre au vendredi 15 janvier 2027, fermeture.
    assert.equal(result.range?.endsAt.toISOString(), at('2027-01-15T19:00').toISOString())
  })

  it('ne s’interrompt pas pour une fermeture exceptionnelle, mais bien pour une réservation', () => {
    const closures = [{ resourceId: BUREAU, startsOn: '2026-11-18', endsOn: '2026-11-18' }]
    assert.equal(evaluateChoice(choice('semaine', { count: 1 }), context('2026-11-16', 28, { closures }), offered).rejection, undefined)
    const busy = [{ startsAt: at('2026-11-19T09:00'), endsAt: at('2026-11-19T10:00') }]
    assert.equal(evaluateChoice(choice('semaine', { count: 1 }), context('2026-11-16', 28, { busy }), offered).rejection, 'creneau-indisponible')
  })

  it('borne le nombre de semaines et de mois aux plafonds du centre', () => {
    assert.equal(evaluateChoice(choice('semaine', { count: 5 }), context('2026-11-16', 35), offered).rejection, 'duree-hors-formule')
    assert.equal(evaluateChoice(choice('semaine', { count: 0 }), context('2026-11-16', 35), offered).rejection, 'duree-hors-formule')
  })

  it('refuse une arrivée un jour fermé', () => {
    const ctx = { ...context('2026-11-21', 28), date: '2026-11-21' }
    assert.equal(evaluateChoice({ ...choice('semaine'), endDate: '2026-11-21' }, ctx, offered).rejection, 'jour-ferme')
  })

  it('compte les mois du calendrier, quantième ramené au dernier jour du mois', () => {
    assert.equal(addMonthsToIsoDate('2026-11-16', 1), '2026-12-16')
    assert.equal(addMonthsToIsoDate('2026-01-31', 1), '2026-02-28')
    assert.equal(addMonthsToIsoDate('2026-11-30', 3), '2027-02-28')
    assert.equal(lastDayOfLongFormula('mois', '2026-01-31', 1), '2026-02-27')
  })

  it('charge assez de jours pour la plus longue des formules', () => {
    assert.equal(choiceSpanDays([], '2026-11-16', 5, DEFAULT_FORMULA_LIMITS), 5)
    assert.equal(choiceSpanDays(['heure'], '2026-11-16', 5, DEFAULT_FORMULA_LIMITS), 1)
    assert.equal(choiceSpanDays(['journee', 'semaine'], '2026-11-16', 5, DEFAULT_FORMULA_LIMITS), 28)
    // Douze mois à partir du 16 novembre 2026 : jusqu'au 15 novembre 2027.
    assert.equal(choiceSpanDays(['mois'], '2026-11-16', 5, DEFAULT_FORMULA_LIMITS), 365)
  })
})

describe('formules courtes et formulaire libre', () => {
  it('à la demi-journée, part une demi-journée après l’arrivée', () => {
    const result = evaluateChoice(choice('demi_journee', { startTime: '09:00' }), context('2026-11-16', 1), ['demi_journee'])
    assert.deepEqual(iso(result.range), [at('2026-11-16T09:00').toISOString(), at('2026-11-16T13:00').toISOString()])
    assert.equal(evaluateChoice(choice('demi_journee', { startTime: '16:00' }), context('2026-11-16', 1), ['demi_journee']).rejection, 'creneau-indisponible')
  })

  it('à l’heure, reste dans la journée', () => {
    const result = evaluateChoice(choice('heure', { startTime: '09:00', endTime: '11:30' }), context('2026-11-16', 1), ['heure'])
    assert.equal(result.rejection, undefined)
    assert.equal(evaluateChoice(choice('heure', { startTime: '', endTime: '' }), context('2026-11-16', 1), ['heure']).rejection, 'creneau-illisible')
  })

  it('libre : le départ se choisit n’importe quel jour de la durée maximale', () => {
    const result = evaluateChoice(choice('libre', { startTime: '09:00', endDate: '2026-11-19', endTime: '17:00' }), context('2026-11-16', 5), [])
    assert.equal(result.rejection, undefined)
    assert.equal(choiceUnit('libre'), undefined)
    assert.equal(choiceUnit('mois'), 'month')
  })

  it('dit pourquoi un jour de départ ne propose aucune heure', () => {
    const ctx = context('2026-11-16', 7, { maxDays: 7 })
    const start = at('2026-11-16T09:00')
    assert.equal(endDayIssue(start, '2026-11-21', ctx.availability, PARIS, 7).kind, 'ferme')
    assert.equal(endDayIssue(start, '2026-11-15', ctx.availability, PARIS, 7).kind, 'avant-arrivee')
    assert.equal(endDayIssue(start, '2026-11-25', ctx.availability, PARIS, 7).kind, 'trop-loin')
    const busy = [{ startsAt: at('2026-11-17T14:00'), endsAt: at('2026-11-17T16:00') }]
    const issue = endDayIssue(start, '2026-11-18', context('2026-11-16', 7, { busy, maxDays: 7 }).availability, PARIS, 7)
    assert.equal(issue.kind, 'occupe')
    assert.equal(issue.kind === 'occupe' ? issue.freeUntil?.toISOString() : undefined, at('2026-11-17T14:00').toISOString())
  })

  it('lit le choix envoyé par le formulaire', () => {
    const form = new Map(Object.entries({ startTime: '09:00', endDate: '', endTime: '10:00', count: '3' }))
    assert.deepEqual(readChoice(form, 'semaine', '2026-11-16'), {
      formula: 'semaine',
      startTime: '09:00',
      endDate: '2026-11-16',
      endTime: '10:00',
      count: 3,
    })
  })
})

describe('heures d’ouverture des jours choisis', () => {
  it('regroupe les jours consécutifs aux mêmes horaires, et dit le week-end fermé', () => {
    const { availability } = context('2026-11-16', 7)
    const groups = openingGroups(availability, '2026-11-16', '2026-11-22', (range) => `${range.startsAt.getUTCHours()}`)
    assert.deepEqual(
      groups.map((group) => [group.from, group.to, group.hours.length]),
      [
        ['2026-11-16', '2026-11-20', 1],
        ['2026-11-21', '2026-11-22', 0],
      ],
    )
  })
})
