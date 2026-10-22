import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_SCAN_BYTES,
  MAX_SCAN_PHOTOS,
  MAX_SCAN_PHOTOS_BYTES,
  detectScanType,
  readScan,
  readScans,
} from './fichiers.ts'
import { countPdfPages, withPageCount } from './pages.ts'

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]
/** En-tête d'une photo JPEG de 1200 × 1600 : début, SOF0, fin. */
const PHOTO = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 8, 0x06, 0x40, 0x04, 0xb0, 3, ...Array(9).fill(0), 0xff, 0xd9]

const fichier = (bytes: number[], type = 'application/pdf', name = 'scan.pdf') =>
  new File([new Uint8Array(bytes)], name, { type })

describe('numérisations déposées', () => {
  it('reconnaît un PDF, un JPEG et un PNG à leurs premiers octets', () => {
    assert.equal(detectScanType(new Uint8Array(PDF)), 'application/pdf')
    assert.equal(detectScanType(new Uint8Array(JPEG)), 'image/jpeg')
    assert.equal(detectScanType(new Uint8Array(PNG)), 'image/png')
  })

  it('ignore le type déclaré par le navigateur', async () => {
    // Un HTML renommé en .pdf, déclaré PDF : servi tel quel au client, il
    // s'exécuterait sur notre domaine.
    const html = [...new TextEncoder().encode('<html><script>')]
    const { scan, error } = await readScan(fichier(html, 'application/pdf'))
    assert.equal(scan, undefined)
    assert.match(error ?? '', /PDF, JPEG et PNG/)
  })

  it('retient le type lu dans le fichier, pas celui annoncé', async () => {
    const { scan } = await readScan(fichier(PNG, 'application/pdf', 'scan.pdf'))
    assert.equal(scan?.contentType, 'image/png')
  })

  it('traite un champ laissé vide comme une absence de fichier', async () => {
    // Le navigateur envoie un fichier de zéro octet pour un champ vide.
    assert.deepEqual(await readScan(fichier([], 'application/octet-stream', '')), {})
    assert.deepEqual(await readScan(null), {})
    assert.deepEqual(await readScan('texte'), {})
  })

  it('refuse un fichier trop lourd', async () => {
    const lourd = new File([new Uint8Array(MAX_SCAN_BYTES + 1)], 'lourd.pdf')
    const { error } = await readScan(lourd)
    assert.match(error ?? '', /10 Mo/)
  })
})

describe('plusieurs photos d’une même étape (ADR 055)', () => {
  const jpeg = (name = 'page.jpg') => fichier(PHOTO, 'image/jpeg', name)

  it('garde tel quel un fichier seul, PDF ou image', async () => {
    assert.equal((await readScans([fichier(PDF)])).scan?.contentType, 'application/pdf')
    assert.equal((await readScans([fichier(PNG, 'image/png', 'scan.png')])).scan?.contentType, 'image/png')
    const seule = await readScans([jpeg()])
    assert.equal(seule.scan?.contentType, 'image/jpeg')
    assert.deepEqual([...(seule.scan?.bytes ?? [])], PHOTO)
  })

  it('ignore les champs vides, et ne rend rien sans fichier', async () => {
    assert.deepEqual(await readScans([]), {})
    assert.deepEqual(await readScans([fichier([], 'application/octet-stream', ''), 'texte']), {})
    assert.equal((await readScans([fichier([], 'application/octet-stream', ''), jpeg()])).scan?.contentType, 'image/jpeg')
  })

  it('réunit plusieurs photos en un PDF d’une page par photo, compté au dépôt', async () => {
    const { scan, error } = await readScans([jpeg('page-1.jpg'), jpeg('page-2.jpg'), jpeg('page-3.jpg')])
    assert.equal(error, undefined)
    assert.equal(scan?.contentType, 'application/pdf')
    assert.equal(detectScanType(scan?.bytes ?? new Uint8Array()), 'application/pdf')
    assert.equal(countPdfPages(scan?.bytes ?? new Uint8Array()), 3)
    // Le nombre de pages relevé, sans saisie de l'accueil : une par photo.
    assert.equal(withPageCount(new FormData(), 'content', scan).scan?.pageCount, 3)
  })

  it('refuse un PDF ou une image PNG mêlés à des photos', async () => {
    assert.match((await readScans([jpeg(), fichier(PDF)])).error ?? '', /PDF ou une image PNG se joint seul/)
    assert.match((await readScans([jpeg(), fichier(PNG, 'image/png', 'scan.png')])).error ?? '', /se joint seul/)
  })

  it('refuse une photo qui ne se lit pas', async () => {
    // Un début de JPEG sans en-tête d'image.
    const { error } = await readScans([jpeg(), fichier(JPEG, 'image/jpeg', 'abimee.jpg')])
    assert.match(error ?? '', /ne se lit pas/)
  })

  it('plafonne le nombre et le poids des photos', async () => {
    const trop = Array.from({ length: MAX_SCAN_PHOTOS + 1 }, (_, index) => jpeg(`page-${index}.jpg`))
    assert.match((await readScans(trop)).error ?? '', new RegExp(`Au plus ${MAX_SCAN_PHOTOS} photos`))
    const moitie = MAX_SCAN_PHOTOS_BYTES / 2
    const lourdes = [0, 1].map(() => new File([new Uint8Array(PHOTO), new Uint8Array(moitie)], 'lourde.jpg'))
    assert.match((await readScans(lourdes)).error ?? '', /10 Mo à elles toutes/)
  })
})
