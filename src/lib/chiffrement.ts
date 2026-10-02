import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Chiffrement des secrets confiés par un tiers — aujourd'hui le jeton Google
 * Agenda du centre (ADR 014).
 *
 * Une branche Neon copie les données de sa branche parente : un jeton en clair
 * en production se retrouverait dans chaque branche de développement, et avec
 * lui l'accès à l'agenda du centre. Chiffré avec une clé propre à chaque
 * environnement, il y est illisible.
 *
 * AES-256-GCM : authentifié, donc un chiffré altéré est refusé au lieu d'être
 * déchiffré en un jeton faux. Tout vient de `node:crypto`, aucune dépendance.
 */

const ALGORITHM = 'aes-256-gcm'
const VERSION = 'v1'

/** La clé attendue : 32 octets en base64, `openssl rand -base64 32`. */
export function parseKey(base64: string | undefined): Buffer {
  const key = Buffer.from(base64 ?? '', 'base64')
  if (key.length !== 32) {
    throw new Error(
      'SECRETS_ENCRYPTION_KEY manquante ou invalide : 32 octets en base64 (`openssl rand -base64 32`).',
    )
  }
  return key
}

function keyFromEnv(): Buffer {
  return parseKey(process.env.SECRETS_ENCRYPTION_KEY)
}

/** `v1:<iv>:<tag>:<chiffré>`, en base64url. La version permet de changer d'algorithme plus tard. */
export function sealSecret(plain: string, key: Buffer = keyFromEnv()): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [VERSION, iv, cipher.getAuthTag(), encrypted]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join(':')
}

export function openSecret(sealed: string, key: Buffer = keyFromEnv()): string {
  const [version, iv, tag, encrypted] = sealed.split(':')
  if (version !== VERSION || !iv || !tag || encrypted === undefined) {
    throw new Error('Secret chiffré illisible.')
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}
