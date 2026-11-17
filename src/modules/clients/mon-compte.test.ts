import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PROFILE_NAME_MAX, readProfileForm } from './mon-compte.ts'

const form = (fields: Record<string, string>) => ({ get: (name: string) => fields[name] ?? null })

describe('« Mon compte » : nom et téléphone (ADR 077)', () => {
  it('range le nom et met le téléphone en forme', () => {
    const read = readProfileForm(form({ fullName: '  Camille   Martin ', phone: '0612345678' }))
    assert.deepEqual(read.input, { fullName: 'Camille Martin', phone: '06 12 34 56 78' })
  })

  it('admet un téléphone vide', () => {
    assert.deepEqual(readProfileForm(form({ fullName: 'Camille Martin', phone: '' })).input, {
      fullName: 'Camille Martin',
      phone: null,
    })
  })

  it('exige le nom, borne sa longueur, refuse un numéro incomplet en gardant la saisie', () => {
    const vide = readProfileForm(form({ fullName: '  ', phone: '06 12' }))
    assert.ok(vide.errors?.fullName)
    assert.ok(vide.errors?.phone)
    assert.deepEqual(vide.values, { fullName: '  ', phone: '06 12' })

    const long = readProfileForm(form({ fullName: 'a'.repeat(PROFILE_NAME_MAX + 1), phone: '' }))
    assert.ok(long.errors?.fullName)
  })

  it('accepte un numéro international', () => {
    assert.equal(readProfileForm(form({ fullName: 'Camille Martin', phone: '+32 2 123 45 67' })).input?.phone, '+32 2 123 45 67')
  })
})
