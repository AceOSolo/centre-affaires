import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { returnLink } from './retour.ts'

const boite = { href: '/compte/courrier', label: 'Ma boîte aux lettres' }

describe('returnLink', () => {
  it('ramène à la liste d’où l’on vient, filtres et page compris', () => {
    assert.deepEqual(returnLink('/compte/courrier?categorie=impots&page=2', boite), {
      href: '/compte/courrier?categorie=impots&page=2',
      label: 'Ma boîte aux lettres',
    })
    assert.deepEqual(returnLink('/compte/mon-compte', boite), { href: '/compte/mon-compte', label: 'Mon compte' })
    assert.deepEqual(returnLink(['/compte/courrier/demandes?statut=en-cours'], boite), {
      href: '/compte/courrier/demandes?statut=en-cours',
      label: 'Mes demandes',
    })
    assert.equal(returnLink('/compte/courrier/0190a0b2-0000-7000-8000-000000000000', boite).label, 'Le courrier')
  })

  it('revient au lien par défaut sans retour sûr dans l’espace client', () => {
    assert.deepEqual(returnLink(undefined, boite), boite)
    assert.deepEqual(returnLink('https://exemple.test/compte', boite), boite)
    assert.deepEqual(returnLink('/reservations', boite), boite)
    assert.deepEqual(returnLink('//exemple.test', boite), boite)
  })
})
