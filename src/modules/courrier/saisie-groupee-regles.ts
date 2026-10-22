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

/*
 * Photos des enveloppes (ADR 055) : un champ de fichiers `p.<clientId>` par
 * ligne, une photo par pli. Elles vont aux plis de l'entreprise dans l'ordre
 * des colonnes — lettres, recommandés, colis, autres —, et dans l'ordre où
 * elles ont été jointes. Jamais plus de photos que de plis.
 */

export const photoFieldName = (clientId: string) => `p.${clientId}`

/** L'entreprise d'un champ de photos ; rien pour un autre champ. */
export function photoFieldClientId(name: string): string | undefined {
  const match = /^p\.([^.]+)$/.exec(name)
  return match && isUuid(match[1]) ? match[1] : undefined
}

/**
 * Photos d'une saisie, à elles toutes : 20 Mo, sous le plafond de 21 Mo d'un
 * envoi (`next.config.ts`, nginx). Compressée dans le navigateur, une photo
 * d'enveloppe pèse quelques centaines de kilo-octets.
 */
export const MAX_ENTRY_PHOTOS_BYTES = 20 * 1024 * 1024

/** Les plis d'une entreprise, dans l'ordre où ses photos leur vont : `[lettre, lettre, colis]`. */
export function envelopeSlots(counts: MailCount[], clientId: string): MailKind[] {
  return mailKinds.flatMap((kind) => {
    const count = counts
      .filter((entry) => entry.clientId === clientId && entry.kind === kind)
      .reduce((sum, entry) => sum + entry.count, 0)
    return Array.from({ length: count }, () => kind)
  })
}

const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`

/** « 3 photos pour 2 plis » : le message d'une ligne qui a trop de photos. */
export function photoCountError(photos: number, items: number): string {
  return `${plural(photos, 'photo')} pour ${plural(items, 'pli')} : une photo par pli. Retirez-en, ou comptez les plis qui manquent.`
}

/** Une erreur par entreprise qui a plus de photos que de plis, sur son champ de photos. */
export function checkPhotoCounts(counts: MailCount[], photos: Map<string, number>): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const [clientId, count] of photos) {
    const items = envelopeSlots(counts, clientId).length
    if (count > items) errors[photoFieldName(clientId)] = photoCountError(count, items)
  }
  return errors
}

/**
 * Les plis à insérer, un par unité — `{ a, lettre, 3 }` donne trois lettres
 * pour a —, chacun avec la photo de son enveloppe s'il y en a une
 * (`envelopeSlots`). Une photo sans pli est ignorée : `checkPhotoCounts` la
 * refuse avant.
 */
export function pairEnvelopes<T>(
  counts: MailCount[],
  photos: Map<string, T[]> = new Map(),
): { clientId: string; kind: MailKind; envelope?: T }[] {
  const clientIds = [...new Set(counts.map((entry) => entry.clientId))]
  return clientIds.flatMap((clientId) => {
    const own = photos.get(clientId) ?? []
    return envelopeSlots(counts, clientId).map((kind, index) =>
      own[index] === undefined ? { clientId, kind } : { clientId, kind, envelope: own[index] },
    )
  })
}
