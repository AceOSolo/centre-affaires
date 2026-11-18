import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Barre d'onglets de l'espace client sans barre de défilement parasite
 * (ADR 077, recette du 17/11) : les onglets chevauchaient d'un pixel la
 * bordure du bas (`-mb-px`) dans une barre qui défile (`overflow-x-auto`) ;
 * ce pixel faisait apparaître une petite barre de défilement en face des
 * onglets. Éprouvé sur la source : sans navigateur, ce sont les classes qui
 * disent le défaut.
 */
const source = readFileSync(join(import.meta.dirname, 'compte-nav.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('onglets de l’espace client', () => {
  it('garde le défilement horizontal, sans jamais déborder en hauteur', () => {
    assert.match(source, /sm:overflow-x-auto/)
    assert.match(source, /sm:overflow-y-hidden/)
  })

  it('ne fait plus déborder les onglets sous la barre', () => {
    assert.doesNotMatch(source, /-mb-px/)
    assert.doesNotMatch(source, /sm:border-b sm:border-border/)
  })
})
