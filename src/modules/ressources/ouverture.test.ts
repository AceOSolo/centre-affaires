import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatTime } from '../../lib/dates.ts'
import {
  closuresForResource,
  isClosedOn,
  isWithinOpeningHours,
  isoWeekday,
  openingExtent,
  openingWindows,
  rulesForResource,
  type ClosurePeriod,
  type OpeningRule,
} from './ouverture.ts'

const PARIS = 'Europe/Paris'
const SALLE = 'resource-salle'
const BUREAU = 'resource-bureau'

const regle = (weekday: number, opensAt: string, closesAt: string, resourceId: string | null = null): OpeningRule => ({
  resourceId,
  weekday,
  opensAt,
  closesAt,
})

/** Semaine type : 9h-18h du lundi au vendredi. */
const semaineType = [1, 2, 3, 4, 5].map((jour) => regle(jour, '09:00:00', '18:00:00'))

const heures = (windows: { startsAt: Date; endsAt: Date }[]) =>
  windows.map((w) => `${formatTime(w.startsAt, PARIS)}–${formatTime(w.endsAt, PARIS)}`)

describe('isoWeekday', () => {
  it('numérote lundi 1 et dimanche 7', () => {
    // 2026-09-14 est un lundi.
    assert.equal(isoWeekday('2026-09-14'), 1)
    assert.equal(isoWeekday('2026-09-19'), 6)
    assert.equal(isoWeekday('2026-09-20'), 7)
  })
})

describe('rulesForResource', () => {
  const regles = [...semaineType, regle(6, '10:00:00', '16:00:00', SALLE)]

  it('applique les règles du centre à une ressource qui n’en a pas', () => {
    assert.equal(rulesForResource(regles, BUREAU).length, 5)
  })

  it('remplace les règles du centre, sans les cumuler', () => {
    const propres = rulesForResource(regles, SALLE)
    assert.equal(propres.length, 1)
    assert.equal(propres[0].weekday, 6)
  })
})

describe('openingWindows', () => {
  it('ouvre aux heures du centre un jour de semaine', () => {
    const windows = openingWindows('2026-09-14', PARIS, { rules: semaineType, resourceId: BUREAU })
    assert.deepEqual(heures(windows), ['09:00–18:00'])
  })

  it('ferme le week-end quand aucune règle ne le couvre', () => {
    assert.deepEqual(openingWindows('2026-09-19', PARIS, { rules: semaineType, resourceId: BUREAU }), [])
    assert.deepEqual(openingWindows('2026-09-20', PARIS, { rules: semaineType, resourceId: BUREAU }), [])
  })

  it('rend deux fenêtres pour une journée coupée à midi', () => {
    const rules = [regle(1, '09:00:00', '12:30:00'), regle(1, '14:00:00', '18:00:00')]
    const windows = openingWindows('2026-09-14', PARIS, { rules, resourceId: BUREAU })
    assert.deepEqual(heures(windows), ['09:00–12:30', '14:00–18:00'])
  })

  it('fusionne deux plages qui se touchent', () => {
    const rules = [regle(1, '09:00:00', '12:00:00'), regle(1, '12:00:00', '18:00:00')]
    const windows = openingWindows('2026-09-14', PARIS, { rules, resourceId: BUREAU })
    assert.deepEqual(heures(windows), ['09:00–18:00'])
  })

  it('laisse une ressource ouvrir un jour où le centre est fermé', () => {
    const rules = [...semaineType, regle(6, '10:00:00', '16:00:00', SALLE)]
    assert.deepEqual(heures(openingWindows('2026-09-19', PARIS, { rules, resourceId: SALLE })), [
      '10:00–16:00',
    ])
    assert.deepEqual(openingWindows('2026-09-19', PARIS, { rules, resourceId: BUREAU }), [])
  })

  it('ferme tout pendant une fermeture exceptionnelle du centre', () => {
    const closures: ClosurePeriod[] = [
      { resourceId: null, startsOn: '2026-12-24', endsOn: '2027-01-02' },
    ]
    // 2026-12-25 est un vendredi, donc ouvert en temps normal.
    assert.deepEqual(
      openingWindows('2026-12-25', PARIS, { rules: semaineType, closures, resourceId: BUREAU }),
      [],
    )
    // La veille de la fermeture reste ouverte.
    assert.deepEqual(
      heures(openingWindows('2026-12-23', PARIS, { rules: semaineType, closures, resourceId: BUREAU })),
      ['09:00–18:00'],
    )
  })

  it('ne ferme qu’une ressource quand la fermeture la vise', () => {
    const closures: ClosurePeriod[] = [
      { resourceId: SALLE, startsOn: '2026-09-14', endsOn: '2026-09-18' },
    ]
    assert.deepEqual(
      openingWindows('2026-09-14', PARIS, { rules: semaineType, closures, resourceId: SALLE }),
      [],
    )
    assert.deepEqual(
      heures(openingWindows('2026-09-14', PARIS, { rules: semaineType, closures, resourceId: BUREAU })),
      ['09:00–18:00'],
    )
  })

  it('court jusqu’à minuit quand la fermeture est notée 24:00', () => {
    const rules = [regle(5, '18:00:00', '24:00:00')]
    // Vendredi 18 septembre 2026.
    const windows = openingWindows('2026-09-18', PARIS, { rules, resourceId: BUREAU })
    assert.equal(windows.length, 1)
    assert.equal(formatTime(windows[0].startsAt, PARIS), '18:00')
    assert.equal(windows[0].endsAt.toISOString(), '2026-09-18T22:00:00.000Z')
  })

  it('garde une journée de 9 heures au changement d’heure', () => {
    // Dimanche 25 octobre 2026 : la journée civile fait 25 heures.
    const rules = [regle(7, '09:00:00', '18:00:00')]
    const [window] = openingWindows('2026-10-25', PARIS, { rules, resourceId: BUREAU })
    const durée = (window.endsAt.getTime() - window.startsAt.getTime()) / 3_600_000
    assert.equal(durée, 9)
    assert.equal(formatTime(window.startsAt, PARIS), '09:00')
    assert.equal(formatTime(window.endsAt, PARIS), '18:00')
  })

  it('garde une journée de 9 heures au passage à l’heure d’été', () => {
    // Dimanche 29 mars 2026 : la journée civile fait 23 heures.
    const rules = [regle(7, '09:00:00', '18:00:00')]
    const [window] = openingWindows('2026-03-29', PARIS, { rules, resourceId: BUREAU })
    assert.equal((window.endsAt.getTime() - window.startsAt.getTime()) / 3_600_000, 9)
  })

  it('donne un tableau vide, pas une erreur, sans aucune règle', () => {
    assert.deepEqual(openingWindows('2026-09-14', PARIS, { rules: [], resourceId: BUREAU }), [])
  })
})

describe('closuresForResource et isClosedOn', () => {
  const closures: ClosurePeriod[] = [
    { resourceId: null, startsOn: '2026-08-01', endsOn: '2026-08-15' },
    { resourceId: SALLE, startsOn: '2026-09-10', endsOn: '2026-09-10' },
  ]

  it('retient les fermetures du centre et celles de la ressource', () => {
    assert.equal(closuresForResource(closures, SALLE).length, 2)
    assert.equal(closuresForResource(closures, BUREAU).length, 1)
  })

  it('couvre les bornes de la période', () => {
    const centre = closuresForResource(closures, BUREAU)
    assert.equal(isClosedOn(centre, '2026-08-01'), true)
    assert.equal(isClosedOn(centre, '2026-08-15'), true)
    assert.equal(isClosedOn(centre, '2026-07-31'), false)
    assert.equal(isClosedOn(centre, '2026-08-16'), false)
  })
})

describe('openingExtent', () => {
  it('va de la première ouverture à la dernière fermeture', () => {
    const rules = [regle(1, '09:00:00', '12:30:00'), regle(1, '14:00:00', '18:00:00')]
    const extent = openingExtent(openingWindows('2026-09-14', PARIS, { rules, resourceId: BUREAU }))
    assert.equal(formatTime(extent!.startsAt, PARIS), '09:00')
    assert.equal(formatTime(extent!.endsAt, PARIS), '18:00')
  })

  it('ne rend rien pour une journée fermée', () => {
    assert.equal(openingExtent([]), undefined)
  })
})

describe('isWithinOpeningHours', () => {
  const rules = [regle(1, '09:00:00', '12:30:00'), regle(1, '14:00:00', '18:00:00')]
  const windows = openingWindows('2026-09-14', PARIS, { rules, resourceId: BUREAU })
  const creneau = (debut: string, fin: string) => ({
    startsAt: new Date(`2026-09-14T${debut}:00Z`),
    endsAt: new Date(`2026-09-14T${fin}:00Z`),
  })

  it('accepte un créneau dans une plage', () => {
    // 10h00-11h00 à Paris = 08h00-09h00 UTC.
    assert.equal(isWithinOpeningHours(creneau('08:00', '09:00'), windows), true)
  })

  it('accepte un créneau collé aux bornes', () => {
    assert.equal(isWithinOpeningHours(creneau('07:00', '10:30'), windows), true)
  })

  it('refuse un créneau qui déborde de l’ouverture', () => {
    // 08h00-10h00 à Paris, avant l'ouverture.
    assert.equal(isWithinOpeningHours(creneau('06:00', '08:00'), windows), false)
  })

  it('refuse un créneau à cheval sur la pause déjeuner', () => {
    // 12h00-15h00 à Paris : chevauche les deux plages sans tenir dans aucune.
    assert.equal(isWithinOpeningHours(creneau('10:00', '13:00'), windows), false)
  })

  it('refuse tout quand la journée est fermée', () => {
    assert.equal(isWithinOpeningHours(creneau('08:00', '09:00'), []), false)
  })
})
