import { photosToPdf } from './photos-pdf.ts'

/**
 * Contrôle des numérisations déposées par le centre.
 *
 * Le type est lu dans les premiers octets du fichier, jamais dans ce que le
 * navigateur déclare : le fichier est ensuite servi au client avec ce type, et
 * un HTML déguisé en PDF s'exécuterait sur notre domaine.
 */
export const scanContentTypes = ['application/pdf', 'image/jpeg', 'image/png'] as const
export type ScanContentType = (typeof scanContentTypes)[number]

/** 10 Mo : un courrier de dix pages numérisé en PDF à 300 dpi tient largement dedans. */
export const MAX_SCAN_BYTES = 10 * 1024 * 1024

export const scanExtensions: Record<ScanContentType, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
}

/** Valeur de l'attribut `accept` des champs de fichier. */
export const SCAN_ACCEPT = scanContentTypes.join(',')

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte)
}

export function detectScanType(bytes: Uint8Array): ScanContentType | undefined {
  // %PDF-
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  return undefined
}

export type ScanFile = {
  bytes: Uint8Array
  contentType: ScanContentType
  /** Pages d'un contenu (ADR 044) : lues dans le fichier ou saisies par l'accueil. */
  pageCount?: number
}

/**
 * Lit un champ de fichier de formulaire.
 *
 * `undefined` quand le champ est vide — un `<input type="file">` laissé vide
 * envoie tout de même un `File` de zéro octet.
 */
export async function readScan(
  value: FormDataEntryValue | null,
): Promise<{ scan?: ScanFile; error?: string }> {
  if (!value || typeof value === 'string' || value.size === 0) return {}
  if (value.size > MAX_SCAN_BYTES) {
    return { error: 'Le fichier dépasse 10 Mo. Numérisez en 300 dpi ou en niveaux de gris.' }
  }
  const bytes = new Uint8Array(await value.arrayBuffer())
  const contentType = detectScanType(bytes)
  if (!contentType) return { error: 'Seuls les fichiers PDF, JPEG et PNG sont acceptés.' }
  return { scan: { bytes, contentType } }
}

/**
 * Photos d'un même dépôt (ADR 055) : au plus 30, et 10 Mo à elles toutes,
 * comme un fichier seul — un enregistrement porte encore au plus deux fois
 * 10 Mo, sous le plafond de 21 Mo de l'envoi (`next.config.ts`, nginx).
 * Compressées dans le navigateur, elles pèsent chacune moins d'un mégaoctet.
 */
export const MAX_SCAN_PHOTOS = 30
export const MAX_SCAN_PHOTOS_BYTES = MAX_SCAN_BYTES

/**
 * Lit un champ qui accepte plusieurs fichiers (ADR 055). Un seul fichier est
 * gardé tel quel (`readScan`). Plusieurs photos JPEG — une par page — sont
 * réunies en un PDF, dans l'ordre de l'envoi : l'étape garde un seul
 * document, que le client consulte et dont les pages sont comptées.
 */
export async function readScans(
  values: FormDataEntryValue[],
): Promise<{ scan?: ScanFile; error?: string }> {
  const files = values.filter((value): value is File => typeof value !== 'string' && value.size > 0)
  if (files.length <= 1) return readScan(files[0] ?? null)
  if (files.length > MAX_SCAN_PHOTOS) {
    return { error: `Au plus ${MAX_SCAN_PHOTOS} photos à la fois. Au-delà, numérisez le courrier en PDF.` }
  }
  if (files.reduce((total, file) => total + file.size, 0) > MAX_SCAN_PHOTOS_BYTES) {
    return { error: 'Les photos dépassent 10 Mo à elles toutes. Retirez-en, ou numérisez le courrier en PDF.' }
  }
  const photos: Uint8Array[] = []
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (detectScanType(bytes) !== 'image/jpeg') {
      return { error: 'Plusieurs fichiers se joignent en photos JPEG. Un PDF ou une image PNG se joint seul.' }
    }
    photos.push(bytes)
  }
  const pdf = photosToPdf(photos)
  if (!pdf) return { error: 'Une des photos ne se lit pas. Reprenez-la, puis joignez-la de nouveau.' }
  return { scan: { bytes: pdf, contentType: 'application/pdf' } }
}
