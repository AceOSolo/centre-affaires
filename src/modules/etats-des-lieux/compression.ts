/**
 * Compression des photos d'états des lieux **dans le navigateur**, avant
 * l'envoi (R33, ADR 039) : le canvas réduit et recompresse, sans dépendance
 * (pas de `sharp`, ADR 039). Le téléphone sur place n'envoie que quelques
 * centaines de kilo-octets, et le serveur n'a plus qu'à vérifier
 * (`photos.ts`).
 *
 * Le réencodage a un second effet, voulu : les métadonnées EXIF de l'appareil
 * — dont la position GPS — ne partent pas.
 *
 * `targetSize` est pur et éprouvé (`compression.test.ts`) ; `compressPhoto`
 * ne tourne que dans un navigateur.
 */

/** Plus grand côté, en pixels : assez pour lire une rayure ou un compteur. */
export const PHOTO_MAX_EDGE = 1920
/** Qualité JPEG : le bon compromis entre le détail d'un dommage et le poids. */
export const PHOTO_QUALITY = 0.8
/** Le JPEG s'encode partout ; Safari ne sait pas encoder le WebP depuis un canvas. */
export const PHOTO_OUTPUT_TYPE = 'image/jpeg'

/** Dimensions après réduction : le plus grand côté ramené à `maxEdge`, jamais agrandi. */
export function targetSize(
  width: number,
  height: number,
  maxEdge: number = PHOTO_MAX_EDGE,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) throw new Error('Dimensions de photo invalides.')
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export class PhotoDecodeError extends Error {
  constructor() {
    super(
      'Cette photo n’a pas pu être lue par le navigateur. Prenez-la en JPEG, ou envoyez-la depuis un autre appareil.',
    )
    this.name = 'PhotoDecodeError'
  }
}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  // L'orientation EXIF est appliquée au décodage : une photo prise téléphone
  // tourné ne se retrouve pas couchée une fois réencodée.
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
    } catch {
      // Navigateur plus ancien : on retente avec un élément image.
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    }
  } catch {
    URL.revokeObjectURL(url)
    throw new PhotoDecodeError()
  }
}

/**
 * Réduit et recompresse une photo en JPEG. Rend le fichier à envoyer et ses
 * dimensions. Lève `PhotoDecodeError` si le navigateur ne sait pas la lire
 * (HEIC sur un ordinateur, fichier abîmé).
 */
export async function compressPhoto(
  file: Blob,
): Promise<{ blob: Blob; width: number; height: number }> {
  const image = await decode(file)
  try {
    const size = targetSize(image.width, image.height)
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (!context) throw new PhotoDecodeError()
    // Fond blanc : un PNG transparent ne devient pas noir en JPEG.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, size.width, size.height)
    context.imageSmoothingQuality = 'high'
    context.drawImage(image.source, 0, 0, size.width, size.height)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, PHOTO_OUTPUT_TYPE, PHOTO_QUALITY),
    )
    if (!blob) throw new PhotoDecodeError()
    return { blob, ...size }
  } finally {
    image.close()
  }
}
