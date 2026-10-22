import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { detectScanType } from './fichiers.ts'
import { countPdfPages } from './pages.ts'
import { photosToPdf, readJpegInfo } from './photos-pdf.ts'

/**
 * Une photo JPEG réduite à son en-tête — début, JFIF, EXIF facultatif, SOF,
 * fin — : le PDF recopie les octets sans les décoder, l'en-tête suffit.
 */
function photo({
  width = 1200,
  height = 1600,
  components = 3,
  orientation,
  bigEndian = false,
  sof = 0xc0,
}: {
  width?: number
  height?: number
  components?: number
  orientation?: number
  bigEndian?: boolean
  sof?: number
} = {}): Uint8Array {
  const u16 = (value: number) => (bigEndian ? [value >> 8, value & 0xff] : [value & 0xff, value >> 8])
  const u32 = (value: number) => (bigEndian ? [0, 0, ...u16(value)] : [...u16(value), 0, 0])
  const segment = (marker: number, data: number[]) => [0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff, ...data]
  const bytes = [0xff, 0xd8]
  bytes.push(...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]))
  if (orientation !== undefined) {
    // « Exif\0\0 », en-tête TIFF, un répertoire d'une entrée : l'orientation (SHORT).
    const tiff = [
      ...(bigEndian ? [0x4d, 0x4d] : [0x49, 0x49]),
      ...u16(42),
      ...u32(8),
      ...u16(1),
      ...u16(0x0112),
      ...u16(3),
      ...u32(1),
      ...u16(orientation),
      0,
      0,
      ...u32(0),
    ]
    bytes.push(...segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]))
  }
  bytes.push(
    ...segment(sof, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, components, ...Array(components * 3).fill(0)]),
  )
  bytes.push(0xff, 0xd9)
  return new Uint8Array(bytes)
}

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1')

describe('photos du courrier réunies en PDF', () => {
  it('lit les dimensions et les couleurs dans l’en-tête de la photo', () => {
    assert.deepEqual(readJpegInfo(photo()), { width: 1200, height: 1600, components: 3, rotation: 0 })
    assert.deepEqual(readJpegInfo(photo({ width: 800, height: 600, components: 1 })), {
      width: 800,
      height: 600,
      components: 1,
      rotation: 0,
    })
    // JPEG progressif : lu par les lecteurs de PDF.
    assert.equal(readJpegInfo(photo({ sof: 0xc2 }))?.width, 1200)
  })

  it('suit l’orientation EXIF de l’appareil, dans les deux ordres d’octets', () => {
    assert.equal(readJpegInfo(photo({ orientation: 6 }))?.rotation, 90)
    assert.equal(readJpegInfo(photo({ orientation: 8, bigEndian: true }))?.rotation, 270)
    assert.equal(readJpegInfo(photo({ orientation: 3 }))?.rotation, 180)
    assert.equal(readJpegInfo(photo({ orientation: 1 }))?.rotation, 0)
  })

  it('refuse ce qui n’est pas une photo JPEG lisible dans un PDF', () => {
    assert.equal(readJpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), undefined)
    // Codage arithmétique, quadrichromie : pas lus partout.
    assert.equal(readJpegInfo(photo({ sof: 0xc9 })), undefined)
    assert.equal(readJpegInfo(photo({ components: 4 })), undefined)
    // En-tête tronqué avant les dimensions.
    assert.equal(readJpegInfo(photo().subarray(0, 24)), undefined)
  })

  it('fait un PDF d’une page par photo, dans l’ordre, que le compteur de pages lit', () => {
    const pdf = photosToPdf([photo(), photo({ width: 1600, height: 1200 }), photo({ components: 1 })])
    assert.ok(pdf)
    assert.equal(detectScanType(pdf), 'application/pdf')
    assert.equal(countPdfPages(pdf), 3)
    const text = latin1(pdf)
    // Grand côté d'une page A4, portrait puis paysage.
    assert.deepEqual(
      [...text.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((match) => [match[1], match[2]]),
      [
        ['631.5', '842'],
        ['842', '631.5'],
        ['631.5', '842'],
      ],
    )
    assert.match(text, /\/ColorSpace \/DeviceGray/)
    assert.equal([...text.matchAll(/\/Filter \/DCTDecode/g)].length, 3)
  })

  it('redresse à l’affichage une photo prise téléphone tourné', () => {
    const text = latin1(photosToPdf([photo({ orientation: 6 }), photo()]) as Uint8Array)
    assert.equal([...text.matchAll(/\/Rotate 90/g)].length, 1)
  })

  it('tient une table des références exacte, pour les lecteurs stricts', () => {
    const pdf = photosToPdf([photo(), photo()]) as Uint8Array
    const text = latin1(pdf)
    const startxref = Number(text.match(/startxref\n(\d+)\n%%EOF\n$/)?.[1])
    assert.equal(text.slice(startxref, startxref + 5), 'xref\n')
    const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n \n/gm)].map((match) => Number(match[1]))
    // Catalogue, arbre des pages, puis trois objets par photo.
    assert.equal(entries.length, 2 + 2 * 3)
    entries.forEach((offset, index) => {
      assert.equal(text.slice(offset, offset + `${index + 1} 0 obj`.length), `${index + 1} 0 obj`)
    })
    assert.match(text, /trailer\n<< \/Size 9 \/Root 1 0 R >>/)
  })

  it('ne fait rien d’une liste vide ou d’un fichier qui n’est pas une photo', () => {
    assert.equal(photosToPdf([]), undefined)
    assert.equal(photosToPdf([photo(), new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])]), undefined)
  })
})
