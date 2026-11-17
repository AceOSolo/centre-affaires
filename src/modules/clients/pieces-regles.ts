import { slugify } from '../../lib/slug.ts'
import { photosToPdf } from '../courrier/photos-pdf.ts'
import type {
  ClientDocumentContentType,
  ClientDocumentSituation,
  ClientDocumentStatus,
} from './schema-pieces.ts'

/**
 * Pièces justificatives de la domiciliation (ADR 075) : ce que le centre
 * demande selon la situation de la société, ce que le client a déposé et où
 * il en est, et le contrôle des fichiers reçus.
 *
 * Module pur, sans base ni Next : importé par les écrans (navigateur compris)
 * et éprouvé seul (`pieces-regles.test.ts`).
 */

/* -------------------------------------------------------------------------- */
/* Liste des pièces demandées                                                 */
/* -------------------------------------------------------------------------- */

/** Une pièce de la liste du centre. */
export type ClientDocumentKind = {
  code: string
  label: string
  help: string | null
  appliesTo: ClientDocumentSituation
  position: number
  active: boolean
}

/**
 * Liste par défaut, celle d'un centre qui n'a rien réglé (règle commune de la
 * recette du 17/11 : la valeur du code est le défaut, réglable ensuite).
 *
 * - **Pièce d'identité du dirigeant** et **justificatif de domicile** : toutes
 *   les situations. La note de recette dit « justificatif de domicile de la
 *   société » ; c'est le domicile personnel du représentant légal que le
 *   domiciliataire doit vérifier (art. R123-168 du Code de commerce), d'où le
 *   libellé — à confirmer en recette, réglable.
 * - **Extrait Kbis** pour une société immatriculée, **projet de statuts** pour
 *   une société en création.
 */
export const defaultDocumentKinds: readonly ClientDocumentKind[] = [
  {
    code: 'piece-identite',
    label: 'Pièce d’identité du dirigeant',
    help: 'Carte d’identité recto verso ou passeport, en cours de validité.',
    appliesTo: 'all',
    position: 0,
    active: true,
  },
  {
    code: 'kbis',
    label: 'Extrait Kbis',
    help: 'De moins de trois mois.',
    appliesTo: 'registered',
    position: 1,
    active: true,
  },
  {
    code: 'statuts',
    label: 'Projet de statuts',
    help: 'Tel que vous le déposerez au greffe, signé ou non.',
    appliesTo: 'creation',
    position: 2,
    active: true,
  },
  {
    code: 'justificatif-domicile',
    label: 'Justificatif de domicile du dirigeant',
    help: 'De moins de trois mois : facture d’énergie ou de téléphone, avis d’imposition.',
    appliesTo: 'all',
    position: 3,
    active: true,
  },
]

export const situationLabels: Record<ClientDocumentSituation, string> = {
  all: 'Toutes les sociétés',
  creation: 'Société en cours de création',
  registered: 'Société déjà immatriculée',
}

/**
 * Situation de la société, lue dans les réponses de sa demande de
 * domiciliation (question `situation`). Un transfert de siège est une
 * société déjà immatriculée. `null` : pas de réponse lisible.
 *
 * À raccorder au lot 1 de la recette, qui ramène la question à deux choix
 * (`creation`, `immatriculee`) : les deux valeurs sont déjà lues ici.
 */
export function situationFromAnswers(answers: Readonly<Record<string, unknown>> | null | undefined): Exclude<
  ClientDocumentSituation,
  'all'
> | null {
  const value = answers?.situation
  if (value === 'creation') return 'creation'
  if (value === 'immatriculee' || value === 'transfert') return 'registered'
  return null
}

/**
 * Pièces demandées à une société, dans l'ordre de la liste. Sans situation
 * connue — une entreprise domiciliée par contrat, sans demande du site —, la
 * société est tenue pour immatriculée : c'est le cas d'un client déjà sous
 * contrat (choix à confirmer en recette).
 */
export function kindsForSituation(
  kinds: readonly ClientDocumentKind[],
  situation: Exclude<ClientDocumentSituation, 'all'> | null,
): ClientDocumentKind[] {
  const effective = situation ?? 'registered'
  return kinds
    .filter((kind) => kind.active && (kind.appliesTo === 'all' || kind.appliesTo === effective))
    .sort((a, b) => a.position - b.position || a.label.localeCompare(b.label, 'fr'))
}

/** « pièce d’identité du dirigeant, extrait Kbis et justificatif de domicile » : la liste dans une phrase. */
export function describeKinds(kinds: readonly Pick<ClientDocumentKind, 'label'>[]): string {
  const labels = kinds.map((kind) => kind.label.charAt(0).toLocaleLowerCase('fr') + kind.label.slice(1))
  if (labels.length <= 1) return labels.join('')
  return `${labels.slice(0, -1).join(', ')} et ${labels.at(-1)}`
}

/** Bornes des champs d'une pièce de la liste (`client_document_kinds`). */
export const KIND_LABEL_MAX = 120
export const KIND_HELP_MAX = 300

export type KindInput = { label: string; help: string | null; appliesTo: ClientDocumentSituation }
export type KindErrors = Partial<Record<'label' | 'help' | 'appliesTo', string>>

/** Lit la saisie d'une pièce de la liste. */
export function parseKindInput(input: {
  label?: string | null
  help?: string | null
  appliesTo?: string | null
}): { ok: true; value: KindInput } | { ok: false; errors: KindErrors } {
  const errors: KindErrors = {}
  const label = (input.label ?? '').replace(/\s+/g, ' ').trim()
  const help = (input.help ?? '').replace(/\s+/g, ' ').trim()
  const appliesTo = input.appliesTo ?? ''
  if (!label) errors.label = 'Nommez la pièce : « Extrait Kbis », « Pièce d’identité du dirigeant ».'
  else if (label.length > KIND_LABEL_MAX) errors.label = `Le nom tient en ${KIND_LABEL_MAX} caractères au plus.`
  if (help.length > KIND_HELP_MAX) errors.help = `L’aide tient en ${KIND_HELP_MAX} caractères au plus.`
  if (!(appliesTo in situationLabels)) errors.appliesTo = 'Choisissez à quelles sociétés la pièce est demandée.'
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, value: { label, help: help || null, appliesTo: appliesTo as ClientDocumentSituation } }
}

/** Code d'une pièce ajoutée : tiré de son nom, libre dans la liste. */
export function newKindCode(label: string, taken: Iterable<string>): string {
  const base = slugify(label).slice(0, 34).replace(/-+$/g, '') || 'piece'
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}-${Date.now() % 100000}`
}

/** Nouvel ordre après avoir monté ou descendu une pièce : la liste des codes. */
export function moveKind(codes: readonly string[], code: string, direction: 'up' | 'down'): string[] {
  const list = [...codes]
  const index = list.indexOf(code)
  const target = direction === 'up' ? index - 1 : index + 1
  if (index < 0 || target < 0 || target >= list.length) return list
  ;[list[index], list[target]] = [list[target], list[index]]
  return list
}

/* -------------------------------------------------------------------------- */
/* Où en est le client                                                        */
/* -------------------------------------------------------------------------- */

/** Ce que l'écran sait d'une pièce déposée. */
export type DepositedDocument = {
  id: string
  kindCode: string
  kindLabel: string
  status: ClientDocumentStatus
  refusalReason: string | null
  contentType: string
  byteSize: number
  createdAt: Date
  reviewedAt: Date | null
  /** Fichier effacé au terme de sa conservation. */
  purged: boolean
}

/** État d'une pièce demandée : la dernière déposée décide. */
export type ChecklistState = 'missing' | ClientDocumentStatus

export type ChecklistItem<D extends DepositedDocument = DepositedDocument> = {
  kind: ClientDocumentKind
  /** Dernière pièce déposée pour ce type, la plus récente d'abord. */
  latest: D | undefined
  state: ChecklistState
  /** Le client peut-il en déposer une (manquante, ou refusée) ? */
  canDeposit: boolean
  /** Toutes les pièces déposées pour ce type, la plus récente d'abord. */
  history: D[]
}

/** Peut-on déposer une pièce de ce type ? Pas tant qu'une autre attend sa vérification ou est validée. */
export function canDepositAfter(state: ChecklistState): boolean {
  return state === 'missing' || state === 'refused'
}

/**
 * La liste à cocher : une ligne par pièce demandée, avec la dernière pièce
 * déposée et son état ; à part, les pièces déposées dont le type n'est plus
 * demandé (liste changée, situation changée).
 */
export function documentChecklist<D extends DepositedDocument>(
  kinds: readonly ClientDocumentKind[],
  documents: readonly D[],
): { items: ChecklistItem<D>[]; others: D[] } {
  const newestFirst = [...documents].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  const items = kinds.map((kind) => {
    const history = newestFirst.filter((document) => document.kindCode === kind.code)
    const latest = history[0]
    const state: ChecklistState = latest ? latest.status : 'missing'
    return { kind, latest, state, canDeposit: canDepositAfter(state), history }
  })
  const asked = new Set(kinds.map((kind) => kind.code))
  return { items, others: newestFirst.filter((document) => !asked.has(document.kindCode)) }
}

/** Nombre de pièces encore attendues du client : manquantes ou refusées. */
export function missingCount(items: readonly Pick<ChecklistItem, 'state'>[]): number {
  return items.filter((item) => item.state === 'missing' || item.state === 'refused').length
}

/** Nombre de pièces que l'accueil doit vérifier. */
export function toReviewCount(items: readonly Pick<ChecklistItem, 'state'>[]): number {
  return items.filter((item) => item.state === 'received').length
}

/** Ce que voit le client, en texte : jamais la seule couleur. */
export const clientStateLabels: Record<ChecklistState, string> = {
  missing: 'À déposer',
  received: 'Reçue, en cours de vérification',
  accepted: 'Validée',
  refused: 'Refusée',
}

/** Ce que voit l'équipe. */
export const staffStateLabels: Record<ChecklistState, string> = {
  missing: 'Pas encore déposée',
  received: 'À vérifier',
  accepted: 'Validée',
  refused: 'Refusée',
}

/* -------------------------------------------------------------------------- */
/* Vérification par l'accueil                                                 */
/* -------------------------------------------------------------------------- */

export const REFUSAL_REASON_MAX = 500

/** Passages permis : une pièce reçue se valide ou se refuse ; une pièce validée peut encore être refusée. */
export function canReview(from: ClientDocumentStatus, to: Exclude<ClientDocumentStatus, 'received'>): boolean {
  if (from === 'received') return true
  return from === 'accepted' && to === 'refused'
}

/** Motif d'un refus : obligatoire, lu par le client, borné. */
export function parseRefusalReason(value: string | null | undefined): { ok: true; reason: string } | { ok: false; error: string } {
  const reason = (value ?? '').replace(/\r\n?/g, '\n').trim()
  if (!reason) return { ok: false, error: 'Dites au client pourquoi la pièce est refusée : il le lira avant d’en déposer une autre.' }
  if (reason.length > REFUSAL_REASON_MAX) {
    return { ok: false, error: `Le motif tient en ${REFUSAL_REASON_MAX} caractères au plus (${reason.length}).` }
  }
  return { ok: true, reason }
}

/* -------------------------------------------------------------------------- */
/* Fichiers reçus                                                             */
/* -------------------------------------------------------------------------- */

/** 10 Mo : `client_documents_byte_size_valid`. */
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024
/** Photos réunies en un PDF : un passeport, un recto verso, des statuts de quelques pages. */
export const DOCUMENT_MAX_PHOTOS = 20

/** Ce que le champ de fichier propose : PDF, photos. Une photo HEIC est convertie en JPEG par le navigateur. */
export const DOCUMENT_ACCEPT = 'application/pdf,image/jpeg,image/png,image/heic,image/heif'

export const documentExtensions: Record<ClientDocumentContentType, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

/** Type lu dans les premiers octets, jamais dans ce que le navigateur déclare. */
export function detectDocumentType(bytes: Uint8Array): ClientDocumentContentType | undefined {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  return undefined
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'])

/**
 * Une photo HEIC ou HEIF (iPhone) : boîte `ftyp` à l'octet 4. Le serveur ne la
 * convertit pas (pas de dépendance d'image, ADR 039) : le navigateur le fait
 * quand il sait la lire, sinon le message dit quoi faire.
 */
export function isHeif(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || !startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return false
  const brand = String.fromCharCode(...bytes.subarray(8, 12))
  return HEIF_BRANDS.has(brand)
}

export type DocumentFile = { bytes: Uint8Array; contentType: ClientDocumentContentType }

const HEIF_MESSAGE =
  'Photo au format HEIC : votre navigateur n’a pas pu la convertir. Sur iPhone, envoyez-la depuis Safari, ou réglez l’appareil photo sur « Le plus compatible » ; sinon, envoyez un PDF ou une photo JPEG.'

/**
 * Lit le ou les fichiers d'un dépôt. Un PDF, une photo JPEG ou PNG se joint
 * seul ; plusieurs photos JPEG — recto et verso d'une carte d'identité, pages
 * de statuts — sont réunies en un seul PDF, dans l'ordre de l'envoi.
 */
export async function readDocumentFiles(
  values: readonly FormDataEntryValue[],
): Promise<{ file: DocumentFile; error?: undefined } | { file?: undefined; error: string }> {
  const files = values.filter((value): value is File => typeof value !== 'string' && value.size > 0)
  if (files.length === 0) return { error: 'Choisissez le fichier à déposer : un PDF ou une photo.' }
  if (files.length > DOCUMENT_MAX_PHOTOS) {
    return { error: `Au plus ${DOCUMENT_MAX_PHOTOS} photos à la fois. Au-delà, envoyez un PDF.` }
  }
  if (files.reduce((total, file) => total + file.size, 0) > DOCUMENT_MAX_BYTES) {
    return {
      error:
        files.length > 1
          ? 'Les photos dépassent 10 Mo à elles toutes. Retirez-en, ou envoyez un PDF.'
          : 'Le fichier dépasse 10 Mo. Enregistrez-le en qualité réduite, ou photographiez le document.',
    }
  }
  const contents = await Promise.all(files.map(async (file) => new Uint8Array(await file.arrayBuffer())))
  return checkDocumentBytes(contents)
}

/** Le contrôle de `readDocumentFiles`, sur les octets : éprouvé seul. */
export function checkDocumentBytes(
  contents: readonly Uint8Array[],
): { file: DocumentFile; error?: undefined } | { file?: undefined; error: string } {
  if (contents.length === 0) return { error: 'Choisissez le fichier à déposer : un PDF ou une photo.' }
  if (contents.some(isHeif)) return { error: HEIF_MESSAGE }
  if (contents.length === 1) {
    const [bytes] = contents
    const contentType = detectDocumentType(bytes)
    if (!contentType) return { error: 'Seuls les fichiers PDF, JPEG et PNG sont acceptés.' }
    if (bytes.byteLength > DOCUMENT_MAX_BYTES) return { error: 'Le fichier dépasse 10 Mo.' }
    return { file: { bytes, contentType } }
  }
  if (contents.some((bytes) => detectDocumentType(bytes) !== 'image/jpeg')) {
    return { error: 'Plusieurs fichiers se joignent en photos JPEG. Un PDF ou une image PNG se joint seul.' }
  }
  const pdf = photosToPdf([...contents])
  if (!pdf) return { error: 'Une des photos ne se lit pas. Reprenez-la, puis déposez-la de nouveau.' }
  if (pdf.byteLength > DOCUMENT_MAX_BYTES) return { error: 'Les photos dépassent 10 Mo à elles toutes. Retirez-en, ou envoyez un PDF.' }
  return { file: { bytes: pdf, contentType: 'application/pdf' } }
}

/** « 1,2 Mo », « 350 ko » : le poids d'un fichier, tel qu'on le dit. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`
  }
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('fr-FR')} ko`
}
