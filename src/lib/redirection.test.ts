import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { clientReturnPath, safeRedirect, withReturn } from './redirection.ts'

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

describe('clientReturnPath', () => {
  it('garde un chemin de l’espace client, filtres compris', () => {
    assert.equal(clientReturnPath('/compte/courrier?categorie=impots&page=2', '/x'), '/compte/courrier?categorie=impots&page=2')
    assert.equal(clientReturnPath('/compte', '/x'), '/compte')
    assert.equal(clientReturnPath('/compte/mon-compte', '/x'), '/compte/mon-compte')
  })

  it('rend la valeur par défaut hors de l’espace client ou hors du site', () => {
    assert.equal(clientReturnPath('/reservations', '/compte/courrier'), '/compte/courrier')
    assert.equal(clientReturnPath('/comptes', '/compte/courrier'), '/compte/courrier')
    assert.equal(clientReturnPath('//exemple.test/compte', '/compte/courrier'), '/compte/courrier')
    assert.equal(clientReturnPath('https://exemple.test/compte', '/compte/courrier'), '/compte/courrier')
    assert.equal(clientReturnPath('/compte/../admin', '/compte/courrier'), '/compte/courrier')
    assert.equal(clientReturnPath(undefined, '/compte/courrier'), '/compte/courrier')
    assert.equal(clientReturnPath(['/compte'], '/compte/courrier'), '/compte/courrier')
  })
})

describe('withReturn', () => {
  it('ajoute le retour, encodé, avant l’ancre', () => {
    assert.equal(
      withReturn('/compte/courrier/abc', '/compte/courrier?page=2'),
      '/compte/courrier/abc?retour=%2Fcompte%2Fcourrier%3Fpage%3D2',
    )
    assert.equal(
      withReturn('/compte/courrier/abc?demande=envoi#reexpedition', '/compte/courrier?type=lettre'),
      '/compte/courrier/abc?demande=envoi&retour=%2Fcompte%2Fcourrier%3Ftype%3Dlettre#reexpedition',
    )
  })

  it('laisse le lien tel quel sans retour valable', () => {
    assert.equal(withReturn('/compte/courrier/abc', null), '/compte/courrier/abc')
    assert.equal(withReturn('/compte/courrier/abc', 'https://exemple.test'), '/compte/courrier/abc')
  })
})
