import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { products } from '../../modules/ressources/produits.ts'
import { menuGroups } from './menu.ts'
import { groupKey, isFoldable, isGroupOpen, parseFolded, serializeFolded, toggleFolded } from './nav-plie.ts'

/** Rayons pliés du menu (ADR 064). */
describe('menu pliable', () => {
  it('plie chaque rayon, sans plier « Aujourd’hui » ni « Demandes »', () => {
    const foldable = menuGroups.filter(isFoldable).map((group) => group.label)
    // Tiré de `produits.ts` : un produit ajouté au menu se plie sans retouche ici.
    for (const product of products) assert.ok(foldable.includes(product.label), `${product.label} ne se plie pas`)
    assert.ok(foldable.includes('Tous les services'))

    const pinned = menuGroups.filter((group) => !isFoldable(group))
    const pinnedHrefs = pinned.flatMap((group) => group.entries.map((entry) => entry.href))
    assert.ok(pinnedHrefs.includes('/aujourdhui'))
    assert.ok(pinnedHrefs.includes('/demandes'))
    // « Réglages », seul lien de son groupe, ne serait pas plus court plié.
    assert.deepEqual(
      pinned.map((group) => group.label),
      ['Aujourd’hui', 'Réglages'],
    )
  })

  it('donne à chaque groupe une clé de cookie distincte, sans accents ni espaces', () => {
    const keys = menuGroups.map((group) => groupKey(group.label))
    assert.equal(new Set(keys).size, keys.length)
    assert.equal(groupKey('Tous les services'), 'tous-les-services')
    assert.equal(groupKey('Matériel'), 'materiel')
    assert.equal(groupKey('Aujourd’hui'), 'aujourd-hui')
    for (const key of keys) assert.match(key, /^[a-z0-9-]+$/)
  })

  it('lit le cookie sans faire confiance à son contenu', () => {
    assert.deepEqual(parseFolded(undefined), [])
    assert.deepEqual(parseFolded(''), [])
    assert.deepEqual(parseFolded('salles.camion'), ['camion', 'salles'])
    assert.deepEqual(parseFolded('camion.camion..Salles.<script>.bureaux'), ['bureaux', 'camion'])
    const many = Array.from({ length: 50 }, (_, index) => `rayon-${index}`).join('.')
    assert.equal(parseFolded(many).length, 20)
  })

  it('écrit la même valeur pour le même ensemble, côté serveur comme côté navigateur', () => {
    assert.equal(serializeFolded(['salles', 'camion']), serializeFolded(['camion', 'salles', 'camion']))
    assert.equal(serializeFolded([]), '')
    assert.equal(serializeFolded(parseFolded('camion.salles')), 'camion.salles')
  })

  it('plie un rayon ouvert, déplie un rayon plié', () => {
    assert.deepEqual(toggleFolded([], 'camion', true), ['camion'])
    assert.deepEqual(toggleFolded(['camion'], 'camion', true), ['camion'])
    assert.deepEqual(toggleFolded(['camion', 'salles'], 'camion', false), ['salles'])
  })

  describe('rayon ouvert ou plié', () => {
    const camion = { key: 'camion', foldable: true }

    it('ouvre tout par défaut, et plie ce que le navigateur a retenu', () => {
      assert.equal(isGroupOpen(camion, { folded: [] }), true)
      assert.equal(isGroupOpen(camion, { folded: ['camion'] }), false)
      assert.equal(isGroupOpen(camion, { folded: ['salles'] }), true)
    })

    it('ouvre toujours le rayon de la page en cours', () => {
      assert.equal(isGroupOpen(camion, { folded: ['camion'], active: 'camion' }), true)
      assert.equal(isGroupOpen(camion, { folded: ['camion'], active: 'salles' }), false)
    })

    it('laisse plier à la main le rayon de la page en cours, jusqu’à la page suivante', () => {
      assert.equal(isGroupOpen(camion, { folded: ['camion'], active: 'camion', dismissed: 'camion' }), false)
      // Déplié de nouveau : il n'est plus dans le cookie.
      assert.equal(isGroupOpen(camion, { folded: [], active: 'camion', dismissed: 'camion' }), true)
    })

    it('ne plie jamais un groupe sans titre', () => {
      assert.equal(isGroupOpen({ key: 'aujourd-hui', foldable: false }, { folded: ['aujourd-hui'] }), true)
    })
  })
})
