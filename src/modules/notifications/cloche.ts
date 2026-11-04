import type { Permission } from '../../lib/auth/permissions.ts'
import { addDaysToIsoDate, formatDateTime, formatTime, toIsoDate } from '../../lib/dates.ts'
import type { StaffNotificationKind } from './schema-equipe.ts'

/**
 * Règles de la cloche de l'équipe (ADR 059), sans base ni rendu : ce que
 * chaque membre y voit, où mène chaque ligne, comment se dit « quand ».
 *
 * Aucun import d'exécution hors de `lib/dates.ts` : la cloche du navigateur
 * (`cloche.tsx`) s'en sert aussi, sans embarquer le schéma de la base.
 */

/** La cloche montre les derniers jours ; au-delà, « Demandes » et les écrans font foi. */
export const STAFF_NOTIFICATION_DAYS = 30

/** Lignes du panneau : les plus récentes, au-delà « Voir toutes les demandes ». */
export const STAFF_NOTIFICATION_PANEL_LIMIT = 20

/** Intervalle d'interrogation du navigateur : une minute (pas de websocket). */
export const STAFF_NOTIFICATION_POLL_MS = 60_000

/**
 * Le droit qui fait voir chaque nature : celui de l'écran où elle se traite.
 * Un membre ne voit dans sa cloche que ce que ses droits lui ouvrent.
 */
export const staffNotificationPermissions: Record<StaffNotificationKind, Permission> = {
  booking_request: 'demandes.traiter',
  quote_request: 'demandes.traiter',
  domiciliation_request: 'demandes.traiter',
  offer_request: 'demandes.traiter',
  mail_request: 'courrier.gerer',
  inspection_signed: 'etats-des-lieux.gerer',
}

/**
 * Natures que ces droits — ceux du rôle du membre, `permissionsOf()` — font
 * voir. Vide : la cloche reste muette.
 */
export function kindsVisibleTo(allowed: readonly Permission[]): StaffNotificationKind[] {
  return (Object.keys(staffNotificationPermissions) as StaffNotificationKind[]).filter((kind) =>
    allowed.includes(staffNotificationPermissions[kind]),
  )
}

/** Ce qui est arrivé, en tête de ligne. */
export const staffNotificationKindLabels: Record<StaffNotificationKind, string> = {
  booking_request: 'Demande de réservation',
  quote_request: 'Demande de devis',
  domiciliation_request: 'Demande de domiciliation',
  offer_request: 'Offre demandée',
  mail_request: 'Demande de courrier',
  inspection_signed: 'État des lieux signé',
}

/**
 * Où mène une ligne : la demande dans « Demandes » (ADR 048), à son ancre —
 * `demande-` pour une réservation, `devis-`, `offre-`, `courrier-` —, ou la
 * fiche de l'état des lieux signé, qui n'est pas une demande.
 */
export function staffNotificationHref(kind: StaffNotificationKind, relatedId: string): string {
  switch (kind) {
    case 'booking_request':
    case 'quote_request':
      return `/demandes#demande-${relatedId}`
    case 'domiciliation_request':
      return `/demandes#devis-${relatedId}`
    case 'offer_request':
      return `/demandes#offre-${relatedId}`
    case 'mail_request':
      return `/demandes#courrier-${relatedId}`
    case 'inspection_signed':
      return `/etats-des-lieux/${relatedId}`
  }
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

/** « 3 non lues », pour le bouton et la région annoncée. */
export function unreadPhrase(unread: number): string {
  if (unread === 0) return 'aucune non lue'
  return unread === 1 ? '1 non lue' : `${unread} non lues`
}

/** Pastille du bouton : au-delà de 99, « 99+ ». */
export function unreadBadge(unread: number): string | null {
  if (unread <= 0) return null
  return unread > 99 ? '99+' : String(unread)
}

/**
 * Résumé d'une ligne, borné à la colonne (`varchar(255)`) : un nom de
 * ressource ou d'offre très long ne fait pas échouer l'insertion.
 */
export function boundedSummary(parts: readonly (string | null | undefined)[]): string {
  const text = parts
    .map((part) => part?.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ')
  return text.length > 255 ? `${text.slice(0, 254)}…` : text
}

/** Une ligne de la cloche, telle que le navigateur la reçoit (`/api/equipe/notifications`). */
export type StaffNotificationItem = {
  id: string
  kind: StaffNotificationKind
  /** « Demande de réservation ». */
  label: string
  /** « Salle Atlas · lundi 5 octobre 2026, de 09:00 à 11:00 ». */
  summary: string
  /** Entreprise, ou demandeur de la page publique ; « Visiteur du site » à défaut. */
  who: string
  /** ISO 8601, pour `<time dateTime>`. */
  createdAt: string
  /** « il y a 12 min », à l'heure du centre. */
  when: string
  href: string
  read: boolean
}

export type StaffNotificationFeed = { unread: number; items: StaffNotificationItem[] }
