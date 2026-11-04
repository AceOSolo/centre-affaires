import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { historyHref, isFiltered, pageCount, parseHistoryFilters } from './historique.ts'

const PARIS = 'Europe/Paris'
const CLIENT = '01a00000-0000-7000-8000-000000071c01'
const RESSOURCE = '01a00000-0000-7000-8000-000000071b01'

describe('historique des états des lieux : filtres de l’adresse (ADR 063)', () => {
  it('lit client, ressource, étape, état et produit', () => {
    const filters = parseHistoryFilters(
      { client: CLIENT, ressource: RESSOURCE, nature: 'sortie', etape: 'signed', produit: 'vehicules' },
      PARIS,
    )
    assert.deepEqual(filters.query, {
      clientId: CLIENT,
      resourceId: RESSOURCE,
      kind: 'exit',
      stage: 'signed',
      resourceTypes: ['vehicule'],
    })
    assert.equal(filters.product?.key, 'vehicules')
    assert.equal(filters.page, 1)
    assert.ok(isFiltered(filters))
  })

  it('ignore une valeur inconnue ou mal formée plutôt que d’échouer', () => {
    const filters = parseHistoryFilters(
      { client: 'pas-un-uuid', nature: 'milieu', etape: 'perdu', produit: 'fusées', du: '2026-02-30', page: '-2' },
      PARIS,
    )
    assert.deepEqual(filters.query, {})
    assert.deepEqual(filters.values, {})
    assert.equal(filters.page, 1)
    assert.equal(isFiltered(filters), false)
  })

  it('compte la période en journées du centre, le dernier jour compris, changement d’heure traversé', () => {
    // Le 25 octobre 2026, Paris repasse à l'heure d'hiver.
    const { query } = parseHistoryFilters({ du: '2026-10-24', au: '2026-10-25' }, PARIS)
    assert.equal(query.from?.toISOString(), '2026-10-23T22:00:00.000Z')
    assert.equal(query.until?.toISOString(), '2026-10-25T23:00:00.000Z')
  })

  it('dit une période à l’envers sans l’appliquer, et garde les dates saisies', () => {
    const filters = parseHistoryFilters({ du: '2026-11-04', au: '2026-11-01' }, PARIS)
    assert.match(filters.periodError ?? '', /précède/)
    assert.equal(filters.query.from, undefined)
    assert.equal(filters.query.until, undefined)
    assert.deepEqual(filters.values, { du: '2026-11-04', au: '2026-11-01' })
  })

  it('refait l’adresse avec les filtres et la page, sans écrire la première', () => {
    const { values } = parseHistoryFilters({ etape: 'draft', ressource: RESSOURCE, page: '3' }, PARIS)
    assert.equal(historyHref(values), `/etats-des-lieux?ressource=${RESSOURCE}&etape=draft`)
    assert.equal(historyHref(values, 2), `/etats-des-lieux?ressource=${RESSOURCE}&etape=draft&page=2`)
    assert.equal(historyHref({}), '/etats-des-lieux')
    // Les tuiles d'« Aujourd'hui » gardent leur adresse (ADR 050).
    assert.equal(parseHistoryFilters({ etape: 'to_sign' }, PARIS).query.stage, 'to_sign')
  })

  it('compte les pages, une au moins', () => {
    assert.equal(pageCount(0), 1)
    assert.equal(pageCount(50), 1)
    assert.equal(pageCount(51), 2)
  })
})
