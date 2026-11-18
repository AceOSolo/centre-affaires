import { inboxBadge, staffNotificationWhen } from './cloche.ts'
import type { NotificationEvent, NotificationRelatedType } from './schema.ts'

/**
 * Règles de la cloche de l'espace client (ADR 077), sans base ni rendu : ce
 * qui la nourrit, où mène chaque nouveauté, ce qui se règle dans l'admin.
 *
 * La cloche du client se lit dans le **journal des messages** (ADR 038) : les
 * messages adressés à son entreprise, de certaines natures seulement — ce qui
 * est nouveau pour lui, pas ce qu'il a lui-même demandé. Une nouveauté est
 * « non lue » tant que la personne ne l'a pas ouverte depuis la cloche
 * (`client_notification_reads`) : à la différence de la cloche de l'équipe
 * (ADR 070), qui montre une liste de travail, celle-ci montre des
 * événements.
 *
 * Aucun import d'exécution hors de `cloche.ts` (lui-même sans base) : la
 * cloche du navigateur (`cloche-client.tsx`) s'en sert aussi.
 */

/**
 * Natures de message qui font une nouveauté dans la cloche, dans l'ordre de
 * l'écran de réglage. Les autres messages au client n'y entrent pas :
 *
 * - `mail_none` (« pas de courrier aujourd'hui ») : un avis quotidien, pas
 *   une nouveauté ;
 * - `member_invited` : il ouvre l'accès, la personne n'est pas encore là ;
 * - `invoice_issued`, `invoice_reminder` : la facturation du site est en
 *   sommeil, Dolibarr facture (ADR 046) — les factures de Dolibarr arrivent
 *   par le lot 8 de la recette du 17/11.
 *
 * Une nature ajoutée ici paraît d'elle-même dans la cloche des centres qui
 * ont déjà réglé la leur : le réglage garde les natures retirées, pas celles
 * montrées (`client_bell_settings.hidden_events`).
 */
export const clientBellEvents = [
  'mail_batch_received',
  'mail_received',
  'mail_scanned',
  'mail_request_done',
  'mail_request_refused',
  'booking_request_accepted',
  'booking_request_refused',
  'booking_confirmed',
  'booking_cancelled',
  'contract_activated',
  'inspection_to_sign',
  'client_broadcast',
] as const satisfies readonly NotificationEvent[]
export type ClientBellEvent = (typeof clientBellEvents)[number]

/** Ce qui est arrivé, en tête de ligne. */
export const clientBellLabels: Record<ClientBellEvent, string> = {
  mail_batch_received: 'Courrier reçu',
  mail_received: 'Courrier reçu',
  mail_scanned: 'Numérisation prête',
  mail_request_done: 'Demande de courrier traitée',
  mail_request_refused: 'Demande de courrier refusée',
  booking_request_accepted: 'Demande de réservation acceptée',
  booking_request_refused: 'Demande de réservation refusée',
  booking_confirmed: 'Réservation confirmée',
  booking_cancelled: 'Réservation annulée',
  contract_activated: 'Contrat activé',
  inspection_to_sign: 'État des lieux à valider',
  client_broadcast: 'Message du centre',
}

/** Ce que chaque nature annonce, pour l'écran de réglage du back-office. */
export const clientBellDescriptions: Record<ClientBellEvent, string> = {
  mail_batch_received: 'Fin de tournée : les plis arrivés pour l’entreprise, leur nombre.',
  mail_received: 'Un pli enregistré seul, hors tournée.',
  mail_scanned: 'Un pli ouvert et numérisé : le document est lisible dans l’espace.',
  mail_request_done: 'Ouverture, numérisation ou réexpédition faite par l’accueil.',
  mail_request_refused: 'Demande de courrier que l’accueil n’a pas pu traiter.',
  booking_request_accepted: 'Demande de réservation validée par l’accueil.',
  booking_request_refused: 'Demande de réservation que l’accueil n’a pas pu accepter.',
  booking_confirmed: 'Réservation enregistrée confirmée pour l’entreprise.',
  booking_cancelled: 'Réservation annulée par l’équipe.',
  contract_activated: 'Contrat entré en vigueur.',
  inspection_to_sign: 'État des lieux clos, à relire et valider.',
  client_broadcast: 'Message de l’équipe aux domiciliés ou à une sélection : fermeture, travaux…',
}

/** Lignes du panneau : les plus récentes. */
export const CLIENT_BELL_PANEL_LIMIT = 20

/** Intervalle d'interrogation du navigateur : une minute, comme la cloche de l'équipe. */
export const CLIENT_BELL_POLL_MS = 60_000

/** Jours pendant lesquels une nouveauté reste dans la cloche, par défaut et au plus. */
export const CLIENT_BELL_DEFAULT_DAYS = 30
export const CLIENT_BELL_MAX_DAYS = 90

/** Réglage d'un centre (`client_bell_settings`). */
export type ClientBellSettings = {
  /** Natures retirées de la cloche par le centre. */
  hiddenEvents: ClientBellEvent[]
  windowDays: number
}

export const defaultClientBellSettings: ClientBellSettings = {
  hiddenEvents: [],
  windowDays: CLIENT_BELL_DEFAULT_DAYS,
}

export function isClientBellEvent(value: unknown): value is ClientBellEvent {
  return typeof value === 'string' && (clientBellEvents as readonly string[]).includes(value)
}

/** Natures que la cloche montre, d'après le réglage du centre. */
export function shownClientBellEvents(settings: ClientBellSettings): ClientBellEvent[] {
  return clientBellEvents.filter((event) => !settings.hiddenEvents.includes(event))
}

/**
 * Réglage relu depuis la base : une nature inconnue (retirée du code depuis)
 * est ignorée, une durée hors bornes revient à la valeur par défaut.
 */
export function clientBellSettingsFromRow(row: { hiddenEvents: unknown; windowDays: number } | undefined): ClientBellSettings {
  if (!row) return defaultClientBellSettings
  const hidden = Array.isArray(row.hiddenEvents) ? row.hiddenEvents.filter(isClientBellEvent) : []
  const days = Number.isInteger(row.windowDays) && row.windowDays >= 1 && row.windowDays <= CLIENT_BELL_MAX_DAYS
    ? row.windowDays
    : CLIENT_BELL_DEFAULT_DAYS
  return { hiddenEvents: [...new Set(hidden)], windowDays: days }
}

type FormLike = { get(name: string): FormDataEntryValue | null; getAll(name: string): FormDataEntryValue[] }

export type ClientBellSettingsForm =
  | { settings: ClientBellSettings; errors?: undefined }
  | { settings?: undefined; errors: { windowDays: string } }

/**
 * Formulaire du back-office : les cases cochées (`evenement`) sont les natures
 * montrées ; les autres sont retirées. Aucune case cochée est admis : la
 * cloche se tait.
 */
export function readClientBellSettingsForm(form: FormLike): ClientBellSettingsForm {
  const shown = new Set(form.getAll('evenement').filter(isClientBellEvent))
  const raw = String(form.get('windowDays') ?? '').trim()
  const days = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isInteger(days) || days < 1 || days > CLIENT_BELL_MAX_DAYS) {
    return { errors: { windowDays: `Saisissez un nombre de jours entre 1 et ${CLIENT_BELL_MAX_DAYS}.` } }
  }
  return {
    settings: {
      hiddenEvents: clientBellEvents.filter((event) => !shown.has(event)),
      windowDays: days,
    },
  }
}

/** Début de la période que la cloche montre. */
export function clientBellSince(now: Date, windowDays: number): Date {
  return new Date(now.getTime() - windowDays * 86_400_000)
}

/** Une ligne du journal, telle que la cloche la lit. */
export type ClientBellSource = {
  /** Ligne du journal des messages (`notification_deliveries.id`). */
  id: string
  event: ClientBellEvent
  clientId: string
  clientName: string
  /** Objet du message, tel qu'il est parti (ou serait parti) par courriel. */
  subject: string
  sentAt: Date
  relatedType: NotificationRelatedType | null
  relatedId: string | null
  /** Pli d'une demande de courrier, pour mener à sa fiche. */
  mailItemId: string | null
  read: boolean
}

/**
 * Où mène une nouveauté, dans l'espace client : le pli, la réservation, le
 * contrat, l'état des lieux, le message ; à défaut, la rubrique.
 */
export function clientBellHref(source: Pick<ClientBellSource, 'event' | 'relatedType' | 'relatedId' | 'mailItemId'>): string {
  const { event, relatedType, relatedId, mailItemId } = source
  switch (event) {
    case 'mail_batch_received':
      return '/compte/courrier'
    case 'mail_received':
    case 'mail_scanned':
      return relatedType === 'mail_item' && relatedId ? `/compte/courrier/${relatedId}` : '/compte/courrier'
    case 'mail_request_done':
    case 'mail_request_refused':
      return mailItemId ? `/compte/courrier/${mailItemId}` : '/compte/courrier/demandes'
    case 'booking_request_accepted':
    case 'booking_request_refused':
    case 'booking_confirmed':
    case 'booking_cancelled':
      return relatedType === 'booking' && relatedId ? `/compte/reservations#resa-${relatedId}` : '/compte/reservations'
    case 'contract_activated':
      return relatedType === 'contract' && relatedId ? `/compte/contrats#contrat-${relatedId}` : '/compte/contrats'
    case 'inspection_to_sign':
      return relatedType === 'inspection' && relatedId ? `/compte/etats-des-lieux/${relatedId}` : '/compte/etats-des-lieux'
    case 'client_broadcast':
      return relatedType === 'client_broadcast' && relatedId ? `/compte/messages/${relatedId}` : '/compte'
  }
}

/** Une ligne de la cloche, telle que le navigateur la reçoit (`/api/compte/notifications`). */
export type ClientBellItem = {
  id: string
  event: ClientBellEvent
  /** « Numérisation prête ». */
  label: string
  /** L'objet du message : « Votre courrier a été numérisé — Atelier Durand ». */
  summary: string
  /** L'entreprise, quand le compte en a plusieurs. */
  who: string | null
  read: boolean
  /** Envoi du message, ISO 8601, pour `<time dateTime>`. */
  createdAt: string
  /** « il y a 12 min », à l'heure du centre. */
  when: string
  href: string
}

/**
 * `count` : nouveautés non lues de la période ; `items` : les plus récentes,
 * lues ou non ; `unreadMail` : plis non lus, pour la pastille de l'onglet
 * « Courrier », relue avec la cloche.
 */
export type ClientBellFeed = { count: number; items: ClientBellItem[]; unreadMail: number }

export function buildClientBellItems(
  sources: readonly ClientBellSource[],
  options: { timeZone: string; now?: Date; showClient: boolean },
): ClientBellItem[] {
  const now = options.now ?? new Date()
  return [...sources]
    .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime() || b.id.localeCompare(a.id))
    .slice(0, CLIENT_BELL_PANEL_LIMIT)
    .map((source) => ({
      id: source.id,
      event: source.event,
      label: clientBellLabels[source.event],
      summary: source.subject,
      who: options.showClient ? source.clientName : null,
      read: source.read,
      createdAt: source.sentAt.toISOString(),
      when: staffNotificationWhen(source.sentAt, options.timeZone, now),
      href: clientBellHref(source),
    }))
}

/** « 3 nouveautés », pour le bouton et la région annoncée. */
export function clientBellPhrase(count: number): string {
  if (count <= 0) return 'aucune nouveauté'
  return count === 1 ? '1 nouveauté' : `${count} nouveautés`
}

/** Pastille : au-delà de 99, « 99+ ». */
export const clientBellBadge = inboxBadge

/** « nouveaux courriers », accordé au nombre. */
export function unreadMailNoun(count: number): string {
  return count === 1 ? 'nouveau courrier' : 'nouveaux courriers'
}

/** « 3 nouveaux courriers » : la pastille de l'onglet et l'accueil de l'espace. */
export function unreadMailPhrase(count: number): string {
  return `${count} ${unreadMailNoun(count)}`
}
