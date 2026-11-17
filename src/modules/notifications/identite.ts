import type { EmailLogo, NewTenant, Tenant } from '../../db/tenants.ts'
import type { EmailBranding } from './gabarit.ts'
import { emailLogoPath, logoDisplaySize } from './logo-courriels.ts'

/**
 * Identité du centre dans ses courriels (ADR 080) : ce que l'écran
 * Configuration règle — nom, téléphone, site, lignes de signature — et ce que
 * le gabarit en reçoit (`EmailBranding`).
 *
 * Module pur : l'action serveur valide ici avant d'écrire, le chargeur
 * (`identite-queries.ts`) y compose l'habillage (`identite.test.ts`).
 */

export const CENTRE_NAME_MAX = 120
export const PHONE_MAX = 30
export const WEBSITE_MAX = 200
/** La signature tient en quelques lignes courtes : elle se lit sur un téléphone. */
export const SIGNATURE_MAX_LINES = 6
export const SIGNATURE_LINE_MAX = 100
/** Longueur de `tenants.email_signature`. */
export const SIGNATURE_MAX = 600

/** Libellés des champs : à côté des champs et dans le résumé des erreurs. */
export const emailIdentityLabels: Record<string, string> = {
  name: 'Nom du centre',
  phone: 'Téléphone',
  websiteUrl: 'Site internet',
  emailSignature: 'Lignes de signature',
}

/** Colonnes de `tenants` qui font l'identité des courriels. */
export type BrandingIdentity = Pick<
  Tenant,
  | 'name'
  | 'addressLine1'
  | 'addressLine2'
  | 'postalCode'
  | 'city'
  | 'phone'
  | 'email'
  | 'websiteUrl'
  | 'logoPath'
  | 'emailLogo'
  | 'emailSignature'
>

/* ------------------------------------------------------------------------ */
/* Saisie                                                                   */
/* ------------------------------------------------------------------------ */

export type EmailIdentityInput = Record<string, string | undefined>
export type EmailIdentityUpdate = Pick<NewTenant, 'name' | 'phone' | 'websiteUrl' | 'emailSignature'>
export type EmailIdentityResult =
  | { ok: true; update: EmailIdentityUpdate }
  | { ok: false; fieldErrors: Record<string, string> }

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

const read = (input: EmailIdentityInput, key: string) => (input[key] ?? '').replace(CONTROL, '').trim()

/**
 * Adresse du site : `https://` ajouté quand il manque (« www.centre.fr »),
 * une adresse web lisible, d'un domaine à point. Rend l'adresse, `null` pour
 * un champ vide, `undefined` si elle est illisible.
 */
export function normalizeWebsite(value: string): string | null | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    if (!url.hostname.includes('.') || url.username || url.password) return undefined
    return url.toString().replace(/\/$/, url.pathname === '/' && !url.search && !url.hash ? '' : '/')
  } catch {
    return undefined
  }
}

/**
 * Lignes de signature saisies : sans blanc autour, sans ligne vide. Rend le
 * texte à enregistrer (`null` : signature automatique), ou l'erreur.
 */
export function normalizeSignature(value: string): { value: string | null } | { error: string } {
  const lines = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(CONTROL, '').trim())
    .filter((line) => line !== '')
  if (lines.length === 0) return { value: null }
  if (lines.length > SIGNATURE_MAX_LINES) {
    return { error: `${SIGNATURE_MAX_LINES} lignes au plus : la signature se lit aussi sur un téléphone.` }
  }
  const long = lines.findIndex((line) => line.length > SIGNATURE_LINE_MAX)
  if (long >= 0) return { error: `La ligne ${long + 1} dépasse ${SIGNATURE_LINE_MAX} caractères : coupez-la en deux.` }
  if (lines.some((line) => /^(?:—|–|--)$/.test(line))) {
    return { error: 'Une ligne faite d’un seul tiret ouvre la signature : retirez-la, le séparateur est déjà posé.' }
  }
  const text = lines.join('\n')
  return text.length > SIGNATURE_MAX ? { error: `${SIGNATURE_MAX} caractères au plus.` } : { value: text }
}

/** Valide le formulaire « Signature des courriels » de Configuration. */
export function parseEmailIdentity(input: EmailIdentityInput): EmailIdentityResult {
  const fieldErrors: Record<string, string> = {}

  const name = read(input, 'name').replace(/\s+/g, ' ')
  if (!name) fieldErrors.name = 'Saisissez le nom du centre : il signe chaque courriel.'
  else if (name.length > CENTRE_NAME_MAX) fieldErrors.name = `${CENTRE_NAME_MAX} caractères au plus.`

  const phone = read(input, 'phone').replace(/\s+/g, ' ')
  if (phone.length > PHONE_MAX) fieldErrors.phone = `${PHONE_MAX} caractères au plus.`
  else if (phone && (!/^[0-9+().\s-]+$/.test(phone) || (phone.match(/\d/g) ?? []).length < 6)) {
    fieldErrors.phone = 'Numéro illisible : des chiffres, des espaces, et « + » pour l’indicatif. Exemple : 04 28 35 09 31'
  }

  const website = normalizeWebsite(read(input, 'websiteUrl'))
  if (website === undefined) fieldErrors.websiteUrl = 'Adresse illisible. Exemple : www.centre.fr'
  else if (website && website.length > WEBSITE_MAX) fieldErrors.websiteUrl = `${WEBSITE_MAX} caractères au plus.`

  const signature = normalizeSignature(input.emailSignature ?? '')
  if ('error' in signature) fieldErrors.emailSignature = signature.error

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors }
  return {
    ok: true,
    update: {
      name,
      phone: phone || null,
      websiteUrl: website ?? null,
      emailSignature: 'value' in signature ? signature.value : null,
    },
  }
}

/** Valeurs de départ du formulaire. */
export function emailIdentityValues(tenant: BrandingIdentity): Record<string, string> {
  return {
    name: tenant.name,
    phone: tenant.phone ?? '',
    websiteUrl: tenant.websiteUrl ?? '',
    emailSignature: tenant.emailSignature ?? '',
  }
}

/* ------------------------------------------------------------------------ */
/* Signature                                                                */
/* ------------------------------------------------------------------------ */

const present = (value: string | null | undefined): string | null => {
  const trimmed = value?.replace(/\s+/g, ' ').trim()
  return trimmed ? trimmed : null
}

/**
 * Signature automatique : l'adresse du centre (réglée avec l'identité légale),
 * son téléphone et son adresse électronique, son site. Une donnée absente ne
 * laisse pas de ligne vide.
 */
export function automaticSignatureLines(identity: Omit<BrandingIdentity, 'name' | 'logoPath' | 'emailLogo' | 'emailSignature'>): string[] {
  const street = [present(identity.addressLine1), present(identity.addressLine2)].filter(Boolean).join(', ')
  const town = [present(identity.postalCode), present(identity.city)].filter(Boolean).join(' ')
  const contact = [present(identity.phone), present(identity.email)].filter(Boolean).join(' · ')
  return [street, town, contact, present(identity.websiteUrl) ?? ''].filter((line) => line !== '')
}

/** Lignes de signature : celles saisies, sinon la signature automatique. */
export function signatureLinesOf(identity: BrandingIdentity): string[] {
  const custom = identity.emailSignature?.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean)
  return custom && custom.length > 0 ? custom : automaticSignatureLines(identity)
}

/* ------------------------------------------------------------------------ */
/* Habillage                                                                */
/* ------------------------------------------------------------------------ */

export type LogoSource = 'courriels' | 'site' | 'aucun'

/** D'où vient le logo des courriels, et son adresse sur le site. */
export function logoOf(identity: Pick<BrandingIdentity, 'logoPath' | 'emailLogo'>): {
  source: LogoSource
  path: string | null
  emailLogo: EmailLogo | null
} {
  if (identity.emailLogo) return { source: 'courriels', path: emailLogoPath(identity.emailLogo), emailLogo: identity.emailLogo }
  // Le logo du site n'est pris que s'il est servi par le site lui-même.
  if (identity.logoPath && /^\/(?!\/)/.test(identity.logoPath)) {
    return { source: 'site', path: identity.logoPath, emailLogo: null }
  }
  return { source: 'aucun', path: null, emailLogo: null }
}

export type BrandingContext = {
  /** Adresse publique d'un chemin du site, ou nul quand elle ne peut pas servir le logo. */
  publicUrl: (path: string) => string | null
  /** Origines dont les liens deviennent des boutons. */
  linkOrigins: readonly string[]
  /** Dimensions du logo du site, lues dans son fichier ; nulles si illisibles. */
  siteLogoSize?: { width: number; height: number } | null
}

/** L'habillage des courriels d'un centre, à partir de sa ligne `tenants`. */
export function brandingOf(identity: BrandingIdentity, context: BrandingContext): EmailBranding {
  const logo = logoOf(identity)
  const url = logo.path ? context.publicUrl(logo.path) : null
  const natural = logo.emailLogo ?? context.siteLogoSize ?? null
  const size = logoDisplaySize(natural?.width, natural?.height)
  return {
    centreName: identity.name,
    logo: url ? { url, width: size?.width ?? null, height: size?.height ?? null } : null,
    signatureLines: signatureLinesOf(identity),
    linkOrigins: context.linkOrigins,
  }
}
