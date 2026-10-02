import { sql } from 'drizzle-orm'
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { primaryKeyId, timestamps } from '../../db/columns.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenantId } from '../../db/tenants.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { contractAmendments, contracts } from '../contrats/schema.ts'
import { lineNetAmountSql, rateUnitEnum, ratePlanItems } from '../facturation/schema.ts'
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
    /**
     * Segment d'occupation d'un contrat (ADR 025) : l'avenant qui l'a ouvert,
     * nul pour le segment initial. Un avenant qui change la ressource en cours
     * de contrat laisse l'ancienne occupée jusqu'à la veille de sa date d'effet
     * et occupe la nouvelle ensuite : deux lignes, une par segment. Posé par
     * `apply_contract_occupation`, seulement sur `kind = 'contract'`.
     */
    contractAmendmentId: uuid('contract_amendment_id'),

    /*
     * Devis retenu (R11, ADR 023) : le prix figé au moment de la réservation,
     * que la facture reprendra même si la grille change ensuite. Tout ou rien,
     * et seulement sur une réservation (`kind = 'booking'`) : nul pour une
     * indisponibilité, une occupation de contrat, ou une réservation non
     * chiffrée (antérieure à la vague 2, interne).
     */
    /** Unité facturée : heure, demi-journée, journée, semaine. */
    quoteUnit: rateUnitEnum('quote_unit'),
    /** Nombre d'unités dues, unité entamée comprise (règle du centre). */
    quoteQuantity: integer('quote_quantity'),
    /** Prix unitaire HT retenu, en centimes. */
    quoteUnitPriceCents: integer('quote_unit_price_cents'),
    quoteDiscountBp: integer('quote_discount_bp'),
    quoteDiscountAmountCents: integer('quote_discount_amount_cents'),
    /** Montant HT du devis, calculé par la base par la règle d'arrondi commune. */
    quoteAmountCents: integer('quote_amount_cents').generatedAlwaysAs(
      lineNetAmountSql({
        quantity: 'quote_quantity',
        unitPrice: 'quote_unit_price_cents',
        discountBp: 'quote_discount_bp',
        discountCents: 'quote_discount_amount_cents',
      }),
    ),
    quoteVatRateBp: integer('quote_vat_rate_bp'),
    quoteCurrency: char('quote_currency', { length: 3 }),
    /** Ligne de grille appliquée ; nulle pour un prix saisi à la main. */
    quoteRatePlanItemId: uuid('quote_rate_plan_item_id'),
    /** Date du devis : l'instant où le prix a été figé. */
    quotedAt: timestamp('quoted_at', { withTimezone: true }),

    /**
     * Personne qui a réservé depuis son espace client (R23, ADR 036) : une
     * personne de l'entreprise `client_id`. Posée, la réservation suit le
     * réglage de sa ressource (`resources.client_booking_mode`) : la base en
     * pose le statut — confirmée d'emblée (`instant`, devis figé), en attente
     * de l'accueil sinon — et refuse une ressource fermée au portail
     * (SQLSTATE `CA009`). Nulle pour l'équipe, la page publique et les
     * occupations de contrat.
     */
    bookedByMemberId: uuid('booked_by_member_id'),

    /**
     * Confirmation (R24, ADR 041) : instant posé par la base quand la
     * réservation devient confirmée — à sa création, ou quand l'accueil
     * accepte la demande. Nulle pour une réservation confirmée avant la
     * migration 0044 : l'étape reste connue, pas sa date.
     */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** Membre de l'équipe qui a accepté la demande ; nul à la création ou en confirmation immédiate. */
    confirmedByStaffId: uuid('confirmed_by_staff_id').references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),

    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),
    /**
     * Auteur de l'annulation (R24, ADR 036) : la personne de l'entreprise qui
     * a annulé depuis son espace — seulement une demande en attente, pas
     * commencée (`canClientCancel`, vérifié par la base, `CA009`) — ou le
     * membre de l'équipe. Nuls pour une annulation antérieure à la vague 3,
     * ou posée par la base (occupation de contrat).
     */
    cancelledByMemberId: uuid('cancelled_by_member_id'),
    cancelledByStaffId: uuid('cancelled_by_staff_id').references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
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
    // L'avenant est celui du contrat de l'occupation.
    foreignKey({
      name: 'bookings_contract_amendment_fk',
      columns: [table.tenantId, table.contractId, table.contractAmendmentId],
      foreignColumns: [
        contractAmendments.tenantId,
        contractAmendments.contractId,
        contractAmendments.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'bookings_quote_rate_plan_item_fk',
      columns: [table.tenantId, table.quoteRatePlanItemId],
      foreignColumns: [ratePlanItems.tenantId, ratePlanItems.id],
    }).onDelete('restrict'),
    // La personne est de l'entreprise de la réservation.
    foreignKey({
      name: 'bookings_booked_by_member_fk',
      columns: [table.tenantId, table.clientId, table.bookedByMemberId],
      foreignColumns: [clientMembers.tenantId, clientMembers.clientId, clientMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'bookings_cancelled_by_member_fk',
      columns: [table.tenantId, table.clientId, table.cancelledByMemberId],
      foreignColumns: [clientMembers.tenantId, clientMembers.clientId, clientMembers.id],
    }).onDelete('restrict'),
    // Cible de la clé étrangère composite des lignes de facture (R15).
    unique('bookings_tenant_id_id_key').on(table.tenantId, table.id),
    // Cible des clés étrangères qui exigent le client de la réservation : un
    // état des lieux est celui du client qui occupe (ADR 039).
    unique('bookings_tenant_id_client_key').on(table.tenantId, table.id, table.clientId),
    check(
      'bookings_booked_by_member_consistent',
      sql`${table.bookedByMemberId} is null or (${table.channel} = 'client' and ${table.kind} = 'booking' and ${table.clientId} is not null)`,
    ),
    check(
      'bookings_confirmed_by_consistent',
      sql`${table.confirmedByStaffId} is null or ${table.confirmedAt} is not null`,
    ),
    check(
      'bookings_cancelled_by_consistent',
      sql`num_nonnulls(${table.cancelledByMemberId}, ${table.cancelledByStaffId}) = 0 or (${table.status} = 'cancelled' and num_nonnulls(${table.cancelledByMemberId}, ${table.cancelledByStaffId}) = 1 and (${table.cancelledByMemberId} is null or ${table.clientId} is not null))`,
    ),
    // « Mes réservations » : celles d'un client, par date.
    index('bookings_client_starts_at_idx')
      .on(table.tenantId, table.clientId, table.startsAt)
      .where(sql`client_id is not null`),
    // Réservations rattachées à un contrat, depuis sa fiche.
    index('bookings_contract_idx')
      .on(table.tenantId, table.contractId)
      .where(sql`contract_id is not null`),
    // Une occupation par contrat et par segment : le trigger la déplace, la
    // prolonge ou l'annule, il n'en crée jamais une seconde pour le même
    // segment (ADR 018, segments de l'ADR 025). Sans avenant de changement de
    // ressource, un contrat n'a qu'un segment, donc qu'une occupation.
    uniqueIndex('bookings_contract_occupation_key')
      .on(
        table.tenantId,
        table.contractId,
        sql`coalesce(contract_amendment_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
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
    check(
      'bookings_contract_amendment_kind_consistent',
      sql`${table.contractAmendmentId} is null or ${table.kind} = 'contract'`,
    ),
    // Le devis est complet ou absent, et réservé aux réservations.
    check(
      'bookings_quote_complete',
      sql`num_nulls(${table.quoteUnit}, ${table.quoteQuantity}, ${table.quoteUnitPriceCents}, ${table.quoteVatRateBp}, ${table.quoteCurrency}, ${table.quotedAt}) in (0, 6)`,
    ),
    check(
      'bookings_quote_kind_consistent',
      sql`${table.kind} = 'booking' or ${table.quotedAt} is null`,
    ),
    check(
      'bookings_quote_values_valid',
      sql`${table.quotedAt} is null or (${table.quoteQuantity} > 0 and ${table.quoteUnitPriceCents} >= 0 and ${table.quoteVatRateBp} between 0 and 10000 and ${table.quoteAmountCents} >= 0 and num_nonnulls(${table.quoteDiscountBp}, ${table.quoteDiscountAmountCents}) <= 1 and (${table.quoteDiscountBp} is null or ${table.quoteDiscountBp} between 0 and 10000) and (${table.quoteDiscountAmountCents} is null or ${table.quoteDiscountAmountCents} >= 0))`,
    ),
    check(
      'bookings_quote_extras_need_quote',
      sql`${table.quotedAt} is not null or num_nonnulls(${table.quoteDiscountBp}, ${table.quoteDiscountAmountCents}, ${table.quoteRatePlanItemId}) = 0`,
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
