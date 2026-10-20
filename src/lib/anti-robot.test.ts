import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { creerCompteur, ipDuVisiteur } from './anti-robot.ts'
import { CHAMP_PIEGE, champPiegeRempli } from './champs-anti-robot.ts'

const enTetes = (forwardedFor: string) => new Headers({ 'x-forwarded-for': forwardedFor })

describe('ipDuVisiteur', () => {
  it('lit l’adresse ajoutée par Apache', () => {
    assert.equal(ipDuVisiteur(enTetes('203.0.113.5')), '203.0.113.5')
  })

  it('ignore ce que le visiteur a mis à gauche', () => {
    assert.equal(ipDuVisiteur(enTetes('1.2.3.4, 203.0.113.5')), '203.0.113.5')
    assert.equal(ipDuVisiteur(enTetes('9.9.9.9, 1.2.3.4, 203.0.113.5')), '203.0.113.5')
  })

  it('ramène une adresse IPv6 à son réseau /64', () => {
    assert.equal(ipDuVisiteur(enTetes('2001:db8:1:2::abcd')), ipDuVisiteur(enTetes('2001:db8:1:2::1')))
    assert.notEqual(ipDuVisiteur(enTetes('2001:db8:1:2::1')), ipDuVisiteur(enTetes('2001:db8:1:3::1')))
  })
})

describe('creerCompteur', () => {
  const PLAFOND = { fenetreSecondes: 60, max: 2 }
  const T0 = 1_000_000

  it('laisse passer jusqu’au plafond, puis refuse', () => {
    const compteur = creerCompteur()
    assert.equal(compteur.passer([['a', PLAFOND]], T0), null)
    assert.equal(compteur.passer([['a', PLAFOND]], T0 + 1), null)
    assert.equal(compteur.passer([['a', PLAFOND]], T0 + 2), 'a')
  })

  it('rouvre une fois la fenêtre écoulée', () => {
    const compteur = creerCompteur()
    compteur.passer([['a', PLAFOND]], T0)
    compteur.passer([['a', PLAFOND]], T0 + 1)
    assert.equal(compteur.passer([['a', PLAFOND]], T0 + 60_001), null)
  })

  it('compte chaque clé à part', () => {
    const compteur = creerCompteur()
    compteur.passer([['a', PLAFOND]], T0)
    compteur.passer([['a', PLAFOND]], T0)
    assert.equal(compteur.passer([['b', PLAFOND]], T0), null)
  })

  it('ne compte rien quand une des clés est au plafond', () => {
    const compteur = creerCompteur()
    const site = { fenetreSecondes: 60, max: 1 }
    assert.equal(compteur.passer([['ip', PLAFOND], ['site', site]], T0), null)
    assert.equal(compteur.passer([['ip', PLAFOND], ['site', site]], T0), 'site')
    // Le refus du site n'a pas entamé le plafond de l'adresse.
    assert.equal(compteur.passer([['ip', PLAFOND]], T0), null)
  })
})

describe('champPiegeRempli', () => {
  it('repère le champ piège rempli, et lui seul', () => {
    const formulaire = new FormData()
    formulaire.set('email', 'camille@exemple.fr')
    formulaire.set(CHAMP_PIEGE, '')
    assert.equal(champPiegeRempli(formulaire), false)
    formulaire.set(CHAMP_PIEGE, 'http://spam.test')
    assert.equal(champPiegeRempli(formulaire), true)
  })
})
