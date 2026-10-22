import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { isPermission } from '../../lib/auth/permissions.ts'
import { productOf, products } from '../../modules/ressources/produits.ts'
import { resourceTypes, type ResourceType } from '../../modules/ressources/schema.ts'
import { menuGroups } from './menu.ts'
import { reglagesPermissions, reglagesSections } from './reglages/sections.ts'

/**
 * Le menu est rangé par service vendu (ADR 053) : un rayon par produit de
 * `produits.ts`, qui ne mène qu'à son produit, et ce qui sert à tous les
 * produits à part, sans filtre.
 */
const pageExists = (href: string) => {
  const path = href.split('?')[0]
  return existsSync(join(import.meta.dirname, ...path.split('/').filter(Boolean), 'page.tsx'))
}

const entries = menuGroups.flatMap((group) => group.entries)
const addresses = entries.flatMap((entry) => [entry.href, ...(entry.also ?? [])])
const productLabels: readonly string[] = products.map((product) => product.label)

/** Produit auquel une adresse filtrée se rapporte (`?type=` ou `?produit=`), s'il y en a un. */
function filteredProduct(href: string): string | undefined {
  const search = new URLSearchParams(href.split('?')[1] ?? '')
  const type = search.get('type')
  if (type) {
    assert.ok(resourceTypes.includes(type as ResourceType), `type inconnu : ${href}`)
    return productOf(type as ResourceType).label
  }
  const key = search.get('produit')
  if (key) {
    const product = products.find((candidate) => candidate.key === key)
    assert.ok(product, `produit inconnu : ${href}`)
    return product.label
  }
  return undefined
}

describe('menu du back-office', () => {
  it('ouvre sur la journée, puis un rayon par produit, ce qui sert à tous, les réglages', () => {
    assert.deepEqual(menuGroups.map((group) => group.label), [
      'Aujourd’hui',
      ...productLabels,
      'Tous les services',
      'Réglages',
    ])
  })

  it('ne mène, dans un rayon, qu’au produit de ce rayon', () => {
    for (const group of menuGroups.filter((candidate) => productLabels.includes(candidate.label))) {
      for (const entry of group.entries) {
        for (const href of [entry.href, ...(entry.also ?? [])]) {
          const product = filteredProduct(href)
          assert.ok(product === undefined || product === group.label, `${href} dans le rayon ${group.label}`)
        }
      }
    }
  })

  it('ne filtre aucune entrée hors des rayons', () => {
    const outside = menuGroups
      .filter((group) => !productLabels.includes(group.label))
      .flatMap((group) => group.entries.map((entry) => entry.href))
    assert.deepEqual(outside.filter((href) => href.includes('?')), [])
  })

  it('ne montre aucune adresse deux fois', () => {
    assert.equal(new Set(addresses).size, addresses.length)
  })

  it('reste court', () => {
    assert.ok(entries.length <= 20, `${entries.length} entrées`)
  })

  it('mène à des pages qui existent, réglages compris', () => {
    assert.deepEqual(addresses.filter((href) => !pageExists(href)), [])
  })

  it('ne réunit dans « Réglages » aucun écran déjà au menu', () => {
    const inMenu = new Set(entries.map((entry) => entry.href))
    const reglages = reglagesSections.flatMap((section) => section.links.map((link) => link.href))
    assert.deepEqual(reglages.filter((href) => inMenu.has(href)), [])
    assert.equal(new Set(reglages).size, reglages.length)
  })

  it('ne cite que des droits de la matrice', () => {
    const permissions = [
      ...entries.flatMap((entry) => (typeof entry.permission === 'string' ? [entry.permission] : entry.permission)),
      ...reglagesPermissions,
    ]
    assert.deepEqual(permissions.filter((permission) => !isPermission(permission)), [])
  })
})
