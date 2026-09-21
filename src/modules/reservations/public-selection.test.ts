import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { availableEnds, availableStarts, fitsFreeRange, publicSelection } from './public-selection.ts'

const timeZone = 'Europe/Paris'
const range = (start: string, end: string) => publicSelection('2026-09-22', start, end, timeZone)!

describe('choix du créneau public', () => {
  it('refuse les dates et heures normalisées, ainsi que les durées négatives', () => {
    assert.equal(publicSelection('2026-02-31', '09:00', '10:00', timeZone), undefined)
    assert.equal(publicSelection('2026-09-22', '25:00', '26:00', timeZone), undefined)
    assert.equal(publicSelection('', '09:00', '10:00', timeZone), undefined)
    assert.equal(publicSelection('2026-09-22', '10:00', '09:00', timeZone), undefined)
  })

  it('accepte les bornes libres exactes et refuse de traverser la pause de midi', () => {
    const free = [range('09:00', '12:00'), range('14:00', '18:00')]
    assert.equal(fitsFreeRange(range('09:00', '12:00'), free), true)
    assert.equal(fitsFreeRange(range('11:00', '15:00'), free), false)
    assert.equal(fitsFreeRange(range('08:45', '10:00'), free), false)
    assert.equal(fitsFreeRange(range('17:00', '18:15'), free), false)
  })

  it('propose uniquement les départs futurs laissant trente minutes libres', () => {
    const free = [range('09:00', '10:00')]
    const now = range('09:00', '10:00').startsAt
    assert.deepEqual(availableStarts(free, now), [range('09:15', '10:00').startsAt, range('09:30', '10:00').startsAt])
    assert.deepEqual(availableStarts(free, range('09:31', '10:00').startsAt), [])
  })

  it('limite les fins à la plage libre et à huit heures', () => {
    const free = [range('08:00', '22:00')]
    const ends = availableEnds(free[0].startsAt, free, timeZone)
    assert.equal(ends[0].getTime(), range('08:00', '08:30').endsAt.getTime())
    assert.equal(ends.at(-1)?.getTime(), range('08:00', '16:00').endsAt.getTime())
    assert.equal(availableEnds(range('11:30', '12:00').startsAt, [range('09:00', '12:00')], timeZone).length, 1)
  })

  it('convertit les horaires avec le fuseau du centre, été comme hiver', () => {
    assert.equal(publicSelection('2026-09-22', '09:00', '10:00', timeZone)?.startsAt.toISOString(), '2026-09-22T07:00:00.000Z')
    assert.equal(publicSelection('2026-11-02', '09:00', '10:00', timeZone)?.startsAt.toISOString(), '2026-11-02T08:00:00.000Z')
  })
})
