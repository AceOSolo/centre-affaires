import { and, eq } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { appUrl } from '../../lib/courriel.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { frozenQuoteDisplay } from '../facturation/devis.ts'
import { formatCents } from '../facturation/tarifs.ts'
import { bookings } from '../reservations/schema.ts'
import { resources } from '../ressources/schema.ts'
import { centreTimeZone, formatSlot, personName } from './faits.ts'
import { notify, type NotificationOutcome, type NotifyOptions } from './moteur.ts'

/**
 * Messages à l'accueil quand un client modifie ou annule lui-même une demande
 * ou une réservation depuis son espace (ADR 076). Comme les autres
 * déclencheurs (`declencheurs-reservations.ts`), chacun relit la réservation,
 * ne part que si elle est dans l'état annoncé, et ne lève jamais.
 */

async function loadChanged(bookingId: string, memberId: string, options: NotifyOptions) {
  const tenantId = options.tenantId ?? currentTenantId()
  return withTenant(
    tenantId,
    async (tx) => {
      const [row] = await tx
        .select({ booking: bookings, resourceName: resources.name, clientName: clients.name })
        .from(bookings)
        .innerJoin(resources, eq(resources.id, bookings.resourceId))
        .innerJoin(clients, eq(clients.id, bookings.clientId))
        .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, bookingId)))
      if (!row) return undefined
      const [member] = await tx
        .select({ fullName: clientMembers.fullName, email: clientMembers.email })
        .from(clientMembers)
        .where(and(eq(clientMembers.tenantId, tenantId), eq(clientMembers.id, memberId)))
      return { ...row, member, timeZone: await centreTimeZone(tx, tenantId) }
    },
    options.database,
  )
}

async function guarded(label: string, run: () => Promise<NotificationOutcome | null>) {
  try {
    return await run()
  } catch (error) {
    console.error(`Notification impossible : ${label}`, error)
    return null
  }
}

/**
 * Réservation modifiée par son client : elle attend de nouveau l'accueil, qui
 * la retrouve dans « Demandes ». `previous` : la période d'avant.
 */
export function notifyBookingChangedByClient(
  bookingId: string,
  memberId: string,
  previous: { startsAt: Date; endsAt: Date },
  options: NotifyOptions = {},
) {
  return guarded('réservation modifiée par le client', async () => {
    const loaded = await loadChanged(bookingId, memberId, options)
    if (!loaded || loaded.booking.status !== 'pending' || !loaded.booking.clientId) return null
    const { booking } = loaded
    const quote = frozenQuoteDisplay(booking)
    return notify(
      {
        event: 'booking_changed_by_client',
        clientId: booking.clientId,
        related: { type: 'booking', id: booking.id },
        values: {
          client: loaded.clientName,
          demandeur: personName(loaded.member?.fullName, loaded.member?.email) ?? loaded.clientName,
          ressource: loaded.resourceName,
          creneau: formatSlot(booking.startsAt, booking.endsAt, loaded.timeZone),
          ancien: formatSlot(previous.startsAt, previous.endsAt, loaded.timeZone),
          montant: quote ? `${formatCents(quote.totalCents, quote.currency)} TTC` : null,
          lien: appUrl('/demandes'),
        },
      },
      options,
    )
  })
}

/** Demande ou réservation annulée par son client : le créneau est libéré. */
export function notifyBookingCancelledByClient(
  bookingId: string,
  memberId: string,
  wasConfirmed: boolean,
  options: NotifyOptions = {},
) {
  return guarded('réservation annulée par le client', async () => {
    const loaded = await loadChanged(bookingId, memberId, options)
    if (!loaded || loaded.booking.status !== 'cancelled' || !loaded.booking.clientId) return null
    const { booking } = loaded
    return notify(
      {
        event: 'booking_cancelled_by_client',
        clientId: booking.clientId,
        related: { type: 'booking', id: booking.id },
        values: {
          client: loaded.clientName,
          demandeur: personName(loaded.member?.fullName, loaded.member?.email) ?? loaded.clientName,
          ressource: loaded.resourceName,
          creneau: formatSlot(booking.startsAt, booking.endsAt, loaded.timeZone),
          etat: wasConfirmed ? 'la réservation confirmée' : 'la demande en attente',
          lien: appUrl(`/reservations/${booking.id}`),
        },
      },
      options,
    )
  })
}
