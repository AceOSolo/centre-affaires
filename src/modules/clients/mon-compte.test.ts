import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { NAME_PART_MAX, readProfileForm } from './mon-compte.ts'

const form = (fields: Record<string, string>) => ({ get: (name: string) => fields[name] ?? null })

describe('« Mon compte » : prénom, nom et téléphone (ADR 077, ADR 084)', () => {
  it('range le prénom et le nom, recompose le nom complet, met le téléphone en forme', () => {
    const read = readProfileForm(form({ firstName: '  Jean   Pierre ', lastName: ' de la  Fontaine', phone: '0612345678' }))
    assert.deepEqual(read.input, { firstName: 'Jean Pierre', lastName: 'de la Fontaine', fullName: 'Jean Pierre de la Fontaine', phone: '06 12 34 56 78' })
  })

  it('admet un téléphone vide', () => {
    assert.equal(readProfileForm(form({ firstName: 'Camille', lastName: 'Martin', phone: '' })).input?.phone, null)
  })

  it('exige le prénom et le nom, chacun dans son champ, et garde la saisie', () => {
    const vide = readProfileForm(form({ firstName: '  ', lastName: '', phone: '06 12' }))
    assert.ok(vide.errors?.firstName)
    assert.ok(vide.errors?.lastName)
    assert.ok(vide.errors?.phone)
    assert.deepEqual(vide.values, { firstName: '  ', lastName: '', phone: '06 12' })

    const sansNom = readProfileForm(form({ firstName: 'Camille', lastName: '', phone: '' }))
    assert.deepEqual(Object.keys(sansNom.errors ?? {}), ['lastName'])
  })

  it('borne la longueur de chaque partie', () => {
    const long = readProfileForm(form({ firstName: 'a'.repeat(NAME_PART_MAX + 1), lastName: 'Martin', phone: '' }))
    assert.ok(long.errors?.firstName)
  })

  it('accepte un numéro international', () => {
    assert.equal(readProfileForm(form({ firstName: 'Camille', lastName: 'Martin', phone: '+32 2 123 45 67' })).input?.phone, '+32 2 123 45 67')
  })
})
