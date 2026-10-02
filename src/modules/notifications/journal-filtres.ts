import { dayRangeUtc, isCalendarDate } from '../../lib/dates.ts'
import {
  notificationDeliveryStatuses,
  notificationEvents,
  type NotificationDeliveryStatus,
  type NotificationEvent,
} from './schema.ts'

/**
 * Filtres du journal des envois (R26, ADR 038), lus dans l'adresse de la page :
 * événement, statut, période, destinataire. Module pur, éprouvé seul
 * (`journal-filtres.test.ts`). Une valeur illisible est ignorée et signalée,
 * jamais interprétée.
 */

export const JOURNAL_PAGE_SIZE = 50
const RECIPIENT_MAX = 200

export type JournalFilters = {
  event?: NotificationEvent
  status?: NotificationDeliveryStatus
  /** Premier jour, jour du centre, inclus. */
  from?: string
  /** Dernier jour, jour du centre, inclus. */
  to?: string
  /** Partie d'une adresse, en minuscules. */
  recipient?: string
  /** Page, à partir de 1. */
  page: number
}

export type JournalFilterField = 'evenement' | 'statut' | 'du' | 'au' | 'destinataire'

export type ParsedJournalFilters = {
  filters: JournalFilters
  /** Valeurs saisies telles quelles, pour reremplir le formulaire. */
  values: Record<JournalFilterField, string>
  errors: Partial<Record<JournalFilterField, string>>
}

type Params = Record<string, string | string[] | undefined>

function single(params: Params, key: string): string {
  const value = params[key]
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ''
}

export function parseJournalFilters(params: Params): ParsedJournalFilters {
  const values = {
    evenement: single(params, 'evenement'),
    statut: single(params, 'statut'),
    du: single(params, 'du'),
    au: single(params, 'au'),
    destinataire: single(params, 'destinataire'),
  }
  const errors: ParsedJournalFilters['errors'] = {}
  const filters: JournalFilters = { page: 1 }

  if (values.evenement) {
    if ((notificationEvents as readonly string[]).includes(values.evenement)) {
      filters.event = values.evenement as NotificationEvent
    } else errors.evenement = 'Événement inconnu.'
  }
  if (values.statut) {
    if ((notificationDeliveryStatuses as readonly string[]).includes(values.statut)) {
      filters.status = values.statut as NotificationDeliveryStatus
    } else errors.statut = 'Statut inconnu.'
  }
  if (values.du) {
    if (isCalendarDate(values.du)) filters.from = values.du
    else errors.du = 'Date illisible : choisissez un jour.'
  }
  if (values.au) {
    if (isCalendarDate(values.au)) filters.to = values.au
    else errors.au = 'Date illisible : choisissez un jour.'
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    errors.au = 'La fin de la période précède son début.'
    delete filters.to
  }
  if (values.destinataire) {
    if (values.destinataire.length > RECIPIENT_MAX) {
      errors.destinataire = `${RECIPIENT_MAX} caractères au plus.`
    } else filters.recipient = values.destinataire.toLowerCase()
  }
  const page = Number(single(params, 'page'))
  if (Number.isInteger(page) && page > 1 && page <= 10_000) filters.page = page

  return { filters, values, errors }
}

/** Bornes UTC de la période, en `[)`, à partir des jours du centre (décision 4). */
export function journalPeriodUtc(
  filters: Pick<JournalFilters, 'from' | 'to'>,
  timeZone: string,
): { from?: Date; to?: Date } {
  return {
    from: filters.from ? dayRangeUtc(filters.from, timeZone).startsAt : undefined,
    to: filters.to ? dayRangeUtc(filters.to, timeZone).endsAt : undefined,
  }
}

/** Motif `ILIKE` d'une partie d'adresse : `%` et `_` saisis restent des caractères. */
export function recipientPattern(recipient: string): string {
  return `%${recipient.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

/** Adresse de la page avec ces filtres, pour la pagination. */
export function journalHref(values: Record<JournalFilterField, string>, page: number): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value)
  if (page > 1) params.set('page', String(page))
  const query = params.toString()
  return query ? `/notifications?${query}` : '/notifications'
}
