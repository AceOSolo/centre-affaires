/**
 * Photos d'un courrier réunies en un seul PDF, une page par photo (ADR 055).
 *
 * Une étape du courrier garde un seul document : celui que le client ouvre,
 * dont les pages sont comptées (`pages.ts`) et que le relevé lit. Plusieurs
 * photos prises au téléphone — une par page de la lettre — deviennent donc un
 * PDF, écrit ici sans bibliothèque : chaque photo y est recopiée telle quelle
 * (filtre `DCTDecode`), rien n'est décodé ni réencodé côté serveur.
 *
 * Pur et sans API de Node : le module est importé, sans être exécuté, par des
 * composants du navigateur (`fichiers.ts`).
 */

export type JpegInfo = {
  width: number
  height: number
  components: 1 | 3
  /** Rotation à appliquer à l'affichage, lue dans l'orientation EXIF de l'appareil. */
  rotation: 0 | 90 | 180 | 270
}

/** Orientation EXIF vers la rotation de page (`/Rotate`, sens horaire). Les variantes en miroir n'en tiennent pas compte. */
const rotations: Record<number, JpegInfo['rotation']> = { 3: 180, 6: 90, 8: 270 }

/**
 * Dimensions et couleurs d'une photo JPEG, lues dans son en-tête (`SOFn`).
 * `undefined` pour un fichier qui n'en est pas une, ou dont le codage n'est
 * pas lu par les lecteurs de PDF : seuls le JPEG de base et le progressif le
 * sont partout, en niveaux de gris ou en couleurs.
 */
export function readJpegInfo(bytes: Uint8Array): JpegInfo | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let rotation: JpegInfo['rotation'] = 0
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined
    const marker = bytes[offset + 1]
    // Octets de remplissage, puis marqueurs sans longueur.
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2
      continue
    }
    // Fin d'image ou début des données sans en-tête d'image : rien à lire.
    if (marker === 0xd9 || marker === 0xda) return undefined
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
    const end = offset + 2 + length
    if (length < 2 || end > bytes.length) return undefined
    const segment = bytes.subarray(offset + 4, end)
    if (marker === 0xe1) rotation = rotations[exifOrientation(segment) ?? 1] ?? rotation
    // SOF0 (base), SOF1 (base étendue), SOF2 (progressif).
    if (marker >= 0xc0 && marker <= 0xc2) {
      if (segment.length < 6) return undefined
      const height = (segment[1] << 8) | segment[2]
      const width = (segment[3] << 8) | segment[4]
      const components = segment[5]
      if (width === 0 || height === 0 || (components !== 1 && components !== 3)) return undefined
      return { width, height, components, rotation }
    }
    // Codage arithmétique ou sans perte : pas lu par les lecteurs de PDF.
    if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return undefined
    }
    offset = end
  }
  return undefined
}

/** Orientation (balise 0x0112) du premier répertoire d'un segment EXIF, si elle y est. */
function exifOrientation(segment: Uint8Array): number | undefined {
  // « Exif\0\0 », puis un en-tête TIFF : « II » (petit-boutiste) ou « MM ».
  const header = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]
  if (segment.length < 14 || header.some((byte, index) => segment[index] !== byte)) return undefined
  const tiff = new DataView(segment.buffer, segment.byteOffset + 6, segment.byteLength - 6)
  try {
    const order = tiff.getUint16(0)
    if (order !== 0x4949 && order !== 0x4d4d) return undefined
    const little = order === 0x4949
    if (tiff.getUint16(2, little) !== 42) return undefined
    const directory = tiff.getUint32(4, little)
    const entries = tiff.getUint16(directory, little)
    for (let index = 0; index < entries; index++) {
      const entry = directory + 2 + index * 12
      if (tiff.getUint16(entry, little) === 0x0112) return tiff.getUint16(entry + 8, little)
    }
  } catch {
    // Répertoire tronqué : pas d'orientation lisible.
  }
  return undefined
}

/** Plus grand côté d'une page, en points : celui d'une page A4. */
const PAGE_LONG_EDGE = 842

const ascii = (text: string) => new TextEncoder().encode(text)
const points = (value: number) => String(Math.round(value * 100) / 100)

/**
 * Le PDF des photos, dans l'ordre donné, une page par photo à la taille d'une
 * page A4 sur son grand côté. `undefined` si l'une n'est pas une photo JPEG
 * lisible (`readJpegInfo`), ou s'il n'y en a aucune.
 */
export function photosToPdf(photos: Uint8Array[]): Uint8Array | undefined {
  const infos = photos.map(readJpegInfo)
  if (photos.length === 0 || infos.some((info) => info === undefined)) return undefined

  // Objets numérotés à partir de 1 : le catalogue, l'arbre des pages, puis
  // pour chaque photo sa page, son image et le dessin qui la pose.
  const pageNumber = (index: number) => 3 + index * 3
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const write = (chunk: Uint8Array) => {
    chunks.push(chunk)
    length += chunk.byteLength
  }
  const object = (number: number, parts: (string | Uint8Array)[]) => {
    offsets[number] = length
    write(ascii(`${number} 0 obj\n`))
    for (const part of parts) write(typeof part === 'string' ? ascii(part) : part)
    write(ascii('\nendobj\n'))
  }

  // En-tête, puis un commentaire d'octets hauts : le fichier est binaire.
  write(ascii('%PDF-1.4\n'))
  write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))

  object(1, ['<< /Type /Catalog /Pages 2 0 R >>'])
  const kids = photos.map((_, index) => `${pageNumber(index)} 0 R`).join(' ')
  object(2, [`<< /Type /Pages /Kids [${kids}] /Count ${photos.length} >>`])

  photos.forEach((photo, index) => {
    const info = infos[index] as JpegInfo
    const page = pageNumber(index)
    const scale = PAGE_LONG_EDGE / Math.max(info.width, info.height)
    const width = points(info.width * scale)
    const height = points(info.height * scale)
    object(page, [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}]`,
      info.rotation ? ` /Rotate ${info.rotation}` : '',
      ` /Resources << /XObject << /Im0 ${page + 1} 0 R >> >> /Contents ${page + 2} 0 R >>`,
    ])
    object(page + 1, [
      `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height}`,
      ` /ColorSpace /${info.components === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8`,
      ` /Filter /DCTDecode /Length ${photo.byteLength} >>\nstream\n`,
      photo,
      '\nendstream',
    ])
    const drawing = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`
    object(page + 2, [`<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`])
  })

  // Table des références : une entrée de 20 octets par objet, l'objet 0 libre.
  const size = pageNumber(photos.length)
  const xref = length
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`
  for (let number = 1; number < size; number++) {
    table += `${String(offsets[number]).padStart(10, '0')} 00000 n \n`
  }
  write(ascii(`${table}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`))

  const pdf = new Uint8Array(length)
  let position = 0
  for (const chunk of chunks) {
    pdf.set(chunk, position)
    position += chunk.byteLength
  }
  return pdf
}
