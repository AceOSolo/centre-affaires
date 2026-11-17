import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { joinName, nameErrors, splitFullName } from './prenom-nom.ts'

describe('Prénom et nom séparés (ADR 084)', () => {
  it('recompose « Prénom Nom » sans espace superflu', () => {
    assert.equal(joinName({ firstName: ' Camille ', lastName: 'Martin  Durand' }), 'Camille Martin Durand')
    assert.equal(joinName({ firstName: '', lastName: 'Martin' }), 'Martin')
  })

  it('propose un prénom et un nom à partir d’un ancien nom complet', () => {
    assert.deepEqual(splitFullName('Camille Martin'), { firstName: 'Camille', lastName: 'Martin' })
    assert.deepEqual(splitFullName('  Jean  de la Fontaine '), { firstName: 'Jean', lastName: 'de la Fontaine' })
    assert.deepEqual(splitFullName('Camille'), { firstName: 'Camille', lastName: '' })
    assert.deepEqual(splitFullName(null), { firstName: '', lastName: '' })
  })

  it('exige les deux parties', () => {
    assert.deepEqual(Object.keys(nameErrors({ firstName: ' ', lastName: '' })), ['firstName', 'lastName'])
    assert.deepEqual(nameErrors({ firstName: 'Camille', lastName: 'Martin' }), {})
  })
})
