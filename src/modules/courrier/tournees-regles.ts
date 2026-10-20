import { isUuid } from '../../lib/uuid.ts'
import { mailKinds, type MailKind } from './schema.ts'

/**
 * Règles de la tournée du courrier (ADR 044). Sans base ni framework : elles
 * décident qui reçoit quel message en fin de tournée.
 *
 * - une entreprise qui a reçu au moins un pli dans la tournée reçoit un seul
 *   message : leur nombre et leur nature, jamais l'expéditeur ;
 * - un domicilié sans pli reçoit « pas de courrier aujourd'hui », à la
 *   première tournée terminée de la journée seulement : une seconde
 *   distribution l'après-midi ne le lui redit pas ;
 * - un pli retiré (enregistré par erreur) ne compte pas.
 */

/**
 * Valeur envoyée par l'écran qui ne montrait aucune tournée ouverte :
 * « Signaler qu'aucun courrier n'est arrivé ». Explicite, pour qu'une valeur
 * vide ou perdue ne termine jamais la tournée qu'un collègue vient d'ouvrir.
 */
export const NO_BATCH = 'aucune'

/**
 * La tournée que l'écran montrait, lue dans le formulaire de fin de tournée :
 * son identifiant, `null` pour « aucune tournée », `undefined` pour une valeur
 * illisible — rien n'est alors terminé.
 */
export function expectedBatch(value: string): string | null | undefined {
  if (value === NO_BATCH) return null
  return isUuid(value) ? value : undefined
}

export type BatchItem = { clientId: string; kind: MailKind; opened: boolean }

export type BatchReceived = {
  clientId: string
  count: number
  byKind: Record<MailKind, number>
  /** Plis déjà ouverts et numérisés par l'accueil à l'enregistrement. */
  scanned: number
}

export type BatchMessages = { received: BatchReceived[]; none: string[] }

export function batchMessages(
  items: readonly BatchItem[],
  domiciledClientIds: readonly string[],
  firstOfDay: boolean,
): BatchMessages {
  const byClient = new Map<string, BatchReceived>()
  for (const item of items) {
    let entry = byClient.get(item.clientId)
    if (!entry) {
      entry = {
        clientId: item.clientId,
        count: 0,
        byKind: Object.fromEntries(mailKinds.map((kind) => [kind, 0])) as Record<MailKind, number>,
        scanned: 0,
      }
      byClient.set(item.clientId, entry)
    }
    entry.count++
    entry.byKind[item.kind]++
    if (item.opened) entry.scanned++
  }
  const none = firstOfDay
    ? [...new Set(domiciledClientIds)].filter((clientId) => !byClient.has(clientId)).sort()
    : []
  const received = [...byClient.values()].sort((a, b) =>
    a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0,
  )
  return { received, none }
}

/** « 1 courrier », « 3 courriers ». */
export function mailCountPhrase(count: number): string {
  return `${count} courrier${count > 1 ? 's' : ''}`
}

const kindNouns: Record<MailKind, [string, string]> = {
  lettre: ['lettre', 'lettres'],
  recommande: ['recommandé', 'recommandés'],
  colis: ['colis', 'colis'],
  autre: ['autre pli', 'autres plis'],
}

/** « 2 lettres et 1 recommandé », « 1 lettre, 1 colis et 2 autres plis ». */
export function mailKindsPhrase(byKind: Record<MailKind, number>): string {
  const parts = mailKinds
    .filter((kind) => byKind[kind] > 0)
    .map((kind) => `${byKind[kind]} ${kindNouns[kind][byKind[kind] > 1 ? 1 : 0]}`)
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} et ${parts.at(-1)}`
}

/** « dont 1 déjà ouvert et numérisé » ; vide sans pli numérisé. */
export function scannedPhrase(scanned: number): string {
  if (scanned <= 0) return ''
  return scanned > 1
    ? `dont ${scanned} déjà ouverts et numérisés : ils sont lisibles dans votre espace.`
    : 'dont 1 déjà ouvert et numérisé : il est lisible dans votre espace.'
}
