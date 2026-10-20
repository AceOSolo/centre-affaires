import { isUuid } from '../../lib/uuid.ts'
import { mailKinds, type MailKind } from './schema.ts'

/**
 * Saisie groupée du courrier : « 3 lettres pour Y, 2 pour X » en un seul
 * envoi. Chaque case du tableau est un champ `n.<clientId>.<type>` ; une case
 * vide vaut zéro.
 */

/** Au plus par case : au-delà, c'est une faute de frappe (« 30 » pour « 3 »). */
export const MAX_PER_CELL = 99
/** Au plus par envoi : une tournée exceptionnelle se saisit en deux fois. */
export const MAX_PER_ENTRY = 500

export const countFieldName = (clientId: string, kind: MailKind) => `n.${clientId}.${kind}`

export type MailCount = { clientId: string; kind: MailKind; count: number }

export type ParsedMailCounts = {
  counts: MailCount[]
  /** Par nom de champ, comme les autres formulaires (résumé d'erreurs). */
  fieldErrors: Record<string, string>
  total: number
}

/**
 * Lit les cases remplies. Les champs inconnus sont ignorés ; une case qui
 * n'est pas un entier de 0 à `MAX_PER_CELL` est une erreur sur ce champ, pas
 * un zéro silencieux : un pli oublié ne doit pas passer inaperçu.
 */
export function parseMailCounts(entries: Iterable<[string, unknown]>): ParsedMailCounts {
  const counts: MailCount[] = []
  const fieldErrors: Record<string, string> = {}
  for (const [name, raw] of entries) {
    const match = /^n\.([^.]+)\.([a-z]+)$/.exec(name)
    if (!match) continue
    const [, clientId, kind] = match
    if (!isUuid(clientId) || !(mailKinds as readonly string[]).includes(kind)) continue
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (value === '') continue
    if (!/^\d+$/.test(value) || Number(value) > MAX_PER_CELL) {
      fieldErrors[name] = `Indiquez un nombre de plis entre 0 et ${MAX_PER_CELL}.`
      continue
    }
    const count = Number(value)
    if (count > 0) counts.push({ clientId, kind: kind as MailKind, count })
  }
  const total = counts.reduce((sum, entry) => sum + entry.count, 0)
  return { counts, fieldErrors, total }
}

/** Les plis à insérer, un par unité : `{ a, lettre, 3 }` donne trois lettres pour a. */
export function expandMailCounts(counts: MailCount[]): { clientId: string; kind: MailKind }[] {
  return counts.flatMap((entry) =>
    Array.from({ length: entry.count }, () => ({ clientId: entry.clientId, kind: entry.kind })),
  )
}
