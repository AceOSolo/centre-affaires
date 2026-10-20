import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { safeRedirect } from './redirection.ts'

describe('safeRedirect', () => {
  it('suit un chemin du site, requête comprise', () => {
    assert.equal(safeRedirect('/reservations'), '/reservations')
    assert.equal(safeRedirect('/comptes?etat=banni'), '/comptes?etat=banni')
    assert.equal(safeRedirect('/compte/courrier#non-lus'), '/compte/courrier#non-lus')
  })

  it('refuse ce qui mène hors du site', () => {
    assert.equal(safeRedirect('https://exemple.test'), null)
    assert.equal(safeRedirect('//exemple.test'), null)
    assert.equal(safeRedirect('/\\exemple.test'), null)
    assert.equal(safeRedirect('\\\\exemple.test'), null)
    assert.equal(safeRedirect('javascript:alert(1)'), null)
    assert.equal(safeRedirect('JavaScript:alert(1)'), null)
    assert.equal(safeRedirect(' //exemple.test'), null)
  })

  it('refuse un chemin que le navigateur réécrirait vers un autre site', () => {
    // `?redirect=/%09/exemple.test` : la tabulation décodée, retirée par le
    // navigateur, laisse `//exemple.test`.
    assert.equal(safeRedirect('/\t/exemple.test'), null)
    assert.equal(safeRedirect('/\n/exemple.test'), null)
    assert.equal(safeRedirect('/\r\n/exemple.test'), null)
    assert.equal(safeRedirect('/\t\\exemple.test'), null)
    assert.equal(safeRedirect('/\\\texemple.test'), null)
    // `..` résolu : `/..//exemple.test` devient `//exemple.test`.
    assert.equal(safeRedirect('/..//exemple.test'), null)
    assert.equal(safeRedirect('/%2e%2e//exemple.test'), null)
    assert.equal(safeRedirect('/.//exemple.test'), null)
  })

  it('laisse encodé ce qui l’était : il reste un chemin du site', () => {
    // Doublement encodé dans l'URL, `%09` n'est plus qu'un caractère du chemin.
    assert.equal(safeRedirect('/%09/exemple.test'), '/%09/exemple.test')
    assert.equal(safeRedirect('/%2F%2Fexemple.test'), '/%2F%2Fexemple.test')
    assert.equal(safeRedirect('/%5Cexemple.test'), '/%5Cexemple.test')
  })

  it('rend la forme résolue, celle qui a été vérifiée', () => {
    assert.equal(safeRedirect('/clients/../comptes'), '/comptes')
    assert.equal(safeRedirect('/réservations'), '/r%C3%A9servations')
  })

  it('rend null sans chemin', () => {
    assert.equal(safeRedirect(null), null)
    assert.equal(safeRedirect(undefined), null)
    assert.equal(safeRedirect(''), null)
    assert.equal(safeRedirect('reservations'), null)
  })
})
