import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { wallClockToUtc } from '../../lib/dates.ts'
import { OPEN_ENDED_BOOKING_END } from '../reservations/schema.ts'
import type { ClosurePeriod, OpeningRule } from '../ressources/ouverture.ts'
import {
  dailyOccupancy,
  formatHours,
  formatRate,
  monthlyOccupancy,
  occupancyRate,
  summarizeOccupancy,
  type ObservedResource,
  type OccupancyResource,
  type OccupyingBooking,
} from './occupation.ts'
import { monthPeriod, periodDays, type Period } from './periode.ts'

const PARIS = 'Europe/Paris'
const at = (wall: string) => wallClockToUtc(wall, PARIS)

const SALLE = 'r-salle'
const SALON = 'r-salon'
const BUREAU = 'r-bureau'
const ANCIEN = 'r-ancien'

/** Le centre ouvre de 9h à 18h (540 minutes) du lundi au vendredi. */
const centre: OpeningRule[] = [1, 2, 3, 4, 5].map((weekday) => ({
  resourceId: null,
  weekday,
  opensAt: '09:00:00',
  closesAt: '18:00:00',
}))

const ressource = (
  id: string,
  resourceType: OccupancyResource['resourceType'],
  overrides: Partial<OccupancyResource> = {},
): OccupancyResource => ({ id, resourceType, status: 'active', deletedAt: null, ...overrides })

const occupation = (
  resourceId: string,
  start: string,
  end: string,
  overrides: Partial<OccupyingBooking> = {},
): OccupyingBooking => ({
  resourceId,
  kind: 'booking',
  status: 'confirmed',
  startsAt: at(start),
  endsAt: at(end),
  ...overrides,
})

/** Occupation d'un contrat : des journées entières du centre (ADR 018). */
const contrat = (resourceId: string, firstDay: string, dayAfterLast: string | null): OccupyingBooking => ({
  resourceId,
  kind: 'contract',
  status: 'confirmed',
  startsAt: at(`${firstDay}T00:00`),
  endsAt: dayAfterLast ? at(`${dayAfterLast}T00:00`) : OPEN_ENDED_BOOKING_END,
})

const calcul = (input: {
  resources: OccupancyResource[]
  period: Period
  bookings?: OccupyingBooking[]
  rules?: OpeningRule[]
  closures?: ClosurePeriod[]
  /** Jours d'existence des ressources, s'ils sont bornés. */
  lifetimes?: Record<string, Omit<ObservedResource, 'id'>>
}) => {
  const daily = dailyOccupancy({
    resources: input.resources.map((resource) => ({ id: resource.id, ...input.lifetimes?.[resource.id] })),
    days: periodDays(input.period),
    bookings: input.bookings ?? [],
    rules: input.rules ?? centre,
    closures: input.closures ?? [],
    timeZone: PARIS,
  })
  return summarizeOccupancy(daily, input.resources, input.period)
}

/** Octobre 2026 compte 22 jours ouvrés, du jeudi 1er au vendredi 30. */
const OCTOBRE = monthPeriod('2026-10')
const OUVERTURE_OCTOBRE = 22 * 540

describe('occupancyRate', () => {
  it('n’a pas de taux sans heure d’ouverture', () => {
    assert.equal(occupancyRate({ openMinutes: 0, busyMinutes: 0 }), null)
  })

  it('ne dit 0 que si rien n’est occupé, 100 % que si tout l’est', () => {
    assert.equal(occupancyRate({ openMinutes: 11_880, busyMinutes: 0 }), 0)
    assert.equal(occupancyRate({ openMinutes: 11_880, busyMinutes: 1 }), 1)
    assert.equal(occupancyRate({ openMinutes: 11_880, busyMinutes: 11_879 }), 999)
    assert.equal(occupancyRate({ openMinutes: 11_880, busyMinutes: 11_880 }), 1000)
    assert.equal(occupancyRate({ openMinutes: 540, busyMinutes: 180 }), 333)
    assert.equal(occupancyRate({ openMinutes: 600, busyMinutes: 300 }), 500)
  })

  it('s’écrit en pour cent à une décimale, et en heures décimales', () => {
    assert.match(formatRate(473), /^47,3\s%$/u)
    assert.match(formatRate(1000), /^100,0\s%$/u)
    assert.equal(formatRate(null), '—')
    assert.equal(formatHours(90), '1,5 h')
    assert.match(formatHours(74_070), /^1\s234,5 h$/u)
  })
})

describe('occupation d’une ressource', () => {
  it('compte les réservations confirmées, dans les heures d’ouverture seulement', () => {
    const lundi = { from: '2026-10-05', to: '2026-10-05' }
    const { resources } = calcul({
      resources: [ressource(SALLE, 'salle')],
      period: lundi,
      bookings: [
        occupation(SALLE, '2026-10-05T09:00', '2026-10-05T11:00'),
        // Déborde après la fermeture : seule l'heure de 17h à 18h compte.
        occupation(SALLE, '2026-10-05T17:00', '2026-10-05T19:00'),
        // Ni une demande en attente, ni une annulée, ni un entretien.
        occupation(SALLE, '2026-10-05T12:00', '2026-10-05T13:00', { status: 'pending' }),
        occupation(SALLE, '2026-10-05T13:00', '2026-10-05T14:00', { status: 'cancelled' }),
        occupation(SALLE, '2026-10-05T14:00', '2026-10-05T15:00', { kind: 'unavailability' }),
      ],
    })
    assert.equal(resources.length, 1)
    assert.equal(resources[0].openMinutes, 540)
    assert.equal(resources[0].busyMinutes, 180)
    assert.equal(resources[0].contractMinutes, 0)
    assert.equal(resources[0].rate, 333)
  })

  it('compte une ressource sous contrat comme occupée sur ses jours d’occupation', () => {
    const { resources } = calcul({
      resources: [ressource(BUREAU, 'bureau')],
      period: OCTOBRE,
      // Contrat du 1er au 15 octobre : onze jours ouvrés sur vingt-deux.
      bookings: [contrat(BUREAU, '2026-10-01', '2026-10-16')],
    })
    const [bureau] = resources
    assert.equal(bureau.openMinutes, OUVERTURE_OCTOBRE)
    assert.equal(bureau.busyMinutes, 11 * 540)
    assert.equal(bureau.contractMinutes, 11 * 540)
    assert.equal(bureau.contractDays, 11)
    assert.equal(bureau.rate, 500)
  })

  it('compte un contrat sans terme sur toute la période', () => {
    const { resources } = calcul({
      resources: [ressource(BUREAU, 'bureau')],
      period: OCTOBRE,
      bookings: [contrat(BUREAU, '2026-01-01', null)],
    })
    assert.equal(resources[0].rate, 1000)
    assert.equal(resources[0].contractDays, 22)
  })

  it('suit les horaires propres d’une ressource, qui remplacent ceux du centre', () => {
    // Le salon n'ouvre que le samedi, de 10h à 12h : cinq samedis en octobre.
    const rules = [...centre, { resourceId: SALON, weekday: 6, opensAt: '10:00:00', closesAt: '12:00:00' }]
    const { resources } = calcul({
      resources: [ressource(SALON, 'salle')],
      period: OCTOBRE,
      rules,
      bookings: [
        occupation(SALON, '2026-10-10T10:00', '2026-10-10T12:00'),
        // Un mardi : hors de ses horaires, ne compte pas.
        occupation(SALON, '2026-10-06T10:00', '2026-10-06T12:00'),
      ],
    })
    assert.equal(resources[0].openMinutes, 5 * 120)
    assert.equal(resources[0].busyMinutes, 120)
    assert.equal(resources[0].rate, 200)
  })

  it('retire les jours de fermeture, du centre pour tous, d’une ressource pour elle seule', () => {
    const closures: ClosurePeriod[] = [
      { resourceId: null, startsOn: '2026-10-30', endsOn: '2026-10-30' },
      { resourceId: SALLE, startsOn: '2026-10-26', endsOn: '2026-10-29' },
    ]
    const { resources } = calcul({
      resources: [ressource(SALLE, 'salle'), ressource(BUREAU, 'bureau')],
      period: OCTOBRE,
      closures,
      // Une réservation un jour fermé ne compte pas : il n'y a rien à occuper.
      bookings: [occupation(SALLE, '2026-10-27T09:00', '2026-10-27T18:00')],
    })
    const [salle, bureau] = resources
    assert.equal(salle.openMinutes, (22 - 5) * 540)
    assert.equal(salle.busyMinutes, 0)
    assert.equal(bureau.openMinutes, (22 - 1) * 540)
  })

  it('ne compte une ressource ouverte qu’entre sa déclaration et son archivage', () => {
    const { resources } = calcul({
      resources: [ressource(BUREAU, 'bureau'), ressource(SALLE, 'salle', { deletedAt: new Date('2026-10-07T10:00:00Z') })],
      period: OCTOBRE,
      lifetimes: {
        // Déclaré le jeudi 15 : douze jours ouvrés jusqu'au 30.
        [BUREAU]: { firstDay: '2026-10-15' },
        // Archivée le mercredi 7, ce jour compris : cinq jours ouvrés.
        [SALLE]: { firstDay: '2026-09-01', lastDay: '2026-10-07' },
      },
      bookings: [occupation(SALLE, '2026-10-06T09:00', '2026-10-06T18:00')],
    })
    const [bureau, salle] = resources
    assert.equal(bureau.openMinutes, 12 * 540)
    assert.equal(salle.openMinutes, 5 * 540)
    assert.equal(salle.rate, 200)
  })

  it('avance le premier jour à la plus ancienne réservation reprise', () => {
    const { resources } = calcul({
      resources: [ressource(SALLE, 'salle')],
      period: OCTOBRE,
      lifetimes: { [SALLE]: { firstDay: '2026-10-15' } },
      // Réservation reprise de l'historique, antérieure à la déclaration.
      bookings: [occupation(SALLE, '2026-10-05T09:00', '2026-10-05T18:00')],
    })
    // Du lundi 5 au vendredi 30 : vingt jours ouvrés.
    assert.equal(resources[0].openMinutes, 20 * 540)
    assert.equal(resources[0].busyMinutes, 540)
  })

  it('garde neuf heures d’ouverture le jour du passage à l’heure d’hiver', () => {
    // Dimanche 25 octobre 2026 : la journée civile dure 25 heures.
    const rules: OpeningRule[] = [{ resourceId: null, weekday: 7, opensAt: '09:00:00', closesAt: '18:00:00' }]
    const dimanche = { from: '2026-10-25', to: '2026-10-25' }
    const { resources } = calcul({
      resources: [ressource(SALLE, 'salle')],
      period: dimanche,
      rules,
      bookings: [occupation(SALLE, '2026-10-25T09:00', '2026-10-25T13:30')],
    })
    assert.equal(resources[0].openMinutes, 540)
    assert.equal(resources[0].busyMinutes, 270)
    assert.equal(resources[0].rate, 500)
  })
})

describe('occupation par type et du parc', () => {
  it('somme les minutes du type, sans faire la moyenne des taux', () => {
    const rules = [...centre, { resourceId: SALON, weekday: 1, opensAt: '09:00:00', closesAt: '10:00:00' }]
    const lundi = { from: '2026-10-05', to: '2026-10-05' }
    const { types, total } = calcul({
      resources: [ressource(SALLE, 'salle'), ressource(SALON, 'salle'), ressource(BUREAU, 'bureau')],
      period: lundi,
      rules,
      bookings: [
        // Salle pleine (540 min), salon vide (60 min ouvertes).
        occupation(SALLE, '2026-10-05T09:00', '2026-10-05T18:00'),
        contrat(BUREAU, '2026-10-01', null),
      ],
    })
    assert.deepEqual(
      types.map((type) => [type.resourceType, type.resourceCount, type.openMinutes, type.busyMinutes, type.rate]),
      [
        // 540 / 600 = 90 %, quand la moyenne des taux dirait 50 %.
        ['salle', 2, 600, 540, 900],
        ['bureau', 1, 540, 540, 1000],
      ],
    )
    assert.equal(total.openMinutes, 1140)
    assert.equal(total.busyMinutes, 1080)
    assert.equal(total.contractMinutes, 540)
    assert.equal(total.rate, 947)
  })

  it('écarte une ressource retirée ou archivée restée vide, garde celle qui a servi', () => {
    const lundi = { from: '2026-10-05', to: '2026-10-05' }
    const { resources, total } = calcul({
      resources: [
        ressource(SALLE, 'salle'),
        ressource(ANCIEN, 'salle', { status: 'retired' }),
        ressource(SALON, 'salle', { deletedAt: new Date('2026-09-01T00:00:00Z') }),
        ressource(BUREAU, 'bureau', { status: 'maintenance' }),
      ],
      period: lundi,
      bookings: [occupation(SALON, '2026-10-05T09:00', '2026-10-05T10:00')],
    })
    assert.deepEqual(
      resources.map((row) => row.resource.id),
      [SALLE, SALON, BUREAU],
    )
    assert.equal(total.openMinutes, 3 * 540)
    assert.equal(total.busyMinutes, 60)
  })
})

describe('occupation mois par mois', () => {
  it('rend un taux du parc par mois, sur les mêmes jours', () => {
    const period = { from: '2026-09-01', to: '2026-10-31' }
    const resources = [ressource(BUREAU, 'bureau'), ressource(SALLE, 'salle')]
    const daily = dailyOccupancy({
      resources,
      days: periodDays(period),
      // Le bureau est loué à partir du 1er octobre.
      bookings: [contrat(BUREAU, '2026-10-01', null)],
      rules: centre,
      closures: [],
      timeZone: PARIS,
    })
    const [septembre, octobre] = monthlyOccupancy(daily, resources, ['2026-09', '2026-10'])
    // Septembre 2026 : 22 jours ouvrés, rien d'occupé.
    assert.equal(septembre.totals.openMinutes, 2 * 22 * 540)
    assert.equal(septembre.rate, 0)
    assert.equal(octobre.totals.busyMinutes, OUVERTURE_OCTOBRE)
    assert.equal(octobre.rate, 500)
  })
})
