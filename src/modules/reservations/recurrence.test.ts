import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { toWallClock } from '../../lib/dates.ts'
import { expandRecurrence, type RecurrenceInput } from './recurrence.ts'

const zone = 'Europe/Paris'
const input = (overrides: Partial<RecurrenceInput> = {}): RecurrenceInput => ({
  startsOn: '2026-10-19', endsOn: '2026-11-02',
  slots: [{ weekdays: [1], startTime: '09:00', endTime: '10:00' }], ...overrides,
})

describe('réservations récurrentes', () => {
  it('inclut les deux bornes et conserve les heures locales au passage à l’heure d’hiver', () => {
    const ranges = expandRecurrence(input(), zone)
    assert.deepEqual(ranges.map((range) => range.startsAt.toISOString()), [
      '2026-10-19T07:00:00.000Z', '2026-10-26T08:00:00.000Z', '2026-11-02T08:00:00.000Z',
    ])
    assert.ok(ranges.every((range) => toWallClock(range.startsAt, zone).endsWith('09:00')))
  })
  it('accepte plusieurs jours et des plages jointives sans dupliquer les jours', () => {
    const ranges = expandRecurrence(input({ startsOn: '2026-10-19', endsOn: '2026-10-20', slots: [
      { weekdays: [1, 1, 2], startTime: '09:00', endTime: '10:00' },
      { weekdays: [1], startTime: '10:00', endTime: '11:00' },
    ] }), zone)
    assert.equal(ranges.length, 3)
  })
  it('refuse tout le lot en cas de chevauchement interne', () => {
    assert.throws(() => expandRecurrence(input({ slots: [
      { weekdays: [1], startTime: '09:00', endTime: '11:00' },
      { weekdays: [1], startTime: '10:00', endTime: '12:00' },
    ] }), zone), /chevauchent/)
  })
  it('refuse les dates normalisées, les périodes inversées et les lots vides', () => {
    for (const overrides of [
      { startsOn: '2026-02-30' }, { endsOn: '2026-01-01' },
      { slots: [] }, { startsOn: '2026-10-20', endsOn: '2026-10-20' },
    ]) assert.throws(() => expandRecurrence(input(overrides), zone))
  })
  it('refuse les horaires impossibles et les jours hors de la semaine', () => {
    for (const slot of [
      { weekdays: [0], startTime: '09:00', endTime: '10:00' },
      { weekdays: [], startTime: '09:00', endTime: '10:00' },
      { weekdays: [1], startTime: '09:00', endTime: '09:00' },
      { weekdays: [1], startTime: '25:00', endTime: '26:00' },
    ]) assert.throws(() => expandRecurrence(input({ slots: [slot] }), zone))
  })
  it('refuse une heure inexistante au passage à l’heure d’été', () => {
    assert.throws(() => expandRecurrence(input({ startsOn: '2026-03-29', endsOn: '2026-03-29',
      slots: [{ weekdays: [7], startTime: '02:30', endTime: '04:00' }],
    }), zone), /inexistant/)
  })
  it('limite la période et le nombre d’occurrences', () => {
    assert.throws(() => expandRecurrence(input({ endsOn: '2027-10-20' }), zone), /un an/)
    assert.throws(() => expandRecurrence(input({ endsOn: '2027-10-19', slots: [
      { weekdays: [1, 2, 3, 4, 5, 6, 7], startTime: '09:00', endTime: '10:00' },
      { weekdays: [1, 2, 3, 4, 5, 6, 7], startTime: '14:00', endTime: '15:00' },
    ] }), zone), /500/)
  })
})
