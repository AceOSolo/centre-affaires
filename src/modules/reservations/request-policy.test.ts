import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { availableStarts } from './public-selection.ts'
import { requestableRanges, requestBounds, requestTimingRejection, validRequestPolicy } from './request-policy.ts'
import { rejectRequest } from './requests.ts'

const now = new Date('2026-10-23T08:00:00Z')
const policy = { bookingLeadHours: 48, bookingHorizonDays: 30 }
const { earliest, latest } = requestBounds(policy, now)

describe('délais des demandes publiques', () => {
  it('applique un préavis en heures réelles et accepte exactement les bornes', () => {
    assert.equal(earliest.toISOString(), '2026-10-25T08:00:00.000Z')
    assert.equal(requestTimingRejection(new Date(earliest.getTime() - 1), policy, now), 'preavis-insuffisant')
    assert.equal(requestTimingRejection(earliest, policy, now), undefined)
    assert.equal(requestTimingRejection(latest, policy, now), undefined)
    assert.equal(requestTimingRejection(new Date(latest.getTime() + 1), policy, now), 'creneau-trop-lointain')
  })
  it('refuse une demande directe avant le préavis configuré', () => {
    assert.equal(rejectRequest({ name: 'Camille', email: 'a@b.fr', phone: '0600000000', title: 'Réunion',
      resourceIsBookable: true, recentRequestCount: 0,
      range: { startsAt: new Date('2026-10-24T09:00:00Z'), endsAt: new Date('2026-10-24T10:00:00Z') },
    }, now, policy), 'preavis-insuffisant')
  })
  it('ne propose que les départs admissibles et laisse finir après la dernière heure de départ', () => {
    const free = requestableRanges([{ startsAt: new Date(latest.getTime() - 3_600_000), endsAt: new Date(latest.getTime() + 3_600_000) }], policy, now)
    const starts = availableStarts(free, now, latest)
    assert.equal(starts.at(-1)?.getTime(), latest.getTime())
    assert.equal(free[0].endsAt.getTime(), latest.getTime() + 3_600_000)
  })
  it('arrondit les départs au quart d’heure supérieur et masque les plages trop proches', () => {
    const laterNow = new Date(now.getTime() + 1)
    const free = requestableRanges([
      { startsAt: now, endsAt: earliest },
      { startsAt: earliest, endsAt: new Date(earliest.getTime() + 3_600_000) },
    ], policy, laterNow)
    assert.equal(free.length, 1)
    assert.equal(free[0].startsAt.getTime(), earliest.getTime() + 900_000)
  })
  it('valide les bornes des réglages et refuse une fenêtre vide', () => {
    assert.equal(validRequestPolicy(policy), true)
    for (const invalid of [
      { bookingLeadHours: -1, bookingHorizonDays: 90 },
      { bookingLeadHours: 1.5, bookingHorizonDays: 90 },
      { bookingLeadHours: 24, bookingHorizonDays: 1 },
      { bookingLeadHours: 0, bookingHorizonDays: 0 },
      { bookingLeadHours: 0, bookingHorizonDays: 366 },
      { bookingLeadHours: NaN, bookingHorizonDays: 90 },
    ]) assert.equal(validRequestPolicy(invalid), false)
  })
})
