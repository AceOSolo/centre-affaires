import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { eq } from 'drizzle-orm'

import { withTenant, type Database, type Transaction } from '../../db/index.ts'
import { tenants } from '../../db/tenants.ts'
import { isLoopbackHost, sendMessage, type Message, type SendResult } from '../../lib/courriel.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { detectImage } from '../etats-des-lieux/photos.ts'
import { brandMessage, type EmailBranding } from './gabarit.ts'
import { brandingOf, type BrandingIdentity } from './identite.ts'
import { readSvg, svgSize } from './logo-courriels.ts'

/**
 * Habillage des courriels d'un centre (ADR 080), lu en base : nom,
 * coordonnées, logo, signature. Le moteur (`moteur.ts`) le joint à chaque
 * message ; les courriels de l'authentification et l'essai d'envoi passent
 * par `sendBrandedMessage`.
 */

type Env = Record<string, string | undefined>

/**
 * Adresse publique d'un chemin du site : `APP_URL` en **HTTPS**, celle de la
 * production. Un logo ne se sert pas en clair : une messagerie le bloquerait,
 * ou le montrerait comme peu sûr. Seule exception, l'adresse locale du
 * développement, que le capteur Mailpit affiche (ADR 059).
 */
export function publicAddress(pathname: string, env: Env = process.env): string | null {
  const base = env.APP_URL?.trim()
  if (!base) return null
  try {
    const url = new URL(pathname, base)
    if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))) return url.toString()
  } catch {
    // Adresse publique illisible : pas de logo plutôt qu'une image cassée.
  }
  return null
}

/** Origine du site : ses liens deviennent des boutons dans les courriels. */
export function siteOrigins(env: Env = process.env): string[] {
  const base = env.APP_URL?.trim()
  if (!base) return []
  try {
    return [new URL(base).origin]
  } catch {
    return []
  }
}

const siteLogoSizes = new Map<string, { width: number; height: number } | null>()

/**
 * Dimensions du logo du site (`tenants.logo_path`, dans `public/`), lues une
 * fois dans son fichier : Outlook n'affiche une image à la bonne taille que
 * par ses attributs `width` et `height`.
 */
export async function siteLogoSize(logoPath: string): Promise<{ width: number; height: number } | null> {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(logoPath) || logoPath.split('/').includes('..')) return null
  if (siteLogoSizes.has(logoPath)) return siteLogoSizes.get(logoPath) ?? null
  let size: { width: number; height: number } | null = null
  try {
    const bytes = new Uint8Array(await readFile(path.join(process.cwd(), 'public', logoPath)))
    const image = detectImage(bytes)
    const svg = image ? undefined : readSvg(bytes)
    size = image ? { width: image.width, height: image.height } : svg ? (svgSize(svg) ?? null) : null
  } catch {
    size = null
  }
  siteLogoSizes.set(logoPath, size)
  return size
}

const identityColumns = {
  name: tenants.name,
  addressLine1: tenants.addressLine1,
  addressLine2: tenants.addressLine2,
  postalCode: tenants.postalCode,
  city: tenants.city,
  phone: tenants.phone,
  email: tenants.email,
  websiteUrl: tenants.websiteUrl,
  logoPath: tenants.logoPath,
  emailLogo: tenants.emailLogo,
  emailSignature: tenants.emailSignature,
}

export type BrandingOptions = {
  env?: Env
  /**
   * Logo en adresse relative au site : l'aperçu de Configuration, affiché par
   * le site lui-même, le montre même sans `APP_URL` en HTTPS.
   */
  relativeLogo?: boolean
}

/** Habillage d'un centre déjà lu (`currentTenant()`). */
export async function brandingFromIdentity(
  identity: BrandingIdentity,
  options: BrandingOptions = {},
): Promise<EmailBranding> {
  const env = options.env ?? process.env
  const siteSize = !identity.emailLogo && identity.logoPath ? await siteLogoSize(identity.logoPath) : null
  return brandingOf(identity, {
    publicUrl: options.relativeLogo ? (pathname) => pathname : (pathname) => publicAddress(pathname, env),
    linkOrigins: siteOrigins(env),
    siteLogoSize: siteSize,
  })
}

/** Habillage du centre, lu dans la transaction de l'appelant. */
export async function loadEmailBranding(
  tx: Transaction,
  tenantId: string,
  options: BrandingOptions = {},
): Promise<EmailBranding> {
  const [identity] = await tx.select(identityColumns).from(tenants).where(eq(tenants.id, tenantId))
  if (!identity) throw new Error(`Centre ${tenantId} introuvable : pas d’habillage des courriels.`)
  return brandingFromIdentity(identity, options)
}

/**
 * Envoie un message hors du moteur — mot de passe oublié, confirmation
 * d'adresse, essai d'envoi — aux couleurs du centre. Ne lève jamais, comme
 * `sendMessage` : un habillage illisible laisse partir le texte seul.
 */
export async function sendBrandedMessage(
  message: Message,
  options: { database?: Database; tenantId?: string } = {},
): Promise<SendResult> {
  let branded: Message = message
  try {
    const tenantId = options.tenantId ?? currentTenantId()
    const branding = await withTenant(tenantId, (tx) => loadEmailBranding(tx, tenantId), options.database)
    branded = { ...message, ...brandMessage({ subject: message.subject, text: message.text }, branding) }
  } catch (error) {
    console.error(`Courriel « ${message.subject} » envoyé sans mise en page`, error)
  }
  return sendMessage(branded)
}
