/**
 * Contrôle des photos d'états des lieux reçues par le serveur (R06, R33,
 * ADR 039).
 *
 * Le navigateur les a déjà réduites et recompressées (`compression.ts`) ; le
 * serveur ne les retouche pas, il vérifie. Le type et les dimensions sont lus
 * dans les octets, jamais dans ce que le navigateur déclare : la photo est
 * ensuite servie avec ce type, et un HTML déguisé en image s'exécuterait sur
 * notre domaine.
 *
 * Module pur, sans base ni stockage : `photos.test.ts`.
 */

/** Types acceptés : `inspection_photos_content_type_allowed`. */
export const photoContentTypes = ['image/jpeg', 'image/webp', 'image/png'] as const
export type PhotoContentType = (typeof photoContentTypes)[number]

/** 10 Mio : `INSPECTION_PHOTO_MAX_BYTES` (schéma), `inspection_photos_byte_size_valid`. */
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024
/** `inspection_photos_dimensions_valid`. */
export const PHOTO_MAX_DIMENSION = 10_000

export const photoExtensions: Record<PhotoContentType, string> = {
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/png': 'png',
}

export type DetectedImage = { contentType: PhotoContentType; width: number; height: number }

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length))
const u16be = (bytes: Uint8Array, offset: number) => (bytes[offset] << 8) | bytes[offset + 1]
const u32be = (bytes: Uint8Array, offset: number) =>
  ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]
const u24le = (bytes: Uint8Array, offset: number) =>
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)

function png(bytes: Uint8Array): DetectedImage | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24 || !signature.every((byte, index) => bytes[index] === byte)) return undefined
  // Le premier bloc est toujours IHDR : largeur puis hauteur, sur 4 octets.
  if (ascii(bytes, 12, 4) !== 'IHDR') return undefined
  return { contentType: 'image/png', width: u32be(bytes, 16), height: u32be(bytes, 20) }
}

/** Marqueurs SOF qui portent les dimensions (ni DHT C4, ni JPG C8, ni DAC CC). */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

function jpeg(bytes: Uint8Array): DetectedImage | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return undefined
  let offset = 2
  while (offset + 3 < bytes.length) {
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
    // Fin d'image, ou début des données avant toute dimension : illisible.
    if (marker === 0xd9 || marker === 0xda) return undefined
    const segment = u16be(bytes, offset + 2)
    if (segment < 2) return undefined
    if (SOF_MARKERS.has(marker)) {
      if (offset + 9 > bytes.length) return undefined
      return {
        contentType: 'image/jpeg',
        height: u16be(bytes, offset + 5),
        width: u16be(bytes, offset + 7),
      }
    }
    offset += 2 + segment
  }
  return undefined
}

function webp(bytes: Uint8Array): DetectedImage | undefined {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    return undefined
  }
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X') {
    // Toile : largeur − 1 et hauteur − 1 sur 3 octets, petit-boutiste.
    return {
      contentType: 'image/webp',
      width: u24le(bytes, 24) + 1,
      height: u24le(bytes, 27) + 1,
    }
  }
  if (chunk === 'VP8 ') {
    // Image clé : code de départ 9d 01 2a, puis 14 bits par dimension.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined
    return {
      contentType: 'image/webp',
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    }
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined
    const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0
    return {
      contentType: 'image/webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    }
  }
  return undefined
}

/** Type et dimensions lus dans le fichier, ou `undefined` s'il n'est pas une image acceptée. */
export function detectImage(bytes: Uint8Array): DetectedImage | undefined {
  return jpeg(bytes) ?? png(bytes) ?? webp(bytes)
}

export type PhotoFile = DetectedImage & { bytes: Uint8Array }

/**
 * Lit la photo d'un formulaire. Rend la photo vérifiée, ou un message à
 * afficher : vide, trop lourde, d'un type refusé, de dimensions illisibles.
 */
export async function readPhoto(
  value: FormDataEntryValue | null,
): Promise<{ photo?: PhotoFile; error?: string }> {
  if (!value || typeof value === 'string' || value.size === 0) {
    return { error: 'Aucune photo reçue.' }
  }
  if (value.size > PHOTO_MAX_BYTES) {
    return {
      error:
        'La photo dépasse 10 Mo même après compression. Reprenez-la, ou réduisez-la avant de l’envoyer.',
    }
  }
  const bytes = new Uint8Array(await value.arrayBuffer())
  const image = detectImage(bytes)
  if (!image) return { error: 'Seules les photos JPEG, WebP et PNG sont acceptées.' }
  if (
    image.width < 1 ||
    image.height < 1 ||
    image.width > PHOTO_MAX_DIMENSION ||
    image.height > PHOTO_MAX_DIMENSION
  ) {
    return { error: 'Les dimensions de cette photo sont illisibles ou dépassent 10 000 pixels.' }
  }
  return { photo: { ...image, bytes } }
}
