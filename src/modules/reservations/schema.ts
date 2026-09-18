import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

import { primaryKeyId, timestamps } from '@/db/columns'
import { tenantId } from '@/db/tenants'
import { resources } from '@/modules/ressources/schema'

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

export const bookings = pgTable(
  'bookings',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    resourceId: uuid('resource_id').notNull(),
    /** Bornes `[)` : une réservation qui finit à 10h00 n'entre pas en conflit
     * avec une qui commence à 10h00. */
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    status: bookingStatusEnum('status').notNull().default('confirmed'),
    /** Objet de la réservation, affiché dans le calendrier. */
    title: text('title').notNull(),
    notes: text('notes'),
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
    check('bookings_range_not_empty', sql`${table.endsAt} > ${table.startsAt}`),
    check(
      'bookings_cancelled_at_consistent',
      sql`(${table.status} = 'cancelled') = (${table.cancelledAt} is not null)`,
    ),
    // Chargement du calendrier : les réservations d'une ressource sur une période.
    index('bookings_resource_starts_at_idx').on(table.resourceId, table.startsAt),
    index('bookings_tenant_starts_at_idx').on(table.tenantId, table.startsAt),
  ],
)

export type Booking = typeof bookings.$inferSelect
export type NewBooking = typeof bookings.$inferInsert
