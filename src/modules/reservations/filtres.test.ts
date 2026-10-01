import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ResourceType } from '../ressources/schema.ts'
import {
  filterBookings,
  filterResources,
  firstParam,
  groupByType,
  isIsoDate,
  newBookingHref,
  parsePlanningFilters,
  planningDate,
  planningHref,
  planningResources,
} from './filtres.ts'

const CLIENT = '01a00000-0000-7000-8000-0000000c0c01'
const AUTRE = '01a00000-0000-7000-8000-0000000c0c02'

describe('parsePlanningFilters', () => {
  it('retient un type connu et un client bien formé', () => {
    assert.deepEqual(parsePlanningFilters({ type: 'salle', client: CLIENT }), {
      type: 'salle',
      client: CLIENT,
    })
  })

  it('ignore un type inconnu et un client mal formé', () => {
    assert.deepEqual(parsePlanningFilters({ type: 'parking', client: 'abc' }), {})
  })

  it('ne retient le client que s’il fait partie des clients connus', () => {
    assert.deepEqual(parsePlanningFilters({ client: AUTRE }, [CLIENT]), {})
    assert.deepEqual(parsePlanningFilters({ client: CLIENT.toUpperCase() }, [CLIENT]), {
      client: CLIENT,
    })
  })

  it('prend la première valeur d’un paramètre répété', () => {
    assert.equal(firstParam(['bureau', 'salle']), 'bureau')
    assert.deepEqual(parsePlanningFilters({ type: ['bureau', 'salle'] }), { type: 'bureau' })
  })
})

describe('planningDate et isIsoDate', () => {
  it('garde un jour valide, retombe sur aujourd’hui sinon', () => {
    assert.equal(planningDate('2026-10-05', '2026-10-01'), '2026-10-05')
    assert.equal(planningDate('2026-02-31', '2026-10-01'), '2026-10-01')
    assert.equal(planningDate(undefined, '2026-10-01'), '2026-10-01')
    assert.equal(isIsoDate('2028-02-29'), true)
    assert.equal(isIsoDate('2026-13-01'), false)
  })
})

describe('planningHref', () => {
  it('conserve date et filtres d’une vue à l’autre, dans un ordre fixe', () => {
    const filtres = { date: '2026-10-05', type: 'bureau', client: CLIENT } as const
    assert.equal(
      planningHref('jour', filtres),
      `/reservations?date=2026-10-05&type=bureau&client=${CLIENT}`,
    )
    assert.equal(
      planningHref('semaine', filtres),
      `/reservations/semaine?date=2026-10-05&type=bureau&client=${CLIENT}`,
    )
    assert.equal(
      planningHref('mois', filtres),
      `/reservations/mois?date=2026-10-05&type=bureau&client=${CLIENT}`,
    )
  })

  it('omet les filtres absents', () => {
    assert.equal(planningHref('jour', {}), '/reservations')
    assert.equal(planningHref('mois', { date: '2026-10-05' }), '/reservations/mois?date=2026-10-05')
  })

  it('ne garde la ressource qu’en vue semaine', () => {
    assert.equal(
      planningHref('semaine', { date: '2026-10-05', ressource: 'r1' }),
      '/reservations/semaine?date=2026-10-05&ressource=r1',
    )
    assert.equal(planningHref('jour', { date: '2026-10-05', ressource: 'r1' }), '/reservations?date=2026-10-05')
  })
})

describe('newBookingHref', () => {
  it('pré-remplit jour, ressource, heure et client', () => {
    assert.equal(
      newBookingHref({ date: '2026-10-05', resourceId: 'r1', start: '10:15', client: CLIENT }),
      `/reservations/nouvelle?date=2026-10-05&resourceId=r1&start=10%3A15&clientId=${CLIENT}`,
    )
    assert.equal(
      newBookingHref({ date: '2026-10-05', resourceId: 'r1' }),
      '/reservations/nouvelle?date=2026-10-05&resourceId=r1',
    )
  })
})

describe('planningResources et groupByType', () => {
  type Ligne = { id: string; resourceType: ResourceType; code: string }
  const salle1: Ligne = { id: 's1', resourceType: 'salle', code: 'S-1' }
  const salle2: Ligne = { id: 's2', resourceType: 'salle', code: 'S-2' }
  const bureau: Ligne = { id: 'b1', resourceType: 'bureau', code: 'B-1' }
  const boite: Ligne = { id: 'd1', resourceType: 'boite_aux_lettres', code: 'DOM-01' }

  it('ajoute aux réservables les ressources qui ont des réservations, sans doublon', () => {
    // Le bureau est en maintenance mais garde une réservation cette semaine.
    const lignes = planningResources([salle2, boite, salle1], [bureau, salle1], {})
    assert.deepEqual(
      lignes.map((r) => r.id),
      ['s1', 's2', 'b1', 'd1'],
    )
  })

  it('applique le filtre de type aux deux sources', () => {
    assert.deepEqual(
      planningResources([salle1, boite], [bureau], { type: 'bureau' }).map((r) => r.id),
      ['b1'],
    )
  })

  it('regroupe par type dans l’ordre reçu', () => {
    assert.deepEqual(
      groupByType([salle1, salle2, bureau, boite]).map((g) => [g.type, g.resources.length]),
      [
        ['salle', 2],
        ['bureau', 1],
        ['boite_aux_lettres', 1],
      ],
    )
  })
})

describe('filterResources et filterBookings', () => {
  const ressources = [
    { id: 's1', resourceType: 'salle' as const },
    { id: 'b1', resourceType: 'bureau' as const },
    { id: 's2', resourceType: 'salle' as const },
  ]

  it('garde les ressources du type choisi, toutes sans type', () => {
    assert.deepEqual(
      filterResources(ressources, { type: 'salle' }).map((r) => r.id),
      ['s1', 's2'],
    )
    assert.equal(filterResources(ressources, {}).length, 3)
  })

  it('ne garde que les réservations des ressources affichées', () => {
    const reservations = [{ resourceId: 's1' }, { resourceId: 'b1' }, { resourceId: 's2' }]
    assert.deepEqual(filterBookings(reservations, new Set(['s1', 's2'])), [
      { resourceId: 's1' },
      { resourceId: 's2' },
    ])
  })
})
