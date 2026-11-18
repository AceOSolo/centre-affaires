/**
 * Aperçu des pages d'un PDF de photos, sans lecteur de PDF (ADR 079).
 *
 * Le contenu d'un pli est le plus souvent un PDF écrit par `photosToPdf`
 * (ADR 055) : une page par photo, chaque photo recopiée telle quelle
 * (`DCTDecode`). Ses pages se montrent donc comme des images JPEG, partout —
 * tablette comprise, où un PDF dans un cadre ne montre que sa première page —
 * sans bibliothèque ni décodage.
 *
 * `pdfPageImages` rend, dans l'ordre du fichier, la photo de chaque page et la
 * rotation de la page (`/Rotate`) ; `undefined` dès qu'une page n'est pas
 * faite d'une seule photo JPEG (PDF d'un scanner, texte, images compressées
 * autrement) : l'écran se rabat alors sur le PDF lui-même.
 *
 * Pur et sans API de Node : utilisé dans le navigateur, éprouvé par
 * `node --test`.
 */

export type PdfPageImage = {
  /** La photo de la page, telle qu'elle a été déposée. */
  jpeg: Uint8Array
  /** Rotation de la page, sens horaire. */
  rotation: 0 | 90 | 180 | 270
}

/** Au-delà, l'aperçu page par page n'aide plus : le PDF s'ouvre en entier. */
export const MAX_PREVIEW_PAGES = 60

/** Un caractère par octet : les positions du texte sont celles du fichier. */
const latin1 = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes)

const OBJECT = /(\d+)\s+0\s+obj\s*<<([\s\S]*?)>>\s*(stream\r?\n)?/g

/**
 * Photos des pages d'un PDF de photos ; `undefined` s'il n'en est pas un.
 * Chaque objet image `DCTDecode` de longueur directe est lu à sa place ; les
 * pages et les images doivent être en même nombre, dans le même ordre.
 */
export function pdfPageImages(pdf: Uint8Array): PdfPageImage[] | undefined {
  if (latin1(pdf.subarray(0, 5)) !== '%PDF-') return undefined
  // Les dictionnaires sont en ASCII ; les flux (les photos), binaires, sont
  // lus par leur longueur et sautés : la recherche reprend après eux.
  const text = latin1(pdf)
  const rotations: PdfPageImage['rotation'][] = []
  const images: Uint8Array[] = []
  OBJECT.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = OBJECT.exec(text))) {
    const dictionary = match[2]
    const streamStart = match.index + match[0].length
    if (/\/Type\s*\/Page(?![s\w])/.test(dictionary)) {
      const rotate = /\/Rotate\s+(-?\d+)/.exec(dictionary)
      const degrees = ((Number(rotate?.[1] ?? 0) % 360) + 360) % 360
      if (degrees !== 0 && degrees !== 90 && degrees !== 180 && degrees !== 270) return undefined
      rotations.push(degrees)
    }
    if (!match[3]) continue
    const length = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dictionary)
    if (!length) return undefined
    const end = streamStart + Number(length[1])
    if (end > pdf.length) return undefined
    if (/\/Subtype\s*\/Image/.test(dictionary)) {
      // Une seule compression, et celle d'une photo : sinon, pas d'aperçu image.
      if (!/\/Filter\s*\/DCTDecode/.test(dictionary) || /\/Filter\s*\[/.test(dictionary)) return undefined
      const jpeg = pdf.subarray(streamStart, end)
      if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return undefined
      images.push(jpeg)
    }
    OBJECT.lastIndex = end
  }
  if (rotations.length === 0 || rotations.length !== images.length || images.length > MAX_PREVIEW_PAGES) {
    return undefined
  }
  return images.map((jpeg, index) => ({ jpeg, rotation: rotations[index] }))
}
