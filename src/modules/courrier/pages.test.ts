import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { deflateSync } from 'node:zlib'

import { countPdfPages, countScanPages, readPageCount } from './pages.ts'
import { billablePages } from './regles.ts'

const latin1 = (text: string) => new Uint8Array(Buffer.from(text, 'latin1'))

/** PDF minimal en clair : un catalogue, un arbre de pages, `count` pages. */
function simplePdf(count: number): string {
  const kids = Array.from({ length: count }, (_, index) => `${index + 3} 0 R`).join(' ')
  const pages = Array.from(
    { length: count },
    (_, index) => `${index + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n`,
  ).join('')
  return (
    '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${count} >>\nendobj\n` +
    pages +
    `trailer\n<< /Size ${count + 3} /Root 1 0 R >>\n%%EOF\n`
  )
}

/**
 * PDF 1.5 : catalogue et arbre de pages rangés dans un flux d'objets
 * compressé, comme le produisent la plupart des scanners récents. Aucun
 * `/Type /Pages` n'est lisible en clair.
 */
function compressedPdf(count: number): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [] /Count ${count} >>`,
  ]
  let offset = 0
  const header: string[] = []
  objects.forEach((object, index) => {
    header.push(`${index + 1} ${offset}`)
    offset += object.length + 1
  })
  const headerText = header.join(' ') + '\n'
  const content = Buffer.from(headerText + objects.join('\n') + '\n', 'latin1')
  const packed = deflateSync(content)
  const head = Buffer.from(
    '%PDF-1.5\n' +
      `5 0 obj\n<< /Type /ObjStm /N ${objects.length} /First ${headerText.length} /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`,
    'latin1',
  )
  const tail = Buffer.from(
    '\nendstream\nendobj\n' +
      '6 0 obj\n<< /Type /XRef /Root 1 0 R /Size 7 /W [1 2 1] /Length 0 >>\nstream\n\nendstream\nendobj\n' +
      'startxref\n0\n%%EOF\n',
    'latin1',
  )
  return new Uint8Array(Buffer.concat([head, packed, tail]))
}

describe('pages d’un contenu numérisé', () => {
  it('compte une image pour une page', () => {
    assert.equal(countScanPages(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg'), 1)
    assert.equal(countScanPages(new Uint8Array([0x89, 0x50]), 'image/png'), 1)
  })

  it('lit le total de l’arbre des pages d’un PDF en clair', () => {
    assert.equal(countPdfPages(latin1(simplePdf(1))), 1)
    assert.equal(countPdfPages(latin1(simplePdf(7))), 7)
    assert.equal(countScanPages(latin1(simplePdf(3)), 'application/pdf'), 3)
  })

  it('décompresse les flux d’objets d’un PDF 1.5', () => {
    assert.equal(countPdfPages(compressedPdf(12)), 12)
  })

  it('retient l’arbre de la dernière mise à jour, pas l’ancien', () => {
    // Mise à jour incrémentale : l'objet 2 redéfini à la fin, deux pages retirées.
    const updated =
      simplePdf(5) +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>\nendobj\n' +
      'trailer\n<< /Size 8 /Root 1 0 R /Prev 0 >>\n%%EOF\n'
    assert.equal(countPdfPages(latin1(updated)), 3)
  })

  it('se rabat sur les pages elles-mêmes quand la remorque manque', () => {
    const withoutTrailer = simplePdf(4).replace(/trailer[\s\S]*$/, '').replace(/\/Count 4/, '')
    assert.equal(countPdfPages(latin1(withoutTrailer)), 4)
  })

  it('n’invente rien d’un fichier illisible', () => {
    assert.equal(countPdfPages(latin1('%PDF-1.7\nchiffré, rien de lisible')), undefined)
  })
})

describe('saisie du nombre de pages', () => {
  it('prend la lecture du fichier sans saisie', () => {
    assert.deepEqual(readPageCount('', 6), { pages: 6 })
  })

  it('préfère la saisie de l’accueil à la lecture', () => {
    // Deux pages blanches retirées du compte par l'accueil.
    assert.deepEqual(readPageCount('4', 6), { pages: 4 })
  })

  it('demande la saisie quand le fichier ne se lit pas', () => {
    assert.match(readPageCount('', undefined).error ?? '', /indiquez-le/)
  })

  it('refuse une saisie qui n’est pas un nombre entier de pages', () => {
    for (const saisie of ['0', '-2', '2,5', 'deux', '1001']) {
      assert.match(readPageCount(saisie, 3).error ?? '', /de 1 à 1000/, saisie)
    }
  })
})

describe('pages facturées', () => {
  it('facture les pages au-delà de celles comprises dans l’ouverture', () => {
    assert.equal(billablePages(12, 5), 7)
    assert.equal(billablePages(5, 5), 0)
    assert.equal(billablePages(3, 5), 0)
  })

  it('facture toutes les pages quand aucune n’est comprise', () => {
    assert.equal(billablePages(4, 0), 4)
  })

  it('ne facture rien sans compte de pages', () => {
    // Contenu déposé avant le compteur : rien n'est inventé.
    assert.equal(billablePages(null, 0), 0)
  })
})
