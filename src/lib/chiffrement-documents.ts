import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Chiffrement au repos des documents déposés dans le stockage objet : scans de
 * courrier et photos d'enveloppe aujourd'hui, photos d'états des lieux demain
 * (R22, ADR 020).
 *
 * Une branche Neon copie le stockage de sa branche parente. Chiffrés avec une
 * clé propre à chaque environnement, les documents de production y sont
 * illisibles (bloquant B3). Le fournisseur de stockage, lui, ne voit jamais
 * que du chiffré.
 *
 * AES-256-GCM, comme `sealSecret` : authentifié, donc un document altéré est
 * refusé au lieu d'être rendu faux. Tout vient de `node:crypto`.
 *
 * Format de l'objet stocké, autoportant (ADR 020) :
 *
 *   « CAD1 » (4 octets) · version de clé (2 octets, gros-boutiste)
 *   · vecteur d'initialisation (12) · chiffré · étiquette d'authentification (16)
 *
 * L'en-tête et la clé de l'objet dans le stockage sont authentifiés avec le
 * contenu (données associées) : un chiffré déplacé sous la clé d'un autre
 * document, ou dont on a changé la version, est refusé comme altéré.
 */

const ALGORITHM = 'aes-256-gcm'
/** Aucun PDF, JPEG ou PNG — les seuls types acceptés au dépôt — ne commence ainsi. */
const MAGIC = Buffer.from('CAD1', 'ascii')
const VERSION_BYTES = 2
const IV_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = MAGIC.length + VERSION_BYTES + IV_BYTES

/** `mail_scans.encryption_key_version` est un `smallint` strictement positif. */
const MAX_KEY_VERSION = 32767

const KEY_VARIABLE = 'DOCUMENTS_ENCRYPTION_KEY'
const VERSION_VARIABLE = 'DOCUMENTS_ENCRYPTION_KEY_VERSION'
/** Clés précédentes, gardées le temps de la rotation : `DOCUMENTS_ENCRYPTION_KEY_1`… */
const PREVIOUS_KEY = /^DOCUMENTS_ENCRYPTION_KEY_(\d+)$/

/** Configuration des clés absente, invalide, ou version demandée inconnue. */
export class DocumentKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentKeyError'
  }
}

/**
 * Le document stocké n'est pas celui qui a été déposé : altéré, tronqué,
 * déplacé, ou chiffré avec une autre clé que celle que la base désigne.
 */
export class DocumentIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentIntegrityError'
  }
}

/**
 * Trousseau : la clé courante, qui chiffre tout nouveau dépôt, et les clés
 * précédentes, qui ne servent plus qu'à relire les objets pas encore
 * rechiffrés.
 */
export type DocumentKeyring = {
  currentVersion: number
  keys: ReadonlyMap<number, Buffer>
}

function parseVersion(raw: string, variable: string): number {
  const version = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isInteger(version) || version < 1 || version > MAX_KEY_VERSION) {
    throw new DocumentKeyError(
      `${variable} invalide : un entier entre 1 et ${MAX_KEY_VERSION} (1 pour la première clé).`,
    )
  }
  return version
}

function parseDocumentKey(base64: string | undefined, variable: string): Buffer {
  const key = Buffer.from(base64?.trim() ?? '', 'base64')
  if (key.length !== 32) {
    throw new DocumentKeyError(
      `${variable} manquante ou invalide : 32 octets en base64 (\`openssl rand -base64 32\`).`,
    )
  }
  return key
}

/**
 * Lit le trousseau dans l'environnement :
 *
 * - `DOCUMENTS_ENCRYPTION_KEY` : la clé courante ;
 * - `DOCUMENTS_ENCRYPTION_KEY_VERSION` : son numéro, inscrit sur chaque objet ;
 * - `DOCUMENTS_ENCRYPTION_KEY_<N>` : les clés précédentes, pendant une rotation.
 */
export function documentKeyringFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DocumentKeyring {
  const rawVersion = env[VERSION_VARIABLE]?.trim()
  if (!rawVersion) {
    throw new DocumentKeyError(
      `${VERSION_VARIABLE} manquante : le numéro de la clé courante (1 pour la première clé).`,
    )
  }
  const currentVersion = parseVersion(rawVersion, VERSION_VARIABLE)
  const current = parseDocumentKey(env[KEY_VARIABLE], KEY_VARIABLE)

  const keys = new Map<number, Buffer>([[currentVersion, current]])
  for (const [name, value] of Object.entries(env)) {
    const match = PREVIOUS_KEY.exec(name)
    if (!match) continue
    const version = parseVersion(match[1], name)
    const key = parseDocumentKey(value, name)
    // Deux clés pour un même numéro : on ne saurait plus laquelle a chiffré
    // quoi. C'est l'oubli typique d'une rotation (ancienne clé recopiée sans
    // changer le numéro de la courante).
    if (version === currentVersion && !key.equals(current)) {
      throw new DocumentKeyError(
        `${name} diffère de ${KEY_VARIABLE} alors que ${VERSION_VARIABLE} vaut ${currentVersion} : ` +
          'en rotation, la nouvelle clé prend un nouveau numéro.',
      )
    }
    keys.set(version, key)
  }
  return { currentVersion, keys }
}

function header(version: number, iv: Buffer): Buffer {
  const versionBytes = Buffer.alloc(VERSION_BYTES)
  versionBytes.writeUInt16BE(version)
  return Buffer.concat([MAGIC, versionBytes, iv])
}

/** Données associées : l'en-tête, et la clé de l'objet dans le stockage. */
function associatedData(head: Buffer, objectKey: string): Buffer {
  return Buffer.concat([head, Buffer.from(objectKey, 'utf8')])
}

/** L'objet porte-t-il l'en-tête d'un document chiffré ? */
export function isSealedDocument(stored: Uint8Array): boolean {
  return (
    stored.byteLength >= HEADER_BYTES + TAG_BYTES &&
    Buffer.from(stored.buffer, stored.byteOffset, MAGIC.length).equals(MAGIC)
  )
}

/** Version de clé inscrite dans l'en-tête, ou `undefined` pour un objet en clair. */
export function sealedKeyVersion(stored: Uint8Array): number | undefined {
  if (!isSealedDocument(stored)) return undefined
  return Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength).readUInt16BE(MAGIC.length)
}

/**
 * Chiffre un document avec la clé courante, pour le déposer sous `objectKey`.
 *
 * La version rendue est à inscrire en base avec l'objet
 * (`mail_scans.encryption_key_version`).
 */
export function sealDocument(
  plain: Uint8Array,
  objectKey: string,
  keyring: DocumentKeyring = documentKeyringFromEnv(),
): { bytes: Buffer; keyVersion: number } {
  const keyVersion = keyring.currentVersion
  const key = keyring.keys.get(keyVersion)
  if (!key) throw new DocumentKeyError(`Clé courante (version ${keyVersion}) absente du trousseau.`)

  const iv = randomBytes(IV_BYTES)
  const head = header(keyVersion, iv)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(associatedData(head, objectKey))
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  return { bytes: Buffer.concat([head, encrypted, cipher.getAuthTag()]), keyVersion }
}

/**
 * Rend le document en clair, tel qu'il a été déposé.
 *
 * `keyVersion` est celle que la base désigne pour l'objet :
 *
 * - `null` : objet déposé avant le chiffrement, rendu tel quel. S'il porte
 *   pourtant l'en-tête, c'est qu'une reprise a été interrompue entre
 *   l'écriture du chiffré et celle de la base : il est déchiffré, et
 *   authentifié, avec la version de son en-tête ;
 * - `N` : l'objet doit être chiffré avec la clé N. Un objet en clair, d'une
 *   autre version, ou dont l'authentification échoue, est refusé.
 *
 * Le trousseau n'est lu que si l'objet est chiffré : un objet hérité en clair
 * se relit sans clé configurée.
 */
export function openDocument(
  stored: Uint8Array,
  keyVersion: number | null,
  objectKey: string,
  keyring?: DocumentKeyring,
): Uint8Array {
  const sealedVersion = sealedKeyVersion(stored)
  if (keyVersion === null) {
    if (sealedVersion === undefined) return stored
    keyVersion = sealedVersion
  }

  if (sealedVersion === undefined) {
    throw new DocumentIntegrityError(
      `Document illisible (${objectKey}) : la base l'indique chiffré, le stockage le rend en clair ou tronqué.`,
    )
  }
  if (sealedVersion !== keyVersion) {
    throw new DocumentIntegrityError(
      `Document illisible (${objectKey}) : chiffré avec la clé ${sealedVersion}, la base attend la clé ${keyVersion}.`,
    )
  }

  const key = (keyring ?? documentKeyringFromEnv()).keys.get(keyVersion)
  if (!key) {
    throw new DocumentKeyError(
      `Clé de chiffrement des documents version ${keyVersion} absente de cet environnement ` +
        `(${KEY_VARIABLE}, ou ${KEY_VARIABLE}_${keyVersion} pendant une rotation).`,
    )
  }

  const bytes = Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength)
  const head = bytes.subarray(0, HEADER_BYTES)
  const iv = head.subarray(MAGIC.length + VERSION_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAAD(associatedData(head, objectKey))
  decipher.setAuthTag(bytes.subarray(bytes.byteLength - TAG_BYTES))
  try {
    return Buffer.concat([
      decipher.update(bytes.subarray(HEADER_BYTES, bytes.byteLength - TAG_BYTES)),
      decipher.final(),
    ])
  } catch {
    // GCM ne distingue pas une altération d'une mauvaise clé : dans les deux
    // cas, ce n'est pas le document déposé, et il ne sort pas.
    throw new DocumentIntegrityError(
      `Document refusé (${objectKey}) : son contenu a été altéré, ou il a été chiffré avec une autre clé.`,
    )
  }
}
