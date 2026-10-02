import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EU_STORAGE_REGIONS,
  StorageRegionError,
  assertEuropeanRegion,
  deleteObject,
  putObject,
  readObjectBytes,
} from './stockage.ts'

/**
 * Contrôle de la région du stockage (R33) : les documents du centre ne
 * quittent pas l'Union européenne, même sur une variable mal recopiée.
 */
describe('région du stockage', () => {
  it('accepte la région de Neon et les autres régions de l’Union', () => {
    assert.equal(assertEuropeanRegion('eu-central-1'), 'eu-central-1')
    assert.equal(assertEuropeanRegion(' eu-west-3 '), 'eu-west-3')
    for (const region of Object.keys(EU_STORAGE_REGIONS)) {
      assert.equal(assertEuropeanRegion(region), region)
    }
  })

  it('refuse une région hors d’Europe, en la nommant', () => {
    for (const region of ['us-east-1', 'us-west-2', 'ap-southeast-1', 'auto']) {
      assert.throws(
        () => assertEuropeanRegion(region),
        (error: unknown) => {
          assert.ok(error instanceof StorageRegionError)
          assert.match(error.message, new RegExp(`« ${region} »`))
          assert.match(error.message, /Union européenne/)
          return true
        },
      )
    }
  })

  it('refuse Londres et Zurich, européennes mais hors de l’Union', () => {
    assert.throws(() => assertEuropeanRegion('eu-west-2'), StorageRegionError)
    assert.throws(() => assertEuropeanRegion('eu-central-2'), StorageRegionError)
  })

  it('refuse une région absente plutôt que de laisser le SDK choisir', () => {
    assert.throws(() => assertEuropeanRegion(undefined), /AWS_REGION manquant/)
    assert.throws(() => assertEuropeanRegion('  '), /AWS_REGION manquant/)
  })

  it('ne confond pas une région avec une propriété héritée', () => {
    assert.throws(() => assertEuropeanRegion('toString'), StorageRegionError)
  })

  it('refuse de déposer, lire ou effacer quoi que ce soit hors de l’Union', async () => {
    // Le point d'accès ne mène nulle part : l'erreur doit tomber avant toute
    // connexion, au moment de créer le client.
    const saved = { endpoint: process.env.AWS_ENDPOINT_URL_S3, region: process.env.AWS_REGION }
    process.env.AWS_ENDPOINT_URL_S3 = 'http://127.0.0.1:9'
    process.env.AWS_REGION = 'us-east-1'
    try {
      await assert.rejects(
        putObject('courrier/test.pdf', new Uint8Array([1]), 'application/pdf'),
        StorageRegionError,
      )
      await assert.rejects(readObjectBytes('courrier/test.pdf'), StorageRegionError)
      await assert.rejects(deleteObject('courrier/test.pdf'), StorageRegionError)
    } finally {
      for (const [name, value] of [
        ['AWS_ENDPOINT_URL_S3', saved.endpoint],
        ['AWS_REGION', saved.region],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
