import { randomBytes } from 'node:crypto'

/**
 * Les identifiants viennent de l'URL ou d'un champ caché. Un texte qui n'est
 * pas un UUID n'est pas une erreur de base à laisser remonter en 500 : la page
 * doit répondre « introuvable ».
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string | undefined | null): value is string {
  return typeof value === 'string' && UUID.test(value)
}

/**
 * UUID v7 (RFC 9562) : 48 bits d'horodatage en millisecondes, puis du hasard.
 * Ordonné dans le temps, donc bien plus compact en index qu'un v4.
 *
 * MySQL n'a pas de générateur v7 : l'identifiant est posé par l'application
 * (`primaryKeyId()` dans `src/db/columns.ts`). La base garde `uuid()` (v1) en
 * valeur par défaut pour les insertions en SQL direct.
 */
export function uuidv7(): string {
  const bytes = randomBytes(16)
  let ms = Date.now()
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256
    ms = Math.floor(ms / 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
