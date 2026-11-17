import type { EmailLogo } from '../../db/tenants.ts'
import { isUuid } from '../../lib/uuid.ts'
import { detectImage } from '../etats-des-lieux/photos.ts'

/**
 * Logo de l'en-tête des courriels (ADR 080) : vérification du fichier déposé,
 * rangement dans le stockage, adresse publique, taille d'affichage.
 *
 * Le logo est **servi par le site**, en HTTPS, jamais joint au message : une
 * pièce jointe alourdit chaque envoi et finit souvent dans les indésirables,
 * et une image hébergée chez un tiers lui livrerait l'adresse IP de chaque
 * lecteur (ADR 004).
 *
 * Le type est lu dans les octets, jamais dans ce que déclare le navigateur :
 * le fichier est servi au public avec ce type, depuis notre domaine. Un SVG
 * est du texte qui peut porter des scripts ou appeler un autre site : il est
 * refusé s'il en contient (`unsafeSvg`), et servi sous une politique de
 * sécurité qui n'en exécuterait de toute façon aucun.
 *
 * Module pur, sans base ni stockage : `logo-courriels.test.ts`.
 */

export type EmailLogoContentType = EmailLogo['contentType']

export const emailLogoExtensions: Record<EmailLogoContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
}

/** 1 Mo : un logo bien exporté pèse quelques dizaines de kilo-octets. */
export const EMAIL_LOGO_MAX_BYTES = 1024 * 1024
export const EMAIL_LOGO_MAX_DIMENSION = 10_000

/** Valeur de l'attribut `accept` du champ de fichier. */
export const EMAIL_LOGO_ACCEPT = 'image/png,image/jpeg,image/svg+xml,.svg'

/**
 * Cadre du logo dans l'en-tête : 56 px de haut au plus (la hauteur d'un bouton
 * et demi, assez pour lire la signature d'un logo), 220 px de large au plus
 * pour un logo très allongé.
 */
export const EMAIL_LOGO_MAX_HEIGHT = 56
export const EMAIL_LOGO_MAX_WIDTH = 220

/** Taille d'affichage dans le cadre, proportions gardées. Nulle si les dimensions sont illisibles. */
export function logoDisplaySize(
  width: number | null | undefined,
  height: number | null | undefined,
): { width: number; height: number } | null {
  if (!width || !height || !(width > 0) || !(height > 0)) return null
  const scale = Math.min(EMAIL_LOGO_MAX_HEIGHT / height, EMAIL_LOGO_MAX_WIDTH / width)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/* ------------------------------------------------------------------------ */
/* SVG                                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Un SVG : du texte UTF-8 dont la racine est `<svg>`, précédée au plus d'une
 * déclaration XML, de commentaires et d'un `DOCTYPE` sans sous-ensemble
 * interne (qui permettrait de déclarer des entités). Rend le texte, ou rien.
 */
export function readSvg(bytes: Uint8Array): string | undefined {
  // Un fichier binaire (PNG, PDF) n'est pas du SVG : pas d'octet nul dans du texte.
  if (bytes.includes(0)) return undefined
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '')
  const prolog = /^\s*(?:<\?xml[^>]*\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE\s+svg[^>[]*>\s*)*<svg[\s>]/i
  return prolog.test(text) ? text : undefined
}

/**
 * Ce qu'un logo n'a pas à contenir : scripts et gestionnaires d'événements,
 * contenu HTML embarqué, entités, et toute référence hors du fichier — sauf
 * une image intégrée (`data:image/…`), courante dans les exports.
 */
const UNSAFE_SVG: readonly RegExp[] = [
  /<script/i,
  /<foreignObject/i,
  /<(?:iframe|embed|object|audio|video)\b/i,
  /<!ENTITY/i,
  /\son[a-z]+\s*=/i,
  /javascript\s*:/i,
  /@import/i,
  /(?:href|src)\s*=\s*["']?\s*(?!#|data:image\/)[^\s"'>]/i,
  /url\(\s*["']?\s*(?!#|data:image\/)/i,
]

export function unsafeSvg(svg: string): boolean {
  return UNSAFE_SVG.some((pattern) => pattern.test(svg))
}

/** Longueur d'un attribut `width` / `height` : un nombre, en pixels ou sans unité. */
function svgLength(value: string | undefined): number | undefined {
  const match = /^\s*(\d*\.?\d+)\s*(?:px)?\s*$/i.exec(value ?? '')
  const number = match ? Number(match[1]) : NaN
  return Number.isFinite(number) && number > 0 ? number : undefined
}

/**
 * Dimensions d'un SVG : `width` et `height` de la racine quand ils sont en
 * pixels, sinon la `viewBox`. Une valeur en `mm` ou en `%` ne dit rien de la
 * proportion : la `viewBox` la remplace.
 */
export function svgSize(svg: string): { width: number; height: number } | undefined {
  const root = /<svg\b([^>]*)>/i.exec(svg)?.[1]
  if (root === undefined) return undefined
  const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root)?.[1]

  const width = svgLength(attribute('width'))
  const height = svgLength(attribute('height'))
  if (width && height) return { width, height }

  const box = attribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  if (box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
    return { width: box[2], height: box[3] }
  }
  return undefined
}

/* ------------------------------------------------------------------------ */
/* Fichier déposé                                                           */
/* ------------------------------------------------------------------------ */

export type CheckedEmailLogo = { contentType: EmailLogoContentType; width: number; height: number }

/**
 * Vérifie le logo déposé : PNG, JPEG ou SVG sans contenu actif, 1 Mo au plus,
 * dimensions lisibles. Rend le logo, ou un message à afficher tel quel.
 */
export function checkEmailLogo(bytes: Uint8Array): { logo?: CheckedEmailLogo; error?: string } {
  if (bytes.byteLength === 0) return { error: 'Aucun fichier reçu : choisissez le fichier du logo.' }
  if (bytes.byteLength > EMAIL_LOGO_MAX_BYTES) {
    return { error: 'Le logo dépasse 1 Mo. Exportez-le plus petit (500 pixels de large suffisent), puis déposez-le de nouveau.' }
  }

  const image = detectImage(bytes)
  if (image) {
    if (image.contentType === 'image/webp') {
      return { error: 'Les logos WebP ne s’affichent pas dans Outlook. Enregistrez le logo en PNG, puis déposez-le de nouveau.' }
    }
    if (
      image.width < 1 ||
      image.height < 1 ||
      image.width > EMAIL_LOGO_MAX_DIMENSION ||
      image.height > EMAIL_LOGO_MAX_DIMENSION
    ) {
      return { error: 'Les dimensions de ce logo sont illisibles ou dépassent 10 000 pixels.' }
    }
    return { logo: { contentType: image.contentType, width: image.width, height: image.height } }
  }

  const svg = readSvg(bytes)
  if (!svg) return { error: 'Seuls les logos PNG, JPEG ou SVG sont acceptés.' }
  if (unsafeSvg(svg)) {
    return {
      error:
        'Ce SVG contient un script ou un lien vers un autre site, que les messageries refusent. ' +
        'Exportez-le de nouveau en « SVG simple », ou déposez le logo en PNG.',
    }
  }
  const size = svgSize(svg)
  if (!size) {
    return { error: 'Les dimensions de ce SVG sont illisibles : il lui faut un attribut viewBox, ou width et height en pixels.' }
  }
  return {
    logo: {
      contentType: 'image/svg+xml',
      width: Math.max(1, Math.round(size.width)),
      height: Math.max(1, Math.round(size.height)),
    },
  }
}

/* ------------------------------------------------------------------------ */
/* Rangement et adresse                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Clé dans le stockage objet. Un logo remplacé n'est pas effacé : les
 * courriels déjà reçus continuent de l'afficher.
 */
export function emailLogoKey(tenantId: string, id: string, contentType: EmailLogoContentType): string {
  return `centre/${tenantId}/logo-courriels/${id}.${emailLogoExtensions[contentType]}`
}

/** Adresse du logo sur le site, à rendre absolue avec l'adresse publique (`APP_URL`). */
export function emailLogoPath(logo: Pick<EmailLogo, 'id' | 'contentType'>): string {
  return `/medias/centre/logo/${logo.id}.${emailLogoExtensions[logo.contentType]}`
}

/** Nom de fichier de l'adresse publique — `<identifiant>.<extension>` —, ou rien. */
export function parseEmailLogoFile(name: string): { id: string; contentType: EmailLogoContentType } | undefined {
  const match = /^([0-9a-f-]{36})\.(png|jpg|svg)$/i.exec(name)
  if (!match || !isUuid(match[1].toLowerCase())) return undefined
  const extension = match[2].toLowerCase()
  const contentType = (Object.keys(emailLogoExtensions) as EmailLogoContentType[]).find(
    (type) => emailLogoExtensions[type] === extension,
  )
  return contentType ? { id: match[1].toLowerCase(), contentType } : undefined
}

/**
 * En-têtes de la réponse qui sert le logo. Public et gardé un an : un logo ne
 * change jamais sous le même identifiant, en déposer un autre en crée un
 * nouveau. La politique de sécurité n'exécute rien, même ouvert seul dans un
 * onglet : un SVG reste une image.
 */
export function emailLogoHeaders(contentType: EmailLogoContentType, byteLength: number): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Length': String(byteLength),
    'Content-Disposition': `inline; filename="logo.${emailLogoExtensions[contentType]}"`,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  }
}
