import { constants, inflateSync } from 'node:zlib'

import type { ScanContentType, ScanFile } from './fichiers.ts'

/**
 * Nombre de pages d'un contenu numérisé (ADR 044) : la facturation en dépend,
 * au-delà des pages comprises dans l'ouverture.
 *
 * Une image est une page. Un PDF se lit sans bibliothèque : le catalogue
 * désigné par la dernière remorque (`/Root`) mène à l'arbre des pages, dont la
 * racine porte le total (`/Count`). Les objets rangés dans des flux d'objets
 * compressés (PDF 1.5 et plus, fréquents chez les scanners récents) sont
 * décompressés avec zlib, déjà dans Node.
 *
 * `undefined` quand le fichier ne se laisse pas lire (PDF chiffré, abîmé) :
 * l'accueil saisit alors le nombre de pages. Jamais une estimation.
 */
export const MAX_PAGE_COUNT = 1000

export function countScanPages(bytes: Uint8Array, contentType: ScanContentType): number | undefined {
  if (contentType !== 'application/pdf') return 1
  return countPdfPages(bytes)
}

type PdfObjects = Map<number, string>

export function countPdfPages(bytes: Uint8Array): number | undefined {
  // latin1 : un caractère par octet, les positions du texte sont celles du fichier.
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
  const objects = readObjects(text, bytes)

  const fromTree = countFromPageTree(text, objects)
  if (fromTree !== undefined) return fromTree

  // Remorque illisible : la plus grande racine d'arbre de pages trouvée, sinon
  // les pages elles-mêmes.
  let largest: number | undefined
  let leaves = 0
  for (const body of objects.values()) {
    if (/\/Type\s*\/Pages\b/.test(body)) {
      const count = directCount(body, objects)
      if (count !== undefined && (largest === undefined || count > largest)) largest = count
    } else if (/\/Type\s*\/Page(?![A-Za-z])/.test(body)) {
      leaves++
    }
  }
  return valid(largest) ?? valid(leaves)
}

function valid(count: number | undefined): number | undefined {
  return count !== undefined && Number.isInteger(count) && count >= 1 && count <= MAX_PAGE_COUNT
    ? count
    : undefined
}

function countFromPageTree(text: string, objects: PdfObjects): number | undefined {
  // La dernière remorque est celle de la dernière mise à jour du fichier ; un
  // flux de références croisées la porte dans son propre dictionnaire.
  const roots = [...text.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)]
  const root = roots.at(-1)
  if (!root) return undefined
  const catalog = objects.get(Number(root[1]))
  const pages = catalog?.match(/\/Pages\s+(\d+)\s+\d+\s+R/)
  if (!pages) return undefined
  const tree = objects.get(Number(pages[1]))
  return tree ? valid(directCount(tree, objects)) : undefined
}

/** `/Count 12`, ou `/Count 7 0 R` résolu. */
function directCount(body: string, objects: PdfObjects): number | undefined {
  const match = body.match(/\/Count\s+(\d+)(?:\s+(\d+)\s+R)?/)
  if (!match) return undefined
  if (match[2] === undefined) return Number(match[1])
  const target = objects.get(Number(match[1]))?.trim()
  return target && /^\d+$/.test(target) ? Number(target) : undefined
}

/**
 * Objets du fichier, par numéro. Les définitions en clair suivent l'ordre du
 * fichier : une mise à jour incrémentale, ajoutée à la fin, remplace
 * l'ancienne version de l'objet. Les objets des flux compressés viennent
 * d'abord, et ne remplacent pas une définition en clair.
 */
function readObjects(text: string, bytes: Uint8Array): PdfObjects {
  const plain: PdfObjects = new Map()
  for (const match of text.matchAll(/(?:^|[\s>\]])(\d+)\s+(\d+)\s+obj\b([\s\S]*?)\bendobj\b/g)) {
    plain.set(Number(match[1]), match[3])
  }

  const objects: PdfObjects = new Map()
  for (const body of plain.values()) {
    if (!/\/Type\s*\/ObjStm\b/.test(body)) continue
    for (const [number, content] of readObjectStream(body, text, bytes)) {
      objects.set(number, content)
    }
  }
  for (const [number, body] of plain) objects.set(number, body)
  return objects
}

/** Objets d'un flux d'objets (`/Type /ObjStm`), compressé en FlateDecode. */
function readObjectStream(body: string, text: string, bytes: Uint8Array): [number, string][] {
  const n = Number(body.match(/\/N\s+(\d+)/)?.[1])
  const first = Number(body.match(/\/First\s+(\d+)/)?.[1])
  if (!Number.isInteger(n) || !Number.isInteger(first)) return []
  if (/\/Filter/.test(body) && !/\/Filter\s*\/FlateDecode\b/.test(body)) return []
  if (/\/DecodeParms/.test(body)) return []

  const data = streamData(body, text, bytes)
  if (!data) return []
  let decoded: string
  try {
    const raw = /\/Filter/.test(body)
      ? inflateSync(data, { finishFlush: constants.Z_SYNC_FLUSH })
      : Buffer.from(data)
    decoded = raw.toString('latin1')
  } catch {
    return []
  }

  const header = decoded.slice(0, first).trim().split(/\s+/).map(Number)
  const entries: [number, string][] = []
  for (let index = 0; index < n; index++) {
    const number = header[index * 2]
    const offset = header[index * 2 + 1]
    const next = index + 1 < n ? header[index * 2 + 3] : decoded.length - first
    if (!Number.isInteger(number) || !Number.isInteger(offset) || !Number.isInteger(next)) return entries
    entries.push([number, decoded.slice(first + offset, first + next)])
  }
  return entries
}

/** Octets du flux d'un objet : entre `stream` et `endstream`. */
function streamData(body: string, text: string, bytes: Uint8Array): Uint8Array | undefined {
  const keyword = body.match(/>>\s*stream(\r\n|\n|\r)/)
  if (!keyword || keyword.index === undefined) return undefined
  // Retrouve la position du corps dans le fichier : le corps est une
  // sous-chaîne exacte du texte, latin1 garde l'alignement sur les octets.
  const bodyStart = text.indexOf(body)
  if (bodyStart < 0) return undefined
  const start = bodyStart + keyword.index + keyword[0].length
  const end = text.indexOf('endstream', start)
  if (end < 0) return undefined
  return bytes.subarray(start, end)
}

/**
 * Pages lues pour un dépôt : la saisie de l'accueil, quand elle est faite,
 * l'emporte sur la lecture du fichier (pages blanches, verso numérisé à part).
 * Sans saisie ni lecture possible, le dépôt demande la saisie.
 */
export function readPageCount(
  input: string,
  detected: number | undefined,
): { pages: number; error?: undefined } | { pages?: undefined; error: string } {
  const value = input.trim()
  if (value !== '') {
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_PAGE_COUNT) {
      return { error: `Un nombre entier de pages, de 1 à ${MAX_PAGE_COUNT}.` }
    }
    return { pages: Number(value) }
  }
  if (detected === undefined) {
    return {
      error: 'Le nombre de pages n’a pas pu être lu dans le fichier : indiquez-le.',
    }
  }
  return { pages: detected }
}

/**
 * Pages d'un contenu déposé par un formulaire (ADR 044) : la saisie du champ
 * `<champ>Pages`, sinon le compte lu dans le fichier. Sans l'un ni l'autre,
 * une erreur pour le champ des pages.
 */
export function withPageCount(
  formData: FormData,
  field: string,
  scan: ScanFile | undefined,
): { scan?: ScanFile; error?: string } {
  if (!scan) return {}
  const input = String(formData.get(`${field}Pages`) ?? '')
  const pages = readPageCount(input, countScanPages(scan.bytes, scan.contentType))
  if (pages.error !== undefined) return { error: pages.error }
  return { scan: { ...scan, pageCount: pages.pages } }
}
