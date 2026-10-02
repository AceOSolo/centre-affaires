import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { clientSearchTerms, escapeLike } from './recherche.ts'

describe('escapeLike', () => {
  it('neutralise les jokers de like', () => {
    assert.equal(escapeLike('100%'), '100\\%')
    assert.equal(escapeLike('a_b'), 'a\\_b')
    assert.equal(escapeLike('c:\\dossier'), 'c:\\\\dossier')
    assert.equal(escapeLike('Acme SAS'), 'Acme SAS')
  })
})

describe('clientSearchTerms', () => {
  it('ne cherche rien pour une saisie vide', () => {
    assert.equal(clientSearchTerms(undefined), null)
    assert.equal(clientSearchTerms(null), null)
    assert.equal(clientSearchTerms('   '), null)
  })

  it('cherche le texte saisi, espaces superflus retirés', () => {
    assert.deepEqual(clientSearchTerms('  Acme   SAS '), { pattern: '%Acme SAS%', siretPattern: null })
  })

  it('cherche un SIRET saisi par groupes sous sa forme rangée', () => {
    assert.deepEqual(clientSearchTerms('123 456 789'), {
      pattern: '%123 456 789%',
      siretPattern: '%123456789%',
    })
    assert.equal(clientSearchTerms('123.456.789.00012')?.siretPattern, '%12345678900012%')
  })

  it('ne cherche pas de SIRET dans un texte qui contient des lettres', () => {
    assert.equal(clientSearchTerms('Bureau 12')?.siretPattern, null)
  })

  it('échappe les jokers saisis', () => {
    assert.equal(clientSearchTerms('100%')?.pattern, '%100\\%%')
  })

  it('tronque une saisie démesurée', () => {
    assert.equal(clientSearchTerms('a'.repeat(500))?.pattern.length, 102)
  })
})
