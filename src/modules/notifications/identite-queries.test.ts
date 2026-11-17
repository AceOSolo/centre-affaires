import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { publicAddress, siteLogoSize, siteOrigins } from './identite-queries.ts'

/**
 * Adresse publique du logo et origine des boutons (ADR 080) : le logo n'est
 * servi qu'en HTTPS — sauf sur la machine elle-même, pour le capteur de
 * développement —, et ses dimensions se lisent dans le fichier du site.
 */
describe('adresse publique du logo', () => {
  it('sert le logo depuis l’adresse du site en https', () => {
    assert.equal(
      publicAddress('/handfield-logo.png', { APP_URL: 'https://www.handfield.fr' }),
      'https://www.handfield.fr/handfield-logo.png',
    )
  })

  it('accepte le clair sur la machine elle-même seulement', () => {
    assert.equal(publicAddress('/logo.png', { APP_URL: 'http://localhost:3000' }), 'http://localhost:3000/logo.png')
    assert.equal(publicAddress('/logo.png', { APP_URL: 'http://www.handfield.fr' }), null)
  })

  it('ne rend rien sans adresse, ou avec une adresse illisible', () => {
    assert.equal(publicAddress('/logo.png', {}), null)
    assert.equal(publicAddress('/logo.png', { APP_URL: 'pas une adresse' }), null)
  })

  it('fait des boutons des seuls liens du site', () => {
    assert.deepEqual(siteOrigins({ APP_URL: 'https://www.handfield.fr/' }), ['https://www.handfield.fr'])
    assert.deepEqual(siteOrigins({}), [])
  })
})

describe('dimensions du logo du site', () => {
  it('les lit dans le fichier de public/', async () => {
    assert.deepEqual(await siteLogoSize('/handfield-logo.png'), { width: 600, height: 191 })
  })

  it('ne lit rien hors de public/, ni un fichier absent', async () => {
    assert.equal(await siteLogoSize('/../package.json'), null)
    assert.equal(await siteLogoSize('/absent-du-site.png'), null)
    assert.equal(await siteLogoSize('https://cdn.exemple/logo.png'), null)
  })
})
