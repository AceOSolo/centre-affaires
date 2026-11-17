import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { isPermission } from '../../lib/auth/permissions.ts'
import { productOf, products } from '../../modules/ressources/produits.ts'
import { resourceTypes, type ResourceType } from '../../modules/ressources/schema.ts'
import { inboxShelves } from './aujourdhui/journee.ts'
import { menuGroups } from './menu.ts'
import { activeEntry } from './nav-actif.ts'
import { reglagesLinks, reglagesOf, reglagesPermissions, reglagesSections } from './reglages/sections.ts'

/**
 * Le menu est rangé par service vendu (ADR 053) : un rayon par produit de
 * `produits.ts`, qui ne mène qu'à son produit, et ce qui sert à tous les
 * produits à part, sans filtre.
 */
/**
 * Une page existe pour cette adresse : chaque segment est un dossier, ou à
 * défaut le segment dynamique de son niveau (`[type]` pour
 * `/etats-des-lieux/modeles/bureau`).
 */
const pageExists = (href: string) => {
  let dir = import.meta.dirname
  for (const segment of href.split(/[?#]/)[0].split('/').filter(Boolean)) {
    if (existsSync(join(dir, segment))) {
      dir = join(dir, segment)
      continue
    }
    const dynamic = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).find((entry) => entry.isDirectory() && /^\[[^.\]]+\]$/.test(entry.name))
      : undefined
    if (!dynamic) return false
    dir = join(dir, dynamic.name)
  }
  return existsSync(join(dir, 'page.tsx'))
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
  // « Autres demandes » (ADR 070) : ce qui ne relève d'aucun produit.
  if (key === 'autres') return undefined
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

  it('ne filtre aucune entrée hors des rayons, sauf les « Autres demandes »', () => {
    const outside = menuGroups
      .filter((group) => !productLabels.includes(group.label))
      .flatMap((group) => group.entries.map((entry) => entry.href))
    assert.deepEqual(outside.filter((href) => href.includes('?') && href !== '/demandes?produit=autres'), [])
  })

  it('ouvre chaque rayon sur ses « Demandes », filtrées et comptées, sans « Demandes » générale (ADR 070)', () => {
    for (const product of products) {
      const [first] = menuGroups.find((group) => group.label === product.label)?.entries ?? []
      assert.deepEqual(
        [first?.label, first?.href, first?.counter],
        ['Demandes', `/demandes?produit=${product.key}`, product.key],
        product.label,
      )
    }
    const [autres] = menuGroups.find((group) => group.label === 'Tous les services')?.entries ?? []
    assert.deepEqual([autres?.label, autres?.href, autres?.counter], ['Autres demandes', '/demandes?produit=autres', 'autres'])
    // La page entière n'a pas d'entrée : la cloche y mène.
    assert.equal(entries.find((entry) => entry.href === '/demandes'), undefined)
    // Chaque rayon compté une fois : la somme des compteurs est le nombre de la cloche.
    const counted = entries.flatMap((entry) => (entry.counter ? [entry.counter] : []))
    assert.deepEqual([...counted].sort(), [...inboxShelves].sort())

    const at = (pathname: string, query = '') => {
      const href = activeEntry(addresses, pathname, new URLSearchParams(query))
      return menuGroups.find((group) => group.entries.some((entry) => [entry.href, ...(entry.also ?? [])].includes(href ?? '')))
        ?.label
    }
    assert.equal(at('/demandes', 'produit=salles'), 'Salles')
    assert.equal(at('/demandes', 'produit=autres'), 'Tous les services')
    // L'historique des demandes de courrier reste au rayon Domiciliation.
    assert.equal(at('/courrier/demandes', 'etat=toutes&nature=ouverture'), 'Domiciliation')
    assert.equal(at('/demandes'), undefined)
  })

  it('ne montre aucune adresse deux fois', () => {
    assert.equal(new Set(addresses).size, addresses.length)
  })

  it('reste court', () => {
    // 27 : le rayon Matériel (ADR 062) ajoute deux entrées, « Messages aux
    // domiciliés » une (ADR 060), et chaque rayon sa ligne « Demandes »
    // (ADR 070) — six, la « Demandes » générale en moins. 32 : chaque rayon
    // sa ligne « Réglages » (ADR 082), cinq. Les rayons sont pliés tant
    // qu'on ne les ouvre pas (ADR 067).
    assert.ok(entries.length <= 32, `${entries.length} entrées`)
  })

  it('range le matériel dans son rayon : demandes, planning, appareils et réglages (ADR 062, ADR 070, ADR 082)', () => {
    const materiel = menuGroups.find((group) => group.label === 'Matériel')
    assert.deepEqual(materiel?.entries.map((entry) => entry.href), [
      '/demandes?produit=materiel',
      '/reservations/semaine?type=materiel',
      '/ressources?type=materiel',
      '/reglages?produit=materiel',
    ])
  })

  it('finit chaque rayon sur ses « Réglages », ceux de son seul produit (ADR 082)', () => {
    for (const product of products) {
      const group = menuGroups.find((candidate) => candidate.label === product.label)
      const links = reglagesOf(product.key)
      const last = group?.entries.at(-1)
      if (links.length === 0) {
        // Un produit sans réglage n'a pas de ligne qui mènerait à une page vide.
        assert.notEqual(last?.label, 'Réglages', product.label)
        continue
      }
      assert.deepEqual([last?.label, last?.href], ['Réglages', `/reglages?produit=${product.key}`], product.label)
      // Allumée sur chacun de ses écrans, visible avec le droit de l'un d'eux.
      assert.deepEqual(last?.also, links.map((link) => link.href))
      assert.deepEqual([...new Set(links.map((link) => link.permission))].sort(), [last?.permission].flat().sort())
    }
    // Chaque réglage allume une seule entrée : celle de son rayon, ou « Réglages » en bas.
    const reglagesAddresses = reglagesLinks.map((link) => link.href)
    const lit = reglagesAddresses.map((href) => {
      const active = activeEntry(addresses, href, new URLSearchParams())
      return menuGroups.find((group) => group.entries.some((entry) => [entry.href, ...(entry.also ?? [])].includes(active ?? '')))?.label
    })
    assert.deepEqual(
      lit,
      reglagesLinks.map((link) =>
        link.service === 'tous' || link.service === 'centre'
          ? 'Réglages'
          : products.find((product) => product.key === link.service)?.label,
      ),
    )
    // La page filtrée allume le rayon, la page entière l'entrée du bas.
    assert.equal(activeEntry(addresses, '/reglages', new URLSearchParams('produit=bureaux')), '/reglages?produit=bureaux')
    assert.equal(activeEntry(addresses, '/reglages', new URLSearchParams()), '/reglages')
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
