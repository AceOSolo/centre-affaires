import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { adresseCourante, avecRetour, pasEnArriere, retourDe } from './retour.ts'

describe('revenir là où l’on était', () => {
  it('passe l’adresse de la liste, filtres compris, sans son propre retour', () => {
    assert.equal(adresseCourante('/demandes', { produit: 'salles', retour: '/aujourdhui' }), '/demandes?produit=salles')
    assert.equal(adresseCourante('/clients', new URLSearchParams('q=dupont&etat=actif')), '/clients?q=dupont&etat=actif')
    assert.equal(adresseCourante('/contrats', { statut: ['actif', 'brouillon'], vide: undefined }), '/contrats?statut=actif&statut=brouillon')
    assert.equal(adresseCourante('/devis'), '/devis')
  })

  it('ajoute le retour à l’adresse de la fiche, requête et ancre gardées', () => {
    assert.equal(avecRetour('/reservations/1', '/demandes?produit=salles'), '/reservations/1?retour=%2Fdemandes%3Fproduit%3Dsalles')
    assert.equal(avecRetour('/ressources/1?creee=1#medias', '/ressources?type=salle'), '/ressources/1?creee=1&retour=%2Fressources%3Ftype%3Dsalle#medias')
    assert.equal(avecRetour('/clients/1', undefined), '/clients/1')
  })

  it('ne suit qu’un retour sur le site, et qui mène ailleurs', () => {
    assert.equal(retourDe('?retour=%2Fdemandes%3Fproduit%3Dsalles', '/reservations/1'), '/demandes?produit=salles')
    assert.equal(retourDe('?retour=https%3A%2F%2Fexemple.test', '/reservations/1'), null)
    assert.equal(retourDe('?retour=%2F%2Fexemple.test', '/reservations/1'), null)
    assert.equal(retourDe('?retour=%2Freservations%2F1', '/reservations/1'), null)
    assert.equal(retourDe('', '/reservations/1'), null)
  })

  it('recule jusqu’à la page d’avant, sans la fiche rechargée ni le formulaire', () => {
    // Liste, fiche, « Modifier », fiche enregistrée : on revient à la liste.
    const entrees = ['/ressources?type=salle', '/ressources/1', '/ressources/1/modifier', '/ressources/1']
    assert.equal(pasEnArriere(entrees, 3, '/ressources/1'), 3)
    // Depuis « Aujourd’hui ».
    assert.equal(pasEnArriere(['/aujourdhui', '/reservations/2'], 1, '/reservations/2'), 1)
    // Création : on ne revient pas au formulaire.
    assert.equal(pasEnArriere(['/ressources', '/ressources/nouvelle', '/ressources/3'], 2, '/ressources/3'), 2)
  })

  it('ne recule pas à l’aveugle', () => {
    // Nouvel onglet, ou page d’avant le chargement : on ne la connaît pas.
    assert.equal(pasEnArriere(['/clients/1'], 0, '/clients/1'), undefined)
    assert.equal(pasEnArriere([undefined, '/clients/1'], 1, '/clients/1'), undefined)
    assert.equal(pasEnArriere(['/auth/connexion', '/clients/1'], 1, '/clients/1'), undefined)
  })
})
