import { isUuid } from '../../lib/uuid.ts'
import { readSender } from './expediteurs.ts'
import { mailKinds, type MailKind } from './schema.ts'
import { mailKindsPhrase } from './tournees-regles.ts'

/**
 * Saisie groupée du courrier (ADR 058, qui amende l'ADR 055 § 5) : **une
 * photo = un pli**. L'accueil choisit l'entreprise, le type, puis prend ou
 * dépose les photos des enveloppes ; chaque photo crée un pli de ce type pour
 * cette entreprise. Un pli sans photo (appareil absent, pli abîmé) s'ajoute à
 * part. Le récapitulatif liste les plis, chacun avec son expéditeur
 * facultatif, et tout s'enregistre en un seul envoi.
 *
 * Chaque pli de l'envoi est un groupe de champs `pli.<clé>.<champ>` : `client`,
 * `kind`, `sender` et, s'il en a une, `photo`. La clé est propre à l'écran ;
 * l'ordre des plis est celui de leur première apparition dans l'envoi, qui
 * est celui du récapitulatif.
 */

/** Au plus par envoi : une tournée exceptionnelle se saisit en deux fois. */
export const MAX_PER_ENTRY = 500

/**
 * Photos d'une saisie, à elles toutes : 20 Mo, sous le plafond de 21 Mo d'un
 * envoi (`next.config.ts`, nginx). Compressée dans le navigateur, une photo
 * d'enveloppe pèse quelques centaines de kilo-octets.
 */
export const MAX_ENTRY_PHOTOS_BYTES = 20 * 1024 * 1024

export const entryFields = ['client', 'kind', 'sender', 'photo'] as const
export type EntryField = (typeof entryFields)[number]

/** `pli.12.sender` : nom du champ, et `id` du contrôle vers lequel le résumé d'erreurs renvoie. */
export const entryFieldName = (key: string | number, field: EntryField) => `pli.${key}.${field}`

const FIELD = /^pli\.(\d{1,9})\.(client|kind|sender|photo)$/

/** Un pli de la saisie. `P` : sa photo — un fichier reçu, puis déposé au stockage. */
export type EntryItem<P> = {
  /** Clé du pli dans l'écran : ses erreurs y renvoient. */
  key: string
  clientId: string
  kind: MailKind
  sender: string | null
  envelope?: P
}

export type ParsedMailEntry = {
  /** Plis lisibles, dans l'ordre de l'envoi. */
  items: EntryItem<File>[]
  /** Plis de l'envoi, lisibles ou non. */
  count: number
  /** Par nom de champ, comme les autres formulaires (résumé d'erreurs). */
  fieldErrors: Record<string, string>
}

type Draft = { client?: unknown; kind?: unknown; sender?: unknown; photos: File[] }

const isFile = (value: unknown): value is File =>
  typeof value === 'object' && value !== null && typeof (value as File).arrayBuffer === 'function'

/**
 * Lit les plis d'un envoi. Les champs étrangers sont ignorés. Un pli sans
 * entreprise ou sans type valable est une erreur sur ce champ, jamais un pli
 * deviné ; un pli a au plus une photo. Les photos elles-mêmes (type, poids)
 * sont contrôlées ensuite, comme toute numérisation (`readScan`).
 */
export function parseMailEntry(entries: Iterable<[string, unknown]>): ParsedMailEntry {
  const drafts = new Map<string, Draft>()
  for (const [name, value] of entries) {
    const match = FIELD.exec(name)
    if (!match) continue
    const [, key, field] = match
    const draft = drafts.get(key) ?? { photos: [] }
    drafts.set(key, draft)
    if (field === 'photo') {
      // Un champ de fichier laissé vide envoie un fichier de zéro octet.
      if (isFile(value) && value.size > 0) draft.photos.push(value)
    } else if (draft[field as 'client' | 'kind' | 'sender'] === undefined) {
      draft[field as 'client' | 'kind' | 'sender'] = value
    }
  }

  const items: EntryItem<File>[] = []
  const fieldErrors: Record<string, string> = {}
  for (const [key, draft] of drafts) {
    const clientId = typeof draft.client === 'string' ? draft.client.trim() : ''
    const kind = typeof draft.kind === 'string' ? draft.kind.trim() : ''
    const sender = readSender(draft.sender)
    let valid = true
    if (!isUuid(clientId)) {
      fieldErrors[entryFieldName(key, 'client')] = 'Choisissez l’entreprise de ce pli.'
      valid = false
    }
    if (!(mailKinds as readonly string[]).includes(kind)) {
      fieldErrors[entryFieldName(key, 'kind')] = 'Choisissez le type de ce pli : lettre, recommandé, colis ou autre.'
      valid = false
    }
    if (sender.error) {
      fieldErrors[entryFieldName(key, 'sender')] = sender.error
      valid = false
    }
    if (draft.photos.length > 1) {
      fieldErrors[entryFieldName(key, 'photo')] = 'Une seule photo par pli : chaque photo est un pli.'
      valid = false
    }
    if (!valid) continue
    const item: EntryItem<File> = { key, clientId, kind: kind as MailKind, sender: sender.sender }
    if (draft.photos[0]) item.envelope = draft.photos[0]
    items.push(item)
  }
  return { items, count: drafts.size, fieldErrors }
}

/** Une entreprise du récapitulatif : « ACME : 3 lettres et 1 colis ». */
export type EntryGroup<T extends { clientId: string; kind: MailKind }> = {
  clientId: string
  items: T[]
  byKind: Record<MailKind, number>
  /** « 3 lettres et 1 colis ». */
  phrase: string
}

/**
 * Les plis groupés par entreprise, dans l'ordre où chacune est apparue dans
 * la saisie ; dans une entreprise, l'ordre de la saisie. C'est l'ordre du
 * récapitulatif, et celui de l'enregistrement : le rang du pli dans sa
 * journée (« pli 2 sur 3 du 04/11 », ADR 057) suit donc l'ordre des photos.
 */
export function groupEntry<T extends { clientId: string; kind: MailKind }>(items: readonly T[]): EntryGroup<T>[] {
  const groups = new Map<string, EntryGroup<T>>()
  for (const item of items) {
    let group = groups.get(item.clientId)
    if (!group) {
      group = {
        clientId: item.clientId,
        items: [],
        byKind: Object.fromEntries(mailKinds.map((kind) => [kind, 0])) as Record<MailKind, number>,
        phrase: '',
      }
      groups.set(item.clientId, group)
    }
    group.items.push(item)
    group.byKind[item.kind]++
  }
  return [...groups.values()].map((group) => ({ ...group, phrase: mailKindsPhrase(group.byKind) }))
}

/** Les plis dans l'ordre du récapitulatif (`groupEntry`) : celui de leur enregistrement. */
export const inEntryOrder = <T extends { clientId: string; kind: MailKind }>(items: readonly T[]): T[] =>
  groupEntry(items).flatMap((group) => group.items)

/**
 * Identifiants des plis d'un envoi, dans l'ordre de la saisie. Un UUID v7 ne
 * porte que la milliseconde : deux identifiants tirés dans la même sont
 * ordonnés au hasard. Triés, ils suivent l'ordre où on les attribue, et le
 * rang du pli dans sa journée, qui départage par l'identifiant les plis reçus
 * à la même heure (ADR 057), suit l'ordre des photos.
 */
export function orderedIds(count: number, next: () => string): string[] {
  return Array.from({ length: count }, next).sort()
}
