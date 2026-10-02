import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { primaryKeyId, timestamps } from '../../db/columns.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenantId } from '../../db/tenants.ts'
import { clients } from '../clients/schema.ts'
import { contracts } from '../contrats/schema.ts'
import { resources } from '../ressources/schema.ts'

/**
 * `pending` : demande à valider (portail client, tranche 4).
 * `confirmed` : occupe la ressource.
 * `cancelled` : libère le créneau, la ligne est conservée.
 *
 * Une réservation n'a pas de `deleted_at` : l'annulation est sa suppression
 * logique. La contrainte d'exclusion (migration 0002) porte sur
 * `status <> 'cancelled'` ; un second marqueur d'effacement laisserait des
 * créneaux bloqués par des lignes invisibles.
 */
export const bookingStatuses = ['pending', 'confirmed', 'cancelled'] as const
export type BookingStatus = (typeof bookingStatuses)[number]
export const bookingStatusEnum = pgEnum('booking_status', bookingStatuses)

/**
 * Nature de la ligne.
 *
 * - `booking` : une réservation, horaire ou à la journée.
 * - `unavailability` : un blocage posé par l'équipe (entretien, travaux).
 * - `contract` : la période d'un contrat qui loue la ressource (ADR 018). Tenue
 *   par le trigger `contracts_sync_occupation` à partir du contrat : l'écrire
 *   directement est refusé par la base (SQLSTATE `CA001`).
 *
 * Les trois occupent la ressource sous la même contrainte d'exclusion : un
 * bureau loué au mois ne peut pas être réservé à l'heure.
 */
export const bookingKinds = ['booking', 'unavailability', 'contract'] as const
export type BookingKind = (typeof bookingKinds)[number]

/**
 * Par où la réservation est arrivée (R05, ADR 018).
 *
 * - `staff` : saisie par l'équipe dans le back-office, et occupations de contrat.
 * - `client` : déposée par une personne connectée à son espace client.
 * - `public` : demandée depuis la page publique, sans compte (ADR 005).
 *
 * Sans valeur par défaut : chaque chemin d'écriture dit d'où il vient, la base
 * refuse une réservation qui ne le dit pas.
 */
export const bookingChannels = ['staff', 'client', 'public'] as const
export type BookingChannel = (typeof bookingChannels)[number]
export const bookingChannelEnum = pgEnum('booking_channel', bookingChannels)

/**
 * Fin d'une occupation sans terme : un contrat à durée indéterminée (ADR 018).
 *
 * Un instant très lointain plutôt que `infinity` : le pilote lit les
 * `timestamptz` en `Date`, et `infinity` y deviendrait une `Invalid Date` qui
 * casserait silencieusement tous les calculs de planning. La même valeur est
 * rendue par la fonction SQL `booking_open_end()`.
 */
export const OPEN_ENDED_BOOKING_END = new Date('9999-12-31T00:00:00.000Z')

/** Vrai pour une occupation sans terme, à afficher « sans date de fin ». */
export function isOpenEndedBooking(booking: { endsAt: Date }): boolean {
  return booking.endsAt.getTime() >= OPEN_ENDED_BOOKING_END.getTime()
}

export const bookings = pgTable(
  'bookings',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    resourceId: uuid('resource_id').notNull(),
    /** Occurrences créées ensemble ; chacune reste déplaçable et annulable. */
    seriesId: uuid('series_id'),
    kind: text('kind').$type<BookingKind>().notNull().default('booking'),
    channel: bookingChannelEnum('channel').notNull(),
    /** Bornes `[)` : une réservation qui finit à 10h00 n'entre pas en conflit
     * avec une qui commence à 10h00. */
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    status: bookingStatusEnum('status').notNull().default('confirmed'),
    /** Objet de la réservation, affiché dans le calendrier. */
    title: text('title').notNull(),
    notes: text('notes'),
    /**
     * Identité du demandeur d'une réservation déposée depuis la page publique
     * (ADR 005). Nulle pour une réservation posée par le staff, qui n'a pas de
     * demandeur externe. Ce sont les premières données personnelles du produit :
     * elles appellent une durée de conservation, pas un stockage indéfini.
     */
    requesterName: text('requester_name'),
    requesterEmail: text('requester_email'),
    requesterPhone: text('requester_phone'),
    /**
     * Date à laquelle les coordonnées du demandeur ont été effacées, au terme
     * de la durée de conservation du centre (ADR 020). Posée par la fonction
     * `anonymize_expired_public_requests()`, jamais par le code.
     */
    requesterAnonymizedAt: timestamp('requester_anonymized_at', { withTimezone: true }),
    /**
     * Entreprise cliente pour laquelle la salle est réservée (ADR 015). Nulle
     * pour une indisponibilité, ou pour un visiteur qui n'est pas client. C'est
     * ce qui fait apparaître la réservation dans l'espace du client.
     */
    clientId: uuid('client_id'),
    /**
     * Contrat au titre duquel la ressource est occupée (R05). Toujours posé sur
     * une occupation de contrat (`kind = 'contract'`) ; facultatif sinon.
     */
    contractId: uuid('contract_id'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'bookings_resource_fk',
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [resources.tenantId, resources.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'bookings_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'bookings_contract_fk',
      columns: [table.tenantId, table.contractId],
      foreignColumns: [contracts.tenantId, contracts.id],
    }).onDelete('restrict'),
    // « Mes réservations » : celles d'un client, par date.
    index('bookings_client_starts_at_idx')
      .on(table.tenantId, table.clientId, table.startsAt)
      .where(sql`client_id is not null`),
    // Réservations rattachées à un contrat, depuis sa fiche.
    index('bookings_contract_idx')
      .on(table.tenantId, table.contractId)
      .where(sql`contract_id is not null`),
    // Une seule occupation par contrat : le trigger la déplace, la prolonge ou
    // l'annule, il n'en crée jamais une seconde (ADR 018).
    uniqueIndex('bookings_contract_occupation_key')
      .on(table.tenantId, table.contractId)
      .where(sql`kind = 'contract'`),
    check('bookings_range_not_empty', sql`${table.endsAt} > ${table.startsAt}`),
    check(
      'bookings_kind_valid',
      sql`${table.kind} in ('booking', 'unavailability', 'contract')`,
    ),
    check(
      'bookings_contract_kind_consistent',
      sql`${table.kind} <> 'contract' or ${table.contractId} is not null`,
    ),
    index('bookings_series_idx').on(table.tenantId, table.seriesId),
    check(
      'bookings_cancelled_at_consistent',
      sql`(${table.status} = 'cancelled') = (${table.cancelledAt} is not null)`,
    ),
    // Chargement du calendrier : les réservations d'une ressource sur une période.
    index('bookings_resource_starts_at_idx').on(table.resourceId, table.startsAt),
    index('bookings_tenant_starts_at_idx').on(table.tenantId, table.startsAt),
    // File d'attente de validation (ADR 005) : peu de lignes en `pending` parmi
    // beaucoup, un index partiel les trouve sans parcourir la table.
    index('bookings_pending_idx')
      .on(table.tenantId, table.startsAt)
      .where(sql`status = 'pending'`),
  ],
)

export type Booking = typeof bookings.$inferSelect
export type NewBooking = typeof bookings.$inferInsert

/**
 * Compte Google du centre, dans lequel l'application crée un agenda par
 * ressource (ADR 014).
 *
 * Une connexion au plus par centre. Le jeton de rafraîchissement donne accès
 * aux agendas sans limite de durée : il est chiffré avant d'entrer en base
 * (`src/lib/chiffrement.ts`), et ne quitte jamais le serveur.
 *
 * Supprimée physiquement à la déconnexion, par exception à la décision 6 :
 * c'est un réglage, pas une entité métier, et garder le jeton — même révoqué —
 * garderait un secret sans usage.
 */
export const googleCalendarConnections = pgTable(
  'google_calendar_connections',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    /** Compte Google qui a donné l'accès, affiché pour que l'équipe sache où regarder. */
    googleEmail: text('google_email').notNull(),
    refreshTokenSealed: text('refresh_token_sealed').notNull(),
    connectedBy: uuid('connected_by')
      .notNull()
      .references(() => staffMembers.id, { onDelete: 'restrict' }),
    /**
     * Dernière écriture réussie et dernier échec. L'écriture part après la
     * réponse à l'équipe (ADR 014) : c'est ici, et non dans le formulaire de
     * validation, qu'un échec se voit.
     */
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps(),
  },
  (table) => [uniqueIndex('google_calendar_connections_tenant_key').on(table.tenantId)],
)

export type GoogleCalendarConnection = typeof googleCalendarConnections.$inferSelect

/**
 * Agenda Google d'une ressource : celui où s'écrivent ses réservations
 * confirmées (ADR 014).
 *
 * Créé par l'application dans le compte connecté, qui ne peut écrire que dans
 * les agendas qu'elle a créés. Supprimé avec la connexion : ces agendas
 * appartiennent à ce compte, un autre compte ne pourrait pas y écrire.
 */
export const resourceGoogleCalendars = pgTable(
  'resource_google_calendars',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    resourceId: uuid('resource_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    calendarId: text('calendar_id').notNull(),
    ...timestamps(),
  },
  (table) => [
    // Nommée : le nom généré dépasserait les 63 caractères de Postgres, qui le
    // tronquerait, et Drizzle verrait une différence à chaque génération.
    foreignKey({
      name: 'resource_google_calendars_connection_fk',
      columns: [table.connectionId],
      foreignColumns: [googleCalendarConnections.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'resource_google_calendars_resource_fk',
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [resources.tenantId, resources.id],
    }).onDelete('restrict'),
    // Un agenda par ressource : deux agendas recevraient chacun la moitié des
    // écritures, selon l'ordre de lecture.
    uniqueIndex('resource_google_calendars_resource_key').on(table.tenantId, table.resourceId),
  ],
)

export type ResourceGoogleCalendar = typeof resourceGoogleCalendars.$inferSelect
