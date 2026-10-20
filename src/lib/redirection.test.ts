import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { safeRedirect } from './redirection.ts'

describe('safeRedirect', () => {
  it('suit un chemin du site, requête comprise', () => {
    assert.equal(safeRedirect('/reservations'), '/reservations')
    assert.equal(safeRedirect('/comptes?etat=banni'), '/comptes?etat=banni')
  })

  it('refuse ce qui mène hors du site', () => {
    assert.equal(safeRedirect('https://exemple.test'), null)
    assert.equal(safeRedirect('//exemple.test'), null)
    assert.equal(safeRedirect('/\\exemple.test'), null)
    assert.equal(safeRedirect('javascript:alert(1)'), null)
  })

  it('rend null sans chemin', () => {
    assert.equal(safeRedirect(null), null)
    assert.equal(safeRedirect(''), null)
  })
})
