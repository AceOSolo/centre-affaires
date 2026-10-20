import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { clientSections, isActiveSection } from './espace-rubriques.ts'

const nothing = { domiciliated: false, invoices: 0, contracts: 0, inspections: 0 }
const labels = (signals: typeof nothing) => clientSections(signals).map((section) => section.label)

describe('rubriques de l’espace client', () => {
  it('un nouveau client ne voit que l’accueil et ses réservations', () => {
    assert.deepEqual(labels(nothing), ['Accueil', 'Réservations'])
  })

  it('le courrier apparaît pour une entreprise domiciliée', () => {
    assert.deepEqual(labels({ ...nothing, domiciliated: true }), ['Accueil', 'Réservations', 'Courrier'])
  })

  it('chaque rubrique apparaît dès qu’elle a un document à montrer, dans l’ordre d’usage', () => {
    assert.deepEqual(labels({ domiciliated: true, invoices: 3, contracts: 1, inspections: 2 }), [
      'Accueil',
      'Réservations',
      'Courrier',
      'Factures',
      'Contrats',
      'États des lieux',
    ])
  })

  it('une facture sans contrat montre les factures seules', () => {
    assert.deepEqual(labels({ ...nothing, invoices: 1 }), ['Accueil', 'Réservations', 'Factures'])
  })
})

describe('rubrique active', () => {
  it('l’accueil ne s’allume pas sur les autres pages de l’espace', () => {
    assert.equal(isActiveSection('/compte', '/compte'), true)
    assert.equal(isActiveSection('/compte', '/compte/courrier'), false)
  })

  it('une rubrique s’allume sur ses sous-pages', () => {
    assert.equal(isActiveSection('/compte/courrier', '/compte/courrier/abc'), true)
    assert.equal(isActiveSection('/compte/reservations', '/compte/reservations/nouvelle'), true)
    assert.equal(isActiveSection('/compte/courrier', '/compte/contrats'), false)
  })
})
