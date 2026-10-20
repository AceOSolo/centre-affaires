import assert from 'node:assert/strict'
import { test } from 'node:test'

import { productOf, products } from './produits.ts'
import { resourceTypes } from './schema.ts'

test('chaque type de ressource appartient à un seul produit', () => {
  for (const type of resourceTypes) {
    const owners = products.filter((product) => (product.types as readonly string[]).includes(type))
    assert.equal(owners.length, 1, `${type} doit appartenir à exactement un produit`)
  }
})

test('les casiers sont rangés avec les bureaux, les boîtes aux lettres avec la domiciliation', () => {
  assert.equal(productOf('casier').key, 'bureaux')
  assert.equal(productOf('boite_aux_lettres').key, 'domiciliation')
  assert.equal(productOf('vehicule').label, 'Camion')
})
