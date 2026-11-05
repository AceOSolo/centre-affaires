import type { InboxShelf } from '../../app/(admin)/aujourdhui/journee.ts'
import { addDaysToIsoDate, formatDateTime, formatTime, toIsoDate } from '../../lib/dates.ts'

/**
 * Règles de la cloche de l'équipe (ADR 059, ADR 070), sans base ni rendu : ce
 * qu'elle compte, où mène chaque ligne, comment se dit « quand ».
 *
 * La cloche montre ce qui reste à traiter, les mêmes demandes que la page
 * « Demandes » et le même nombre (ADR 070) : une demande en sort quand elle
 * est validée, refusée, faite ou annulée, quel que soit le membre qui l'a
 * traitée.
 *
 * Aucun import d'exécution hors de `lib/dates.ts` : la cloche du navigateur
 * (`cloche.tsx`) s'en sert aussi, sans embarquer le schéma de la base.
 */

/** Lignes du panneau : les plus récentes, au-delà « Voir toutes les demandes ». */
export const STAFF_NOTIFICATION_PANEL_LIMIT = 20

/** Intervalle d'interrogation du navigateur : une minute (pas de websocket). */
export const STAFF_NOTIFICATION_POLL_MS = 60_000

/** Ce qui attend l'équipe, ligne par ligne. */
export const inboxItemKinds = [
  'booking_request',
  'quote_request',
  'domiciliation_request',
  'proposal',
  'offer_request',
  'mail_request',
] as const
export type InboxItemKind = (typeof inboxItemKinds)[number]

/** Ce qui est arrivé, en tête de ligne. */
export const inboxItemLabels: Record<InboxItemKind, string> = {
  booking_request: 'Demande de réservation',
  quote_request: 'Demande de devis',
  domiciliation_request: 'Demande de domiciliation',
  proposal: 'Devis à compléter',
  offer_request: 'Offre demandée',
  mail_request: 'Demande de courrier',
}

const anchors: Record<InboxItemKind, string> = {
  booking_request: 'demande',
  quote_request: 'demande',
  domiciliation_request: 'devis',
  proposal: 'devis',
  offer_request: 'offre',
  mail_request: 'courrier',
}

/**
 * Où mène une ligne : la demande dans « Demandes » (ADR 048) filtrée sur son
 * rayon — le menu ouvre alors ce rayon et allume sa ligne « Demandes »
 * (ADR 070) —, à son ancre : `demande-` pour une réservation, `devis-`,
 * `offre-`, `courrier-`.
 */
export function inboxItemHref(kind: InboxItemKind, id: string, shelf: InboxShelf): string {
  return `/demandes?produit=${shelf}#${anchors[kind]}-${id}`
}

/**
 * « à l'instant », « il y a 12 min », « aujourd'hui à 09:30 », « hier à
 * 17:02 », puis la date : à l'heure du centre (décision 4).
 */
export function staffNotificationWhen(createdAt: Date, timeZone: string, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - createdAt.getTime()) / 60_000)
  if (minutes < 1) return 'à l’instant'
  if (minutes < 60) return `il y a ${minutes} min`
  const day = toIsoDate(createdAt, timeZone)
  const today = toIsoDate(now, timeZone)
  if (day === today) return `aujourd’hui à ${formatTime(createdAt, timeZone)}`
  if (day === addDaysToIsoDate(today, -1)) return `hier à ${formatTime(createdAt, timeZone)}`
  return formatDateTime(createdAt, timeZone)
}

/** « 3 demandes à traiter », pour le bouton et la région annoncée. */
export function inboxPhrase(count: number): string {
  if (count === 0) return 'aucune demande à traiter'
  return count === 1 ? '1 demande à traiter' : `${count} demandes à traiter`
}

/** Pastille du bouton : au-delà de 99, « 99+ ». */
export function inboxBadge(count: number): string | null {
  if (count <= 0) return null
  return count > 99 ? '99+' : String(count)
}

/** Une ligne de la cloche, telle que le navigateur la reçoit (`/api/equipe/notifications`). */
export type InboxItem = {
  /** Identifiant de la demande, du devis ou de la demande d'offre. */
  id: string
  kind: InboxItemKind
  /** « Demande de réservation ». */
  label: string
  /** « Salle Atlas · lundi 5 octobre 2026, de 09:00 à 11:00 ». */
  summary: string
  /** Entreprise, ou demandeur de la page publique ; « Visiteur du site » à défaut. */
  who: string
  /** « Prise en charge » : quelqu'un s'en occupe, ce n'est pas encore fait. */
  state: string | null
  /** Arrivée de la demande, ISO 8601, pour `<time dateTime>`. */
  createdAt: string
  /** « il y a 12 min », à l'heure du centre. */
  when: string
  href: string
}

/** `count` : toutes les demandes à traiter ; `items` : les plus récentes. */
export type InboxFeed = { count: number; items: InboxItem[] }
