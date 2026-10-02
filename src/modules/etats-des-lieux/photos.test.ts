import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PHOTO_OUTPUT_TYPE, PHOTO_QUALITY, targetSize } from './compression.ts'
import { detectImage, PHOTO_MAX_BYTES, readPhoto } from './photos.ts'
import { INSPECTION_PHOTO_MAX_BYTES, inspectionPhotoContentTypes } from './schema.ts'

/**
 * Photos d'états des lieux (R33, ADR 039) : réduites dans le navigateur, puis
 * vérifiées par le serveur — type et dimensions lus dans les octets, taille
 * bornée.
 */

/** En-tête JPEG minimal : SOI, un APP0, puis un SOF0 de `largeur` × `hauteur`. */
function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ])
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

function riff(chunk: string, payload: number[]): Uint8Array {
  const bytes = new Uint8Array(20 + payload.length)
  bytes.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0)
  bytes.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8)
  bytes.set([...chunk].map((c) => c.charCodeAt(0)), 12)
  bytes.set(payload, 20)
  return bytes
}

const asFile = (bytes: Uint8Array, type = 'image/jpeg') => new File([new Uint8Array(bytes)], 'photo', { type })

describe('photos reçues', () => {
  it('lisent le type et les dimensions dans les octets', () => {
    assert.deepEqual(detectImage(jpeg(1920, 1440)), { contentType: 'image/jpeg', width: 1920, height: 1440 })
    assert.deepEqual(detectImage(png(800, 600)), { contentType: 'image/png', width: 800, height: 600 })
    // WebP avec en-tête étendu : largeur − 1 et hauteur − 1 sur 24 bits.
    const vp8x = riff('VP8X', [0x0a, 0, 0, 0, 0x7f, 0x07, 0x00, 0x37, 0x04, 0x00])
    assert.deepEqual(detectImage(vp8x), { contentType: 'image/webp', width: 1920, height: 1080 })
    // WebP avec perte : code de départ, puis 14 bits par dimension.
    const vp8 = riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01])
    assert.deepEqual(detectImage(vp8), { contentType: 'image/webp', width: 640, height: 480 })
    // WebP sans perte : signature 0x2f, puis largeur − 1 et hauteur − 1 sur 14 bits.
    const bits = (100 - 1) | ((50 - 1) << 14)
    const vp8l = riff('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0, 0, 0, 0])
    assert.deepEqual(detectImage(vp8l), { contentType: 'image/webp', width: 100, height: 50 })
  })

  it('refusent ce qui n’est pas une image acceptée, quoi qu’en dise le navigateur', () => {
    assert.equal(detectImage(new TextEncoder().encode('<html><script>alert(1)</script>')), undefined)
    assert.equal(detectImage(new TextEncoder().encode('%PDF-1.7')), undefined)
    assert.equal(detectImage(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), undefined)
  })

  it('bornent la taille à celle que la base accepte', async () => {
    assert.equal(PHOTO_MAX_BYTES, INSPECTION_PHOTO_MAX_BYTES)
    assert.deepEqual(await readPhoto(null), { error: 'Aucune photo reçue.' })
    assert.deepEqual(await readPhoto(asFile(new Uint8Array(0))), { error: 'Aucune photo reçue.' })
    const lourde = new Uint8Array(PHOTO_MAX_BYTES + 1)
    lourde.set(jpeg(100, 100))
    assert.match((await readPhoto(asFile(lourde))).error ?? '', /dépasse 10 Mo/)
    assert.match(
      (await readPhoto(asFile(new TextEncoder().encode('<svg/>'), 'image/jpeg'))).error ?? '',
      /JPEG, WebP et PNG/,
    )
    assert.match((await readPhoto(asFile(png(12_000, 10)))).error ?? '', /10 000 pixels/)
    const { photo } = await readPhoto(asFile(jpeg(1600, 1200), 'application/octet-stream'))
    assert.equal(photo?.contentType, 'image/jpeg')
    assert.equal(photo?.width, 1600)
  })
})

describe('compression dans le navigateur', () => {
  it('ramène le plus grand côté à 1 920 px, sans jamais agrandir', () => {
    assert.deepEqual(targetSize(4032, 3024), { width: 1920, height: 1440 })
    assert.deepEqual(targetSize(3024, 4032), { width: 1440, height: 1920 })
    assert.deepEqual(targetSize(800, 600), { width: 800, height: 600 })
    assert.deepEqual(targetSize(10_000, 3), { width: 1920, height: 1 })
    assert.throws(() => targetSize(0, 10))
  })

  it('produit un type que le serveur accepte, à une qualité raisonnable', () => {
    assert.ok((inspectionPhotoContentTypes as readonly string[]).includes(PHOTO_OUTPUT_TYPE))
    assert.ok(PHOTO_QUALITY >= 0.6 && PHOTO_QUALITY <= 0.9)
  })
})
