import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { isPermission } from '../../lib/auth/permissions.ts'
import { menuGroups } from './menu.ts'
import { reglagesPermissions, reglagesSections } from './reglages/sections.ts'

/**
 * Le menu suit le parcours d'une demande (ADR 048) et ne répète aucun écran :
 * le produit se choisit dans la page, pas par un rayon qui redirait chaque
 * écran.
 */
const pageExists = (href: string) => {
  const path = href.split('?')[0]
  return existsSync(join(import.meta.dirname, ...path.split('/').filter(Boolean), 'page.tsx'))
}

const entries = menuGroups.flatMap((group) => group.entries)

describe('menu du back-office', () => {
  it('ouvre sur la journée, puis suit le parcours : ce qui arrive, commande, administratif, gestion, retour client, réglages', () => {
    assert.deepEqual(
      menuGroups.map((group) => group.label),
      ['Aujourd’hui', 'Ce qui arrive', 'Commande', 'Administratif', 'Gestion', 'Retour client', 'Réglages'],
    )
  })

  it('ne montre chaque écran qu’une fois, sans filtre de produit dans le menu', () => {
    const paths = entries.map((entry) => entry.href.split('?')[0])
    assert.equal(new Set(paths).size, paths.length)
    assert.ok(entries.every((entry) => !entry.href.includes('?')))
  })

  it('reste court', () => {
    assert.ok(entries.length <= 13, `${entries.length} entrées`)
  })

  it('mène à des pages qui existent, réglages compris', () => {
    const links = [...entries.map((entry) => entry.href), ...reglagesSections.flatMap((s) => s.links.map((l) => l.href))]
    assert.deepEqual(links.filter((href) => !pageExists(href)), [])
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
