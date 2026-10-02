import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MAX_SCAN_BYTES, detectScanType, readScan } from './fichiers.ts'

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]

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
