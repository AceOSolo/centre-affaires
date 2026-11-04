import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { products } from '../../modules/ressources/produits.ts'
import { menuGroups } from './menu.ts'
import { groupKey, isFoldable, isGroupOpen, parseOpened, serializeOpened, toggleOpened } from './nav-plie.ts'

/** Rayons pliés du menu (ADR 064), pliés par défaut (ADR 067). */
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
    assert.deepEqual(parseOpened(undefined), [])
    assert.deepEqual(parseOpened(''), [])
    assert.deepEqual(parseOpened('salles.camion'), ['camion', 'salles'])
    assert.deepEqual(parseOpened('camion.camion..Salles.<script>.bureaux'), ['bureaux', 'camion'])
    const many = Array.from({ length: 50 }, (_, index) => `rayon-${index}`).join('.')
    assert.equal(parseOpened(many).length, 20)
  })

  it('écrit la même valeur pour le même ensemble, côté serveur comme côté navigateur', () => {
    assert.equal(serializeOpened(['salles', 'camion']), serializeOpened(['camion', 'salles', 'camion']))
    assert.equal(serializeOpened([]), '')
    assert.equal(serializeOpened(parseOpened('camion.salles')), 'camion.salles')
  })

  it('plie un rayon ouvert, déplie un rayon plié', () => {
    // Ouvert (`true`), un clic le retire du cookie ; plié, il l'y ajoute.
    assert.deepEqual(toggleOpened([], 'camion', false), ['camion'])
    assert.deepEqual(toggleOpened(['camion'], 'camion', false), ['camion'])
    assert.deepEqual(toggleOpened(['camion', 'salles'], 'camion', true), ['salles'])
    // Rayon de la page en cours, ouvert sans être dans le cookie : le plier n'y change rien.
    assert.deepEqual(toggleOpened(['salles'], 'camion', true), ['salles'])
  })

  describe('rayon ouvert ou plié', () => {
    const camion = { key: 'camion', foldable: true }

    it('plie tout par défaut, et ouvre ce que le navigateur a retenu', () => {
      assert.equal(isGroupOpen(camion, { opened: [] }), false)
      assert.equal(isGroupOpen(camion, { opened: ['camion'] }), true)
      assert.equal(isGroupOpen(camion, { opened: ['salles'] }), false)
    })

    it('plie chaque rayon du menu tant qu’on ne l’a pas ouvert', () => {
      for (const group of menuGroups.filter(isFoldable)) {
        assert.equal(isGroupOpen({ key: groupKey(group.label), foldable: true }, { opened: [] }), false, group.label)
      }
    })

    it('ouvre toujours le rayon de la page en cours', () => {
      assert.equal(isGroupOpen(camion, { opened: [], active: 'camion' }), true)
      assert.equal(isGroupOpen(camion, { opened: [], active: 'salles' }), false)
    })

    it('laisse plier à la main le rayon de la page en cours, jusqu’à la page suivante', () => {
      assert.equal(isGroupOpen(camion, { opened: [], active: 'camion', dismissed: 'camion' }), false)
      assert.equal(isGroupOpen(camion, { opened: ['camion'], active: 'camion', dismissed: 'camion' }), true)
    })

    it('ne plie jamais un groupe sans titre', () => {
      assert.equal(isGroupOpen({ key: 'aujourd-hui', foldable: false }, { opened: [] }), true)
    })
  })
})
