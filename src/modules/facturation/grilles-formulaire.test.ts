import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { validateRatePlanForm } from './grilles-formulaire.ts'

const saisie = (overrides: Partial<Parameters<typeof validateRatePlanForm>[0]> = {}) => ({
  name: 'Tarifs publics 2027',
  validFrom: '',
  validTo: '',
  isDefault: false,
  ...overrides,
})

describe('validateRatePlanForm (R08)', () => {
  it('accepte une grille sans dates : valable toujours', () => {
    assert.deepEqual(validateRatePlanForm(saisie()), {
      ok: true,
      input: { name: 'Tarifs publics 2027', validFrom: null, validTo: null, isDefault: false },
    })
  })

  it('garde les dates de validité, bornes comprises', () => {
    const result = validateRatePlanForm(saisie({ validFrom: '2027-01-01', validTo: '2027-12-31', isDefault: true }))
    assert.deepEqual(result, {
      ok: true,
      input: { name: 'Tarifs publics 2027', validFrom: '2027-01-01', validTo: '2027-12-31', isDefault: true },
    })
  })

  it('accepte une grille d’un seul jour', () => {
    assert.equal(validateRatePlanForm(saisie({ validFrom: '2027-01-01', validTo: '2027-01-01' })).ok, true)
  })

  it('refuse une fin avant le début, sous le champ de fin', () => {
    assert.deepEqual(validateRatePlanForm(saisie({ validFrom: '2027-02-01', validTo: '2027-01-31' })), {
      ok: false,
      fieldErrors: { validTo: 'La fin de validité doit suivre le début.' },
    })
  })

  it('refuse une date qui n’existe pas', () => {
    const result = validateRatePlanForm(saisie({ validFrom: '2027-02-30' }))
    assert.deepEqual(result, { ok: false, fieldErrors: { validFrom: 'Date illisible.' } })
  })

  it('exige un nom', () => {
    const result = validateRatePlanForm(saisie({ name: '   ' }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.fieldErrors.name, 'Nommez la grille.')
  })
})
