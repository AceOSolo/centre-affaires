import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { destinationSiConnecte, lienPourQui, ouvreLaPorte, suiteDeLaPorte } from './deja-connecte.ts'

const client = { equipe: false, client: true }
const equipe = { equipe: true, client: false }
const lesDeux = { equipe: true, client: true }
const rien = { equipe: false, client: false }

describe('pages de connexion, déjà connecté (ADR 077)', () => {
  it('renvoie un client vers son espace, l’équipe vers « Aujourd’hui »', () => {
    assert.equal(destinationSiConnecte('client', client), '/compte')
    assert.equal(destinationSiConnecte('equipe', equipe), '/aujourdhui')
  })

  it('ne mène jamais à l’espace de l’autre page (ADR 083)', () => {
    assert.equal(destinationSiConnecte('equipe', client), '/auth/acces-refuse')
    assert.equal(destinationSiConnecte('client', equipe), '/auth/acces-refuse')
    assert.equal(destinationSiConnecte('client', equipe, '/aujourdhui'), '/auth/acces-refuse')
  })

  it('choisit l’espace de la page pour qui est à la fois client et membre de l’équipe', () => {
    assert.equal(destinationSiConnecte('client', lesDeux), '/compte')
    assert.equal(destinationSiConnecte('equipe', lesDeux), '/aujourdhui')
  })

  it('suit le chemin demandé s’il est sûr et hors des pages de connexion', () => {
    assert.equal(destinationSiConnecte('client', client, '/compte/courrier?non-lus=1'), '/compte/courrier?non-lus=1')
    assert.equal(destinationSiConnecte('client', client, 'https://autre.exemple/compte'), '/compte')
    assert.equal(destinationSiConnecte('client', client, '//autre.exemple'), '/compte')
    assert.equal(destinationSiConnecte('client', client, '/auth/connexion'), '/compte')
    assert.equal(destinationSiConnecte('equipe', equipe, '/auth'), '/aujourdhui')
  })

  it('ne suit pas un chemin demandé hors de l’espace de la page', () => {
    assert.equal(destinationSiConnecte('client', lesDeux, '/aujourdhui'), '/compte')
    assert.equal(destinationSiConnecte('equipe', lesDeux, '/compte/courrier'), '/aujourdhui')
    assert.equal(destinationSiConnecte('equipe', lesDeux, '/clients/1'), '/clients/1')
  })

  it('dit « Accès refusé » à un compte qui n’ouvre rien, quel que soit le chemin demandé', () => {
    assert.equal(destinationSiConnecte('client', rien), '/auth/acces-refuse')
    assert.equal(destinationSiConnecte('equipe', rien, '/aujourdhui'), '/auth/acces-refuse')
  })
})

describe('chaque page de connexion n’ouvre que son espace (ADR 083)', () => {
  it('la page des clients ouvre un client, celle de l’équipe un membre', () => {
    assert.equal(ouvreLaPorte('client', client), true)
    assert.equal(ouvreLaPorte('client', equipe), false)
    assert.equal(ouvreLaPorte('equipe', equipe), true)
    assert.equal(ouvreLaPorte('equipe', client), false)
    assert.equal(ouvreLaPorte('client', lesDeux), true)
    assert.equal(ouvreLaPorte('equipe', lesDeux), true)
    assert.equal(ouvreLaPorte('client', rien), false)
  })

  it('après connexion, mène dans l’espace de la page seulement', () => {
    assert.equal(suiteDeLaPorte('client'), '/compte')
    assert.equal(suiteDeLaPorte('equipe'), '/aujourdhui')
    assert.equal(suiteDeLaPorte('client', '/compte/pieces'), '/compte/pieces')
    assert.equal(suiteDeLaPorte('client', '/compte?onglet=1'), '/compte?onglet=1')
    assert.equal(suiteDeLaPorte('client', '/comptes/12'), '/compte')
    assert.equal(suiteDeLaPorte('client', '/reglages'), '/compte')
    assert.equal(suiteDeLaPorte('equipe', '/comptes/12'), '/comptes/12')
    assert.equal(suiteDeLaPorte('equipe', '/compte'), '/aujourdhui')
    assert.equal(suiteDeLaPorte('equipe', '/auth/suite'), '/aujourdhui')
  })
})

describe('lien de mot de passe ouvert en étant connecté', () => {
  it('distingue son propre compte d’un autre, ou d’un lien inconnu', () => {
    assert.equal(lienPourQui(null, 'u1'), 'anonyme')
    assert.equal(lienPourQui({ id: 'u1' }, 'u1'), 'meme-compte')
    assert.equal(lienPourQui({ id: 'u1' }, 'u2'), 'autre-compte')
    assert.equal(lienPourQui({ id: 'u1' }, null), 'autre-compte')
  })
})

/** Le code sans ses commentaires : une garde citée en commentaire ne garde rien. */
const code = (file: string) =>
  readFileSync(join(import.meta.dirname, 'auth', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('pages qui renvoient, pages qui restent ouvertes', () => {
  it('renvoie depuis la connexion des clients, de l’équipe et le mot de passe oublié', () => {
    for (const page of ['connexion/page.tsx', 'equipe/page.tsx', 'mot-de-passe-oublie/page.tsx']) {
      assert.match(code(page), /\bredirigerSiConnecte\(/, page)
    }
  })

  it('laisse ouverts « Accès refusé », le choix du mot de passe et l’aiguillage', () => {
    for (const page of ['acces-refuse/page.tsx', 'nouveau-mot-de-passe/page.tsx', 'suite/page.tsx']) {
      assert.doesNotMatch(code(page), /\bredirigerSiConnecte\(/, page)
    }
  })
})
