import { detectImage } from '../etats-des-lieux/photos.ts'

/**
 * Photos et vidéos des annonces (ADR 073).
 *
 * Une annonce montre l'espace : ses médias sont publics par nature. Ils ne
 * sont donc ni chiffrés ni journalisés, à la différence des scans de courrier
 * et des photos d'états des lieux, mais ils restent dans le stockage européen
 * du centre et sont servis par l'application — jamais par un tiers (une
 * vidéo YouTube transmettrait l'adresse IP du visiteur à Google).
 *
 * Le type est lu dans les octets, jamais dans ce que le navigateur déclare :
 * le fichier est servi au public avec ce type, et un HTML déguisé en image
 * s'exécuterait sur notre domaine.
 *
 * Module pur, sans base ni stockage : `annonces-medias.test.ts`.
 */

export const listingMediaContentTypes = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/webm',
] as const
export type ListingMediaContentType = (typeof listingMediaContentTypes)[number]
export type ListingMediaKind = 'photo' | 'video'

/** Un média, tel qu'il est rangé dans `listings.photos`, dans l'ordre d'affichage. */
export type ListingMedia = {
  id: string
  kind: ListingMediaKind
  contentType: ListingMediaContentType
  /** Clé dans le stockage objet. */
  key: string
  byteSize: number
  /** Nulles pour une vidéo : ses dimensions ne se lisent pas sans la décoder. */
  width: number | null
  height: number | null
  /** Ce que montre le média, lu par les lecteurs d'écran. */
  alt: string | null
}

/** Au-delà, le visiteur ne regarde plus : mieux vaut choisir. */
export const MAX_LISTING_MEDIA = 12

/** 10 Mo : une photo de téléphone, compressée dans le navigateur, en pèse moins d'un. */
export const LISTING_PHOTO_MAX_BYTES = 10 * 1024 * 1024
/**
 * 20 Mo : sous le plafond de 21 Mo d'un envoi (`next.config.ts`, nginx).
 * Une visite filmée de trente secondes à une minute, en 720p ou 1080p.
 */
export const LISTING_VIDEO_MAX_BYTES = 20 * 1024 * 1024
export const LISTING_PHOTO_MAX_DIMENSION = 10_000
export const LISTING_MEDIA_ALT_MAX = 200

/** Valeur de l'attribut `accept` du champ de fichier. */
export const LISTING_MEDIA_ACCEPT = 'image/*,video/mp4,video/webm'

export const listingMediaExtensions: Record<ListingMediaContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length))

export type DetectedVideo = { contentType: 'video/mp4' | 'video/webm' }

/**
 * MP4 : une boîte `ftyp` en tête. Une vidéo QuickTime (`.mov` d'iPhone,
 * marque `qt  `) a la même structure mais ne se lit pas dans Chrome ni
 * Firefox : refusée, l'écran demande de l'exporter en MP4.
 *
 * WebM : l'en-tête EBML, dont le type de document est `webm` (un Matroska
 * `.mkv` ne se lit pas partout).
 */
export function detectVideo(bytes: Uint8Array): DetectedVideo | 'quicktime' | undefined {
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    return ascii(bytes, 8, 4) === 'qt  ' ? 'quicktime' : { contentType: 'video/mp4' }
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return ascii(bytes, 0, Math.min(bytes.length, 64)).includes('webm')
      ? { contentType: 'video/webm' }
      : undefined
  }
  return undefined
}

export type ListingMediaFile = {
  bytes: Uint8Array
  kind: ListingMediaKind
  contentType: ListingMediaContentType
  width: number | null
  height: number | null
}

/**
 * Lit le fichier d'un formulaire. Rend le média vérifié, ou un message à
 * afficher tel quel au centre.
 */
export async function readListingMedia(
  value: FormDataEntryValue | null,
): Promise<{ media?: ListingMediaFile; error?: string }> {
  if (!value || typeof value === 'string' || value.size === 0) return { error: 'Aucun fichier reçu.' }
  const bytes = new Uint8Array(await value.arrayBuffer())
  return checkListingMedia(bytes)
}

export function checkListingMedia(bytes: Uint8Array): { media?: ListingMediaFile; error?: string } {
  const video = detectVideo(bytes)
  if (video === 'quicktime') {
    return { error: 'Les vidéos .mov ne se lisent pas sur tous les navigateurs. Exportez-la en MP4, puis ajoutez-la de nouveau.' }
  }
  if (video) {
    if (bytes.byteLength > LISTING_VIDEO_MAX_BYTES) {
      return { error: 'La vidéo dépasse 20 Mo. Raccourcissez-la ou exportez-la en 720p, puis ajoutez-la de nouveau.' }
    }
    return { media: { bytes, kind: 'video', contentType: video.contentType, width: null, height: null } }
  }

  const image = detectImage(bytes)
  if (!image) return { error: 'Seules les photos JPEG, PNG et WebP, et les vidéos MP4 et WebM, sont acceptées.' }
  if (bytes.byteLength > LISTING_PHOTO_MAX_BYTES) {
    return { error: 'La photo dépasse 10 Mo même après compression. Réduisez-la, puis ajoutez-la de nouveau.' }
  }
  if (
    image.width < 1 ||
    image.height < 1 ||
    image.width > LISTING_PHOTO_MAX_DIMENSION ||
    image.height > LISTING_PHOTO_MAX_DIMENSION
  ) {
    return { error: 'Les dimensions de cette photo sont illisibles ou dépassent 10 000 pixels.' }
  }
  return { media: { bytes, kind: 'photo', contentType: image.contentType, width: image.width, height: image.height } }
}

/** Rangée par centre et par annonce : une annonce retirée se retrouve d'un coup d'œil. */
export function listingMediaKey(
  tenantId: string,
  listingId: string,
  mediaId: string,
  contentType: ListingMediaContentType,
): string {
  return `annonces/${tenantId}/${listingId}/${mediaId}.${listingMediaExtensions[contentType]}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Relit la colonne JSON. Ce qui n'a pas la forme d'un média est écarté plutôt
 * que de casser la page publique (la colonne a d'abord été prévue pour une
 * liste de clés, restée vide : ADR 011).
 */
export function parseListingMedia(raw: unknown): ListingMedia[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (item): item is ListingMedia =>
      isRecord(item) &&
      typeof item.id === 'string' &&
      typeof item.key === 'string' &&
      (item.kind === 'photo' || item.kind === 'video') &&
      (listingMediaContentTypes as readonly unknown[]).includes(item.contentType),
  )
}

export type MediaMove = 'first' | 'earlier' | 'later'

/** Déplace un média ; la liste rendue est neuve, l'ordre des autres ne change pas. */
export function moveListingMedia(list: ListingMedia[], id: string, move: MediaMove): ListingMedia[] {
  const index = list.findIndex((media) => media.id === id)
  if (index === -1) return list
  const target = move === 'first' ? 0 : move === 'earlier' ? index - 1 : index + 1
  if (target < 0 || target >= list.length || target === index) return list
  const next = [...list]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved)
  return next
}

export function withoutListingMedia(list: ListingMedia[], id: string): ListingMedia[] {
  return list.filter((media) => media.id !== id)
}

/** Texte vide : plus de description, le titre de l'annonce en tiendra lieu. */
export function describeListingMedia(list: ListingMedia[], id: string, alt: string): ListingMedia[] {
  const value = alt.replace(/\s+/g, ' ').trim().slice(0, LISTING_MEDIA_ALT_MAX)
  return list.map((media) => (media.id === id ? { ...media, alt: value || null } : media))
}

/** La photo de couverture d'une carte du catalogue : la première photo, pas une vidéo. */
export function coverPhoto(list: ListingMedia[]): ListingMedia | undefined {
  return list.find((media) => media.kind === 'photo')
}

/** Texte alternatif affiché : celui du centre, sinon le titre et le rang. */
export function listingMediaAlt(media: ListingMedia, headline: string, index: number, total: number): string {
  if (media.alt) return media.alt
  const what = media.kind === 'video' ? 'Vidéo' : 'Photo'
  return total > 1 ? `${what} ${index + 1} sur ${total} — ${headline}` : `${what} — ${headline}`
}

/** Adresse publique d'un média, servie par l'application. */
export function listingMediaUrl(listingId: string, media: Pick<ListingMedia, 'id'>): string {
  return `/medias/annonces/${listingId}/${media.id}`
}

/**
 * En-tête `Range` accepté : une seule plage d'octets. Safari ne lit une
 * vidéo que si le serveur répond aux plages ; une forme inconnue est ignorée
 * et le fichier part en entier.
 */
export function singleByteRange(header: string | null): string | undefined {
  if (!header) return undefined
  const value = header.trim()
  return /^bytes=(\d+-\d*|-\d+)$/.test(value) ? value : undefined
}
