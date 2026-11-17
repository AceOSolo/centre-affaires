import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseAttributes } from './attributs.ts'
import {
  acceptsRentalFormulas,
  describeFormulas,
  formulaFieldName,
  formulaOfUnit,
  formulasOf,
  parseFormulas,
  rentalFormulaUnits,
} from './formules.ts'
import { describeAttributes } from './labels.ts'

/** Formules de location d'un bureau et son agencement (ADR 076). */
describe('formules de location d’un bureau', () => {
  it('ne se règlent que sur un bureau', () => {
    assert.equal(acceptsRentalFormulas('bureau'), true)
    assert.equal(acceptsRentalFormulas('salle'), false)
    assert.deepEqual(formulasOf({ resourceType: 'salle', attributes: { formules: ['journee'] } }), [])
  })

  it('se lisent dans les attributs, dans l’ordre de référence, sans valeur inconnue', () => {
    assert.deepEqual(formulasOf({ resourceType: 'bureau', attributes: { formules: ['mois', 'inconnue', 'journee'] } }), [
      'journee',
      'mois',
    ])
    assert.deepEqual(formulasOf({ resourceType: 'bureau', attributes: {} }), [])
    assert.deepEqual(formulasOf({ resourceType: 'bureau', attributes: null }), [])
  })

  it('se cochent sur la fiche, une case par formule', () => {
    const form = new Map([
      [formulaFieldName('semaine'), 'on'],
      [formulaFieldName('heure'), 'on'],
    ])
    assert.deepEqual(parseFormulas(form), ['heure', 'semaine'])
    assert.deepEqual(parseFormulas(new Map()), [])
  })

  it('font le prix par l’unité de Dolibarr (`tarif.bureau.<unité>`), et se retrouvent par elle', () => {
    assert.equal(rentalFormulaUnits.semaine, 'week')
    assert.equal(rentalFormulaUnits.mois, 'month')
    assert.equal(formulaOfUnit('week', ['journee', 'semaine']), 'semaine')
    assert.equal(formulaOfUnit('hour', ['journee', 'semaine']), undefined)
  })

  it('se disent sur l’annonce avec l’agencement', () => {
    assert.equal(describeFormulas(['journee', 'mois']), 'à la journée, au mois')
    assert.equal(
      describeAttributes({ postes: 4, agencement: 'Open space', formules: ['journee', 'mois'] }),
      '4 postes · Open space · à la journée, au mois',
    )
  })
})

describe('agencement d’un bureau', () => {
  const read = (values: Record<string, string>) => (name: string) => values[name] ?? ''

  it('accepte open space ou bureau fermé, sans tenir compte de la casse', () => {
    assert.deepEqual(parseAttributes('bureau', read({ agencement: 'open space' })).attributes, { agencement: 'Open space' })
    assert.deepEqual(parseAttributes('bureau', read({ agencement: 'Bureau fermé' })).attributes, { agencement: 'Bureau fermé' })
    assert.ok(parseAttributes('bureau', read({ agencement: 'Plateau' })).errors.agencement)
  })

  it('garde la taille d’un casier telle qu’avant', () => {
    assert.deepEqual(parseAttributes('casier', read({ numero: '12', taille: 'm' })).attributes, { numero: '12', taille: 'M' })
  })
})
