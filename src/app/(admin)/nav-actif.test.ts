import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { activeEntry } from './nav-actif.ts'

const hrefs = [
  '/reservations',
  '/reservations?type=salle',
  '/reservations/semaine?type=vehicule',
  '/demandes',
  '/demandes?produit=bureaux',
  '/ressources',
  '/ressources?type=salle',
  '/ressources/annonces',
]

const at = (url: string) => {
  const [pathname, query = ''] = url.split('?')
  return activeEntry(hrefs, pathname, new URLSearchParams(query))
}

describe('entrée active du menu', () => {
  it('retient le produit filtré plutôt que la liste complète', () => {
    assert.equal(at('/reservations?type=salle'), '/reservations?type=salle')
    assert.equal(at('/demandes?produit=bureaux'), '/demandes?produit=bureaux')
  })

  it('suit le produit dans les sous-vues et avec les autres paramètres', () => {
    assert.equal(at('/reservations/semaine?date=2026-10-20&type=salle'), '/reservations?type=salle')
    assert.equal(at('/reservations/semaine?type=vehicule&ressource=abc'), '/reservations/semaine?type=vehicule')
  })

  it('revient à l’entrée générale sans filtre, ou pour un produit absent du menu', () => {
    assert.equal(at('/reservations'), '/reservations')
    assert.equal(at('/reservations?type=casier'), '/reservations')
    assert.equal(at('/demandes?produit=inconnu'), '/demandes')
  })

  it('préfère le plus long chemin à paramètres égaux', () => {
    assert.equal(at('/ressources/annonces'), '/ressources/annonces')
    assert.equal(at('/ressources/0193'), '/ressources')
  })

  it('n’allume rien hors du menu', () => {
    assert.equal(at('/clients'), undefined)
  })
})
