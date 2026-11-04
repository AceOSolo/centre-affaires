import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { products } from '../ressources/produits.ts'
import {
  MAX_REQUEST_DAYS_LIMIT,
  defaultMaxRequestDays,
  formatDays,
  maxRequestDays,
  maxRequestDaysFor,
  parseMaxRequestDays,
  periodProducts,
} from './durees.ts'

/**
 * Durée maximale d'une demande en ligne, par produit (ADR 061) : elle remplace
 * la limite de huit heures de la page publique.
 */
describe('durée maximale d’une demande en ligne', () => {
  it('chaque produit dit s’il se réserve sur une période', () => {
    assert.deepEqual(Object.keys(defaultMaxRequestDays).sort(), products.map((product) => product.key).sort())
    assert.deepEqual(periodProducts().map((product) => product.key), ['salles', 'bureaux', 'vehicules'])
  })

  it('prend le réglage du centre, sinon la valeur par défaut', () => {
    assert.equal(maxRequestDays({}, 'vehicules'), 7)
    assert.equal(maxRequestDays(null, 'salles'), 5)
    assert.equal(maxRequestDays({ vehicules: 3 }, 'vehicules'), 3)
    assert.equal(maxRequestDaysFor({ salles: 1 }, 'salle'), 1)
    assert.equal(maxRequestDaysFor({ bureaux: 2 }, 'bureau'), 2)
    // Un réglage illisible en base ne lève pas : la valeur par défaut tient.
    assert.equal(maxRequestDays({ salles: 0 }, 'salles'), 5)
    assert.equal(maxRequestDays({ salles: 2.5 }, 'salles'), 5)
    assert.equal(maxRequestDays({ salles: MAX_REQUEST_DAYS_LIMIT + 1 }, 'salles'), 5)
    // La domiciliation ne se réserve pas sur une période : le jour même.
    assert.equal(maxRequestDays({ domiciliation: 30 }, 'domiciliation'), 1)
  })

  it('lit le formulaire du réglage, champ par champ', () => {
    const form = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null })
    assert.deepEqual(parseMaxRequestDays(form({ 'maxDays.salles': '3', 'maxDays.vehicules': ' 10 ' })), {
      ok: true,
      settings: { salles: 3, vehicules: 10 },
    })
    // Vide : la valeur par défaut, rien d'enregistré.
    assert.deepEqual(parseMaxRequestDays(form({ 'maxDays.bureaux': '' })), { ok: true, settings: {} })
    const refused = parseMaxRequestDays(form({ 'maxDays.salles': '0', 'maxDays.vehicules': '91', 'maxDays.bureaux': 'deux' }))
    assert.equal(refused.ok, false)
    if (!refused.ok) assert.deepEqual(Object.keys(refused.errors).sort(), ['bureaux', 'salles', 'vehicules'])
  })

  it('dit la durée en jours', () => {
    assert.equal(formatDays(1), '1 jour')
    assert.equal(formatDays(7), '7 jours')
  })
})
