import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import type { CrmHttp } from './connecteurs.ts'

/**
 * L'adresse du CRM, et l'appel que le site y fait (ADR 065).
 *
 * C'est la direction d'un centre qui saisit l'adresse ; le serveur l'appelle.
 * Le jour où d'autres centres se branchent, une adresse mal intentionnée ne
 * doit pas faire du site une porte vers son propre réseau (base MySQL, nginx,
 * métadonnées de l'hébergeur). D'où :
 *
 * - **https seulement**, sans identifiant dans l'adresse ;
 * - **adresse publique seulement** : ni `localhost`, ni adresse privée,
 *   locale, de lien ou réservée, saisie en clair ou obtenue par le DNS ;
 * - **aucune redirection suivie**, un **délai court**, et une réponse dont on
 *   ne lit qu'un extrait.
 *
 * Reste possible : un DNS qui répond une adresse publique au contrôle puis une
 * adresse privée à l'appel (rebond DNS). L'appel ne rapporte qu'un code et une
 * version : il ne servirait qu'à sonder, pas à lire.
 */

export const CRM_BASE_URL_MAX_LENGTH = 500

export type BaseUrlCheck = { ok: true; url: string } | { ok: false; message: string }

/** Adresse saisie à l'écran, normalisée : https, sans barre finale, sans paramètre. */
export function parseCrmBaseUrl(raw: string): BaseUrlCheck {
  const text = raw.trim()
  if (!text) return { ok: false, message: 'Saisissez l’adresse du CRM.' }
  if (text.length > CRM_BASE_URL_MAX_LENGTH) {
    return { ok: false, message: `${CRM_BASE_URL_MAX_LENGTH} caractères au plus.` }
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, message: 'Adresse illisible : attendu https://… .' }
  }
  if (url.protocol !== 'https:') return { ok: false, message: 'L’adresse commence par https:// : le jeton et la clé ne circulent jamais en clair.' }
  if (url.username || url.password) return { ok: false, message: 'Pas d’identifiant dans l’adresse : la clé se saisit à part.' }
  if (url.search || url.hash) return { ok: false, message: 'L’adresse du CRM, sans « ? » ni « # ».' }
  if (isForbiddenHost(url.hostname)) {
    return { ok: false, message: 'Adresse locale ou privée refusée : le CRM doit être joignable sur Internet.' }
  }
  const path = url.pathname.replace(/\/+$/, '')
  return { ok: true, url: `${url.origin}${path}` }
}

/** Nom d'hôte refusé tel qu'il est écrit, avant toute résolution. */
function isForbiddenHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true
  }
  return isIP(host) !== 0 && isPrivateAddress(host)
}

/**
 * Adresse IP non publique : boucle, privée, partagée (CGNAT), de lien,
 * multidiffusion, réservée, et leurs équivalents IPv6 (y compris une IPv4
 * glissée dans une IPv6).
 */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) return isPrivateIpv4(address)
  if (kind !== 6) return true
  const groups = expandIpv6(address.toLowerCase())
  if (!groups) return true
  const [g0, g1, g2, , g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number]
  const zeroUpTo = (n: number) => groups.slice(0, n).every((group) => group === 0)
  /** L'IPv4 portée par deux groupes. */
  const ipv4 = (high: number, low: number) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
  if (zeroUpTo(8)) return true // ::
  if (zeroUpTo(7) && g7 === 1) return true // ::1
  // IPv4 glissée dans une IPv6 (`::ffff:a.b.c.d`, que l'analyseur d'adresse
  // réécrit `::ffff:7f00:1`), traduite ou « compatible » : jugée comme IPv4.
  if (zeroUpTo(5) && g5 === 0xffff) return isPrivateIpv4(ipv4(g6, g7))
  if (zeroUpTo(4) && g4 === 0xffff && g5 === 0) return isPrivateIpv4(ipv4(g6, g7))
  if (zeroUpTo(6)) return isPrivateIpv4(ipv4(g6, g7))
  if (g0 === 0x2002) return isPrivateIpv4(ipv4(g1, g2)) // 6to4
  if (g0 === 0x0064 && g1 === 0xff9b) return true // NAT64 : une IPv4 derrière
  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7, adresses locales uniques
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10, lien local
  if ((g0 & 0xff00) === 0xff00) return true // ff00::/8, multidiffusion
  if (g0 === 0x2001 && g1 === 0x0db8) return true // 2001:db8::/32, documentation
  return false
}

function isPrivateIpv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number) as [number, number, number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

/** Les huit groupes d'une IPv6, ou `undefined` si elle est illisible. */
function expandIpv6(raw: string): number[] | undefined {
  // Une IPv4 en fin d'adresse (`::ffff:1.2.3.4`) devient ses deux groupes.
  const dotted = raw.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  let address = raw
  if (dotted) {
    if (isIP(dotted[2]!) !== 4) return undefined
    const [a, b, c, d] = dotted[2]!.split('.').map(Number) as [number, number, number, number]
    address = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = '', tail, extra] = address.split('::')
  if (extra !== undefined) return undefined
  const parse = (part: string) => (part ? part.split(':').map((group) => parseInt(group, 16)) : [])
  const left = parse(head)
  const right = tail === undefined ? [] : parse(tail)
  const missing = 8 - left.length - right.length
  if (tail === undefined ? missing !== 0 : missing < 1) return undefined
  const groups = [...left, ...Array<number>(tail === undefined ? 0 : missing).fill(0), ...right]
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : undefined
}

/** Résolution du nom, injectable pour les tests. */
export type Resolver = (hostname: string) => Promise<string[]>

const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)

/** Délai d'un appel sortant, en millisecondes. */
export const CRM_HTTP_TIMEOUT_MS = 8000
/** Ce que l'appel lit de la réponse, au plus : de quoi trouver une version. */
const MAX_BODY_BYTES = 16 * 1024

/** Échec d'un appel sortant, avec la phrase que l'écran affiche. */
export class CrmCallError extends Error {}

/**
 * L'appel sortant sous garde : l'hôte est résolu et chacune de ses adresses
 * doit être publique, la redirection n'est pas suivie (son code est rendu tel
 * quel), le délai est court, la réponse est lue sur 16 Kio au plus.
 */
export function guardedHttp(options: { resolve?: Resolver; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): CrmHttp {
  const resolve = options.resolve ?? systemResolver
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? CRM_HTTP_TIMEOUT_MS
  return async (target, headers) => {
    const url = new URL(target)
    if (url.protocol !== 'https:') throw new CrmCallError('Appel refusé : https seulement.')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (isForbiddenHost(url.hostname)) throw new CrmCallError('Adresse locale ou privée refusée.')
    if (isIP(host) === 0) {
      let addresses: string[]
      try {
        addresses = await resolve(host)
      } catch {
        throw new CrmCallError(`Nom inconnu : « ${host} » ne se résout pas.`)
      }
      if (addresses.length === 0) throw new CrmCallError(`Nom inconnu : « ${host} » ne se résout pas.`)
      if (addresses.some(isPrivateAddress)) {
        throw new CrmCallError(`« ${host} » mène à une adresse privée : appel refusé.`)
      }
    }
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const name = (error as { name?: string })?.name
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new CrmCallError(`Pas de réponse du CRM en ${Math.round(timeoutMs / 1000)} s.`)
      }
      throw new CrmCallError('CRM injoignable : connexion impossible (adresse, certificat ou pare-feu).')
    }
    return {
      status: response.status,
      text: () => readLimited(response),
    }
  }
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < MAX_BODY_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString('utf8')
}
