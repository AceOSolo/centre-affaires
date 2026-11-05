import { createHmac, timingSafeEqual } from 'node:crypto'

import type { Resource } from '../ressources/schema.ts'
import type { Booking } from './schema.ts'

/**
 * Lien d'agenda d'une ressource (ADR 071) : une adresse `.ics` à laquelle
 * Google Agenda, Apple Calendrier ou Outlook s'abonnent, et qui montre les
 * réservations confirmées de la ressource.
 *
 * Ce fichier ne touche ni à la base ni à Next : ses règles se testent seules.
 * Le format est celui de la RFC 5545, écrit à la main — une vingtaine de
 * lignes ne justifient pas une dépendance.
 */

/** Espace des agendas, dans le back-office. */
export const AGENDAS_PATH = '/ressources/agendas'
const FEED_PATH = '/api/agendas'

/* ------------------------------------------------------------------------ */
/* Le jeton du lien                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Le jeton n'est pas gardé en base : il se recalcule à partir du lien
 * (`calendar_feeds.id`) et d'une clé dérivée d'`AUTH_SECRET`. Une copie de la
 * base ne donne donc aucun lien ; régénérer, c'est remplacer la ligne, dont
 * l'identifiant change.
 *
 * 32 caractères hexadécimaux pour l'identifiant, 40 pour la signature
 * (160 bits) : 72 caractères, sans rien à échapper dans une adresse.
 */
const SIGNATURE_LENGTH = 40

function feedKey(authSecret: string): Buffer {
  return createHmac('sha256', authSecret).update('agendas-ics/v1').digest()
}

function signature(feedId: string, tenantId: string, authSecret: string): string {
  return createHmac('sha256', feedKey(authSecret))
    .update(`${tenantId}.${feedId}`)
    .digest('hex')
    .slice(0, SIGNATURE_LENGTH)
}

export function feedToken(feedId: string, tenantId: string, authSecret: string): string {
  return feedId.replaceAll('-', '').toLowerCase() + signature(feedId, tenantId, authSecret)
}

/** L'identifiant du lien porté par un jeton, ou `undefined` s'il est mal formé. */
export function feedIdFromToken(token: string): string | undefined {
  if (!/^[0-9a-f]{72}$/.test(token)) return undefined
  const hex = token.slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Le jeton est-il celui de ce lien, pour ce centre ? Comparé à temps constant. */
export function isFeedToken(token: string, feed: { id: string; tenantId: string }, authSecret: string): boolean {
  const expected = Buffer.from(feedToken(feed.id, feed.tenantId, authSecret))
  const given = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** Adresse du lien, telle qu'on la colle dans un agenda. */
export function feedUrl(appUrl: string, token: string): string {
  return new URL(`${FEED_PATH}/${token}.ics`, appUrl).toString()
}

/** Le même lien en `webcal://` : un clic ouvre l'abonnement dans Apple Calendrier ou Outlook. */
export function webcalUrl(url: string): string {
  return url.replace(/^https?:\/\//, 'webcal://')
}

/** Page de Google Agenda qui propose d'ajouter le lien : l'abonnement en un clic. */
export function googleCalendarAddUrl(url: string): string {
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl(url))}`
}

/* ------------------------------------------------------------------------ */
/* Le contenu de l'agenda                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Ce que l'agenda d'une ressource montre : ses réservations confirmées —
 * demande acceptée comme réservation de l'équipe. Une demande en attente n'y
 * est pas encore, une réservation annulée n'y est plus, une indisponibilité
 * n'y est jamais.
 */
export function isListedInFeed(booking: Pick<Booking, 'kind' | 'status'>): boolean {
  return booking.kind === 'booking' && booking.status === 'confirmed'
}

/** Jours de passé gardés dans l'agenda : de quoi revoir le mois écoulé. */
export const FEED_PAST_DAYS = 31

/** Instant UTC au format de la RFC 5545 : `20261025T080000Z`. */
function icsInstant(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** Échappement d'une valeur texte (RFC 5545 § 3.3.11). */
function icsText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Pliage des lignes à 75 octets (RFC 5545 § 3.1) : la suite repart sur une
 * ligne qui commence par une espace. Coupé entre deux caractères, jamais au
 * milieu d'un caractère accentué.
 */
function fold(line: string): string {
  const parts: string[] = []
  let current = ''
  let bytes = 0
  for (const char of line) {
    const size = Buffer.byteLength(char)
    // La première ligne tient 75 octets ; les suivantes 74, après l'espace.
    if (bytes + size > (parts.length === 0 ? 75 : 74)) {
      parts.push(current)
      current = ''
      bytes = 0
    }
    current += char
    bytes += size
  }
  parts.push(current)
  return parts.join('\r\n ')
}

export type FeedBooking = Pick<Booking, 'id' | 'kind' | 'status' | 'title' | 'startsAt' | 'endsAt' | 'updatedAt'>

/**
 * L'agenda d'une ressource, prêt à servir.
 *
 * Ni le nom, ni le courriel, ni le téléphone du demandeur, ni les notes : ces
 * données personnelles restent en base (ADR 014). L'événement dit quoi, où et
 * quand, et renvoie vers la fiche du back-office pour le reste.
 *
 * Les instants partent en UTC (décision 4) ; le fuseau du centre accompagne
 * l'agenda pour les applications qui l'affichent.
 */
export function icsCalendar(
  bookings: FeedBooking[],
  resource: Pick<Resource, 'name'>,
  { tenantName, timeZone, appUrl }: { tenantName: string; timeZone: string; appUrl: string },
): string {
  const host = new URL(appUrl).hostname
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Centre d’affaires//Agendas des ressources//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(`${resource.name} — ${tenantName}`)}`,
    `X-WR-TIMEZONE:${timeZone}`,
    // Simples souhaits : chaque application relit à son rythme (ADR 071).
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ]
  for (const booking of bookings) {
    if (!isListedInFeed(booking)) continue
    const fiche = new URL(`/reservations/${booking.id}`, appUrl).toString()
    lines.push(
      'BEGIN:VEVENT',
      `UID:${booking.id}@${host}`,
      `DTSTAMP:${icsInstant(booking.updatedAt)}`,
      `LAST-MODIFIED:${icsInstant(booking.updatedAt)}`,
      `DTSTART:${icsInstant(booking.startsAt)}`,
      `DTEND:${icsInstant(booking.endsAt)}`,
      `SUMMARY:${icsText(booking.title)}`,
      `LOCATION:${icsText(resource.name)}`,
      `DESCRIPTION:${icsText(`Fiche de la réservation : ${fiche}`)}`,
      `URL:${fiche}`,
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}
