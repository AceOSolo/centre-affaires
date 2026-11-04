import { isUuid } from '../../lib/uuid.ts'

/**
 * Paramètres des listes que le CRM lit (`GET /api/dolibarr/*`, ADR 066),
 * lus pareil partout. Un paramètre illisible est refusé (400) avec un message
 * qui dit quoi envoyer, jamais ignoré en silence.
 */

export type ListParams = {
  limit: number
  /** Page suivante : l'identifiant du dernier élément reçu. */
  after?: string
  /** `rapproche=oui|non` : seulement les fiches reliées au CRM, ou seulement les autres. */
  linked?: boolean
  /** `depuis` : instant ISO 8601. */
  since?: Date
}

export type ParamsRead = { ok: true; params: ListParams } | { ok: false; message: string }

export function readListParams(
  searchParams: URLSearchParams,
  accept: { linked?: boolean; after?: boolean; since?: boolean },
  defaultLimit = 100,
): ParamsRead {
  const limit = Number(searchParams.get('limite') ?? defaultLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return { ok: false, message: 'La limite est un entier de 1 à 500.' }
  }
  const params: ListParams = { limit }

  const after = searchParams.get('apres')
  if (accept.after && after !== null) {
    if (!isUuid(after)) return { ok: false, message: '« apres » : l’identifiant du dernier élément reçu.' }
    params.after = after
  }

  const linked = searchParams.get('rapproche')
  if (accept.linked && linked !== null) {
    if (linked !== 'oui' && linked !== 'non') return { ok: false, message: '« rapproche » vaut « oui » ou « non ».' }
    params.linked = linked === 'oui'
  }

  const since = searchParams.get('depuis')
  if (accept.since && since !== null) {
    const date = new Date(since)
    if (!since || Number.isNaN(date.getTime())) {
      return { ok: false, message: 'Date « depuis » illisible : attendu un instant ISO 8601.' }
    }
    params.since = date
  }
  return { ok: true, params }
}
