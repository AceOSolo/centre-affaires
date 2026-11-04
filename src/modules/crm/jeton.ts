import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Le jeton que le CRM présente au site (ADR 065).
 *
 * Généré à l'écran, montré une fois, puis oublié : la base n'en garde que
 * l'empreinte SHA-256. Un jeton tiré de 32 octets aléatoires n'a pas besoin
 * d'un hachage lent (il n'y a pas de dictionnaire à essayer) ; l'empreinte
 * suffit pour qu'une copie de la base n'ouvre pas l'API.
 *
 * En base64url : il passe tel quel dans une adresse (`?jeton=`, module Webhook
 * de Dolibarr, ADR 049), sans le « + » qui s'y lit comme une espace.
 */

/** 43 caractères, préfixés pour qu'on le reconnaisse dans une configuration. */
export function generateCrmToken(): string {
  return `crm_${randomBytes(32).toString('base64url')}`
}

/** Empreinte enregistrée en base : SHA-256, en hexadécimal minuscule. */
export function crmTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Deux secrets égaux ? À temps constant : la durée de la réponse ne doit pas
 * renseigner sur le nombre de caractères justes. Les longueurs différentes
 * sont égalisées par l'empreinte, comparée elle aussi à temps constant.
 */
export function sameSecret(given: string, expected: string): boolean {
  if (!given || !expected) return false
  const a = createHash('sha256').update(given, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/** Empreinte reçue égale à l'empreinte enregistrée, à temps constant. */
export function sameHash(givenHex: string, storedHex: string): boolean {
  const a = Buffer.from(givenHex, 'hex')
  const b = Buffer.from(storedHex, 'hex')
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b)
}

/**
 * Les jetons présentés par la requête, dans l'ordre où ils sont essayés :
 * `Authorization: Bearer …`, puis, pour les routes qui l'admettent, `?jeton=…`
 * dans l'adresse (le module Webhook de Dolibarr ne sait poser aucun en-tête,
 * ADR 049).
 *
 * Lus exactement comme avant l'écran (`lib/maintenance.ts`) : un connecteur
 * déjà branché ne doit rien voir changer.
 */
export function presentedTokens(request: Request, acceptQueryToken = false): string[] {
  const tokens: string[] = []
  const header = request.headers.get('authorization')
  if (header) tokens.push(header.replace(/^Bearer /, ''))
  if (acceptQueryToken) {
    // Un jeton en base64 standard (celui du serveur) collé tel quel dans
    // l'adresse : son « + » se lit comme une espace. Aucun jeton n'en contient.
    tokens.push((new URL(request.url).searchParams.get('jeton') ?? '').replaceAll(' ', '+'))
  }
  return [...new Set(tokens.filter((token) => token !== ''))]
}
