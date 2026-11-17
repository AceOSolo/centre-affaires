import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isPermission } from '../../../lib/auth/permissions.ts'
import { productOf, products } from '../../../modules/ressources/produits.ts'
import { resourceTypes, type ResourceType } from '../../../modules/ressources/schema.ts'
import {
  permissionsOf,
  reglagesHref,
  reglagesLinks,
  reglagesOf,
  reglagesPermissions,
  reglagesSections,
  reglagesServices,
} from './sections.ts'

/** « Réglages » rangés par service vendu (ADR 082). */
describe('réglages par service', () => {
  it('suit les rayons du menu, puis « Tous les services » et « Le centre »', () => {
    assert.deepEqual(reglagesServices.map((service) => service.title), [
      ...products.map((product) => product.label),
      'Tous les services',
      'Le centre',
    ])
  })

  it('range chaque réglage sous un service connu, une fois', () => {
    const keys = reglagesServices.map((service) => service.key)
    assert.deepEqual(reglagesLinks.filter((link) => !keys.includes(link.service)), [])
    const hrefs = reglagesLinks.map((link) => link.href)
    assert.equal(new Set(hrefs).size, hrefs.length)
    // La page reprend chaque réglage, dans l'ordre des services.
    assert.deepEqual(
      reglagesSections.flatMap((section) => section.links),
      reglagesServices.flatMap((service) => reglagesOf(service.key)),
    )
    assert.ok(reglagesSections.every((section) => section.links.length > 0))
  })

  it('met le modèle d’état des lieux de chaque type sous son produit', () => {
    const templates = reglagesLinks.filter((link) => link.href.startsWith('/etats-des-lieux/modeles/'))
    assert.deepEqual(
      templates.map((link) => link.href.split('/').at(-1)).sort(),
      [...resourceTypes].sort(),
    )
    for (const link of templates) {
      const type = link.href.split('/').at(-1) as ResourceType
      assert.equal(link.service, productOf(type).key, link.href)
    }
  })

  it('garde ce qui sert à tous et ce qui règle le centre hors des produits', () => {
    assert.deepEqual(reglagesOf('tous').map((link) => link.href), ['/offres', '/services', '/tarifs', '/ressources/agendas', '/disponibilites#regles-reservation', '/notifications/cloche-client'])
    assert.deepEqual(reglagesOf('centre').map((link) => link.href), [
      '/disponibilites',
      '/indicateurs',
      '/equipe',
      '/configuration',
      '/configuration#identite-courriels',
      '/reglages/crm',
    ])
  })

  it('ne cite que des droits de la matrice, chacun une fois', () => {
    assert.deepEqual(reglagesPermissions.filter((permission) => !isPermission(permission)), [])
    assert.equal(new Set(reglagesPermissions).size, reglagesPermissions.length)
    assert.deepEqual(permissionsOf(reglagesOf('bureaux')), ['etats-des-lieux.modeles', 'formulaires.gerer'])
    assert.deepEqual(permissionsOf([]), [])
  })

  it('donne à chaque produit l’adresse de ses réglages', () => {
    assert.equal(reglagesHref('salles'), '/reglages?produit=salles')
  })
})
