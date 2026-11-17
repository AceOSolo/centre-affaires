import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MAX_PREVIEW_PAGES, pdfPageImages } from './apercu-pdf.ts'
import { photosToPdf } from './photos-pdf.ts'

/** Une photo JPEG minimale : en-tête, SOF0 (largeur, hauteur, 3 couleurs), fin. */
function jpeg(width: number, height: number, marker = 0): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    // Octets du « dessin » : différents d'une photo à l'autre, et un faux mot-clé.
    ...new TextEncoder().encode(` endobj 9 0 obj << >> stream ${marker} `),
    0xff, 0xd9,
  ])
}

/** Une photo dont l'EXIF dit « tournée de 90° » (orientation 6). */
function jpegTournee(): Uint8Array {
  const exif = [
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00,
  ]
  const base = jpeg(40, 30)
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, exif.length + 2, ...exif, ...base.subarray(2)])
}

describe('aperçu des pages d’un PDF de photos (ADR 079)', () => {
  it('rend la photo de chaque page, dans l’ordre, telle qu’elle a été déposée', () => {
    const photos = [jpeg(40, 30, 1), jpeg(30, 40, 2), jpeg(50, 50, 3)]
    const pages = pdfPageImages(photosToPdf(photos) as Uint8Array)
    assert.ok(pages)
    assert.equal(pages.length, 3)
    pages.forEach((page, index) => {
      assert.deepEqual([...page.jpeg], [...photos[index]])
      assert.equal(page.rotation, 0)
    })
  })

  it('garde la rotation de la page', () => {
    const pages = pdfPageImages(photosToPdf([jpeg(40, 30), jpegTournee()]) as Uint8Array)
    assert.deepEqual(pages?.map((page) => page.rotation), [0, 90])
  })

  it('se rabat sur le PDF quand ce n’est pas un PDF de photos', () => {
    const texte = new TextEncoder().encode(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 5 /Filter /FlateDecode >>\nstream\nxxxxx\nendstream\nendobj\n%%EOF\n',
    )
    assert.equal(pdfPageImages(texte), undefined)
    // Une image compressée autrement qu'en JPEG.
    const autre = new TextEncoder().encode(
      '%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n2 0 obj\n<< /Subtype /Image /Filter /FlateDecode /Length 3 >>\nstream\nabc\nendstream\nendobj\n',
    )
    assert.equal(pdfPageImages(autre), undefined)
    // Pas un PDF du tout.
    assert.equal(pdfPageImages(jpeg(10, 10)), undefined)
  })

  it('refuse un flux tronqué', () => {
    const pdf = photosToPdf([jpeg(40, 30)]) as Uint8Array
    assert.equal(pdfPageImages(pdf.subarray(0, pdf.length - 300)), undefined)
  })

  it('n’ouvre pas page par page un document trop long', () => {
    const photos = Array.from({ length: MAX_PREVIEW_PAGES + 1 }, (_, index) => jpeg(20, 20, index))
    assert.equal(pdfPageImages(photosToPdf(photos) as Uint8Array), undefined)
  })
})
