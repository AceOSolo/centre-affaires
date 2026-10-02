import { and, eq } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { appUrl } from '../../lib/courriel.ts'
import { formatLongDate, formatTime, toIsoDate } from '../../lib/dates.ts'
import { currentTenant, currentTenantId } from '../../lib/tenant.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { frozenQuoteDisplay } from '../facturation/devis.ts'
import { formatCents } from '../facturation/tarifs.ts'
import { sendCentreMessage } from '../notifications/message-centre.ts'
import { resources } from '../ressources/schema.ts'
import { bookings } from './schema.ts'

/**
 * Message au centre pour une demande déposée depuis l'espace client
 * (`booking_request_submitted`, ADR 036, ADR 038) : l'accueil sait qu'un
 * créneau est bloqué en attendant sa réponse. Une réservation confirmée
 * d'emblée (`instant`) ne demande rien à l'accueil : pas de message.
 *
 * Un courriel prévient, il ne transporte rien d'autre que ce qu'il faut pour
 * agir (ADR 015) : qui, quoi, quand, et le lien vers les demandes.
 */

export type PortalBookingRequestFacts = {
  centreName: string
  clientName: string
  memberName: string
  resourceName: string
  /** « le lundi 5 octobre 2026, de 09:00 à 11:00 » */
  when: string
  /** Montant TTC figé, ou nul pour un créneau non chiffré. */
  amount: string | null
  link?: string
}

export function portalBookingRequestMessage(facts: PortalBookingRequestFacts): {
  subject: string
  text: string
  variables: Record<string, string>
} {
  return {
    subject: `Demande de réservation à valider — ${facts.clientName}`,
    text:
      `${facts.memberName} (${facts.clientName}) demande « ${facts.resourceName} » ${facts.when}, ` +
      'depuis son espace client.\n\n' +
      (facts.amount
        ? `Montant figé sur la demande : ${facts.amount} TTC.`
        : 'Le créneau n’a pas été chiffré : précisez le montant au client.') +
      '\n\nLe créneau est bloqué jusqu’à votre réponse.' +
      (facts.link ? `\n\nTraiter la demande : ${facts.link}` : '') +
      `\n\n—\n${facts.centreName}`,
    variables: {
      centre: facts.centreName,
      client: facts.clientName,
      personne: facts.memberName,
      ressource: facts.resourceName,
      date: facts.when,
      montant: facts.amount ?? '',
      lien: facts.link ?? '',
    },
  }
}

/** Charge la demande et prévient l'accueil. Ne lève jamais : appelé après la réponse au client. */
export async function notifyPortalBookingRequest(bookingId: string): Promise<void> {
  try {
    const [row] = await withTenant(currentTenantId(), (tx) =>
      tx
        .select({ booking: bookings, resourceName: resources.name, clientName: clients.name, member: clientMembers })
        .from(bookings)
        .innerJoin(resources, eq(resources.id, bookings.resourceId))
        .innerJoin(clients, eq(clients.id, bookings.clientId))
        .innerJoin(
          clientMembers,
          and(eq(clientMembers.clientId, bookings.clientId), eq(clientMembers.id, bookings.bookedByMemberId)),
        )
        .where(eq(bookings.id, bookingId))
        .limit(1),
    )
    // Validée ou annulée entre-temps : plus rien à demander à l'accueil.
    if (!row || row.booking.status !== 'pending') return
    const tenant = await currentTenant()
    const timeZone = tenant.timezone
    const { booking } = row
    const quote = frozenQuoteDisplay(booking)
    const message = portalBookingRequestMessage({
      centreName: tenant.name,
      clientName: row.clientName,
      memberName: row.member.fullName ?? row.member.email,
      resourceName: row.resourceName,
      when: `le ${formatLongDate(toIsoDate(booking.startsAt, timeZone), timeZone)}, de ${formatTime(booking.startsAt, timeZone)} à ${formatTime(booking.endsAt, timeZone)}`,
      amount: quote ? formatCents(quote.totalCents, quote.currency) : null,
      link: appUrl('/demandes'),
    })
    await sendCentreMessage({
      event: 'booking_request_submitted',
      clientId: booking.clientId,
      related: { type: 'booking', id: booking.id },
      ...message,
    })
  } catch (error) {
    console.error('Message au centre pour une demande de réservation impossible', error)
  }
}
