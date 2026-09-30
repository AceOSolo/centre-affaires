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

export type ScanFile = { bytes: Uint8Array; contentType: ScanContentType }

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
