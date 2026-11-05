import type { InboxShelf } from '../../app/(admin)/aujourdhui/journee.ts'
import type { StaffMailRequestRow } from '../courrier/demandes-queries.ts'
import { mailKindLabels, mailRequestKindLabels } from '../courrier/labels.ts'
import type { OfferRequestRow } from '../facturation/offres-portail.ts'
import { awaitsReception, proposalProductKey, proposalProductLabels } from '../facturation/propositions.ts'
import type { ProposalListItem } from '../facturation/propositions-queries.ts'
import type { PendingRequest } from '../reservations/demandes-queries.ts'
import { productOf } from '../ressources/produits.ts'
import {
  STAFF_NOTIFICATION_PANEL_LIMIT,
  inboxItemHref,
  inboxItemLabels,
  staffNotificationWhen,
  type InboxFeed,
  type InboxItem,
  type InboxItemKind,
} from './cloche.ts'
import { formatInstant, formatSlot } from './faits.ts'

/**
 * Les lignes de la cloche (ADR 070), tirées des mêmes files que la page
 * « Demandes » (ADR 048, ADR 057) et comptées comme son compteur
 * (`inboxCount`) : une fois chacune. Sans base : `cloche-queries.ts` lit les
 * files, ce module les met en lignes.
 */

export type InboxSources = {
  /** Réservations en attente de validation (`listPendingRequests`). */
  bookings: readonly PendingRequest[]
  /**
   * Devis en brouillon ou prêts (`listProposals`) : celui qui accompagne une
   * demande en attente en fait une « demande de devis » ; les brouillons sans
   * demande en attente sont à compléter (`awaitsReception`).
   */
  proposals: readonly ProposalListItem[]
  /** Demandes d'offre des derniers jours (`listOfferRequests`) : seules les « demandées » attendent. */
  offers: readonly OfferRequestRow[]
  /** Demandes de courrier déposées ou prises en charge : les plus récentes, et leur nombre. */
  mail: { rows: readonly StaffMailRequestRow[]; total: number }
}

const VISITOR = 'Visiteur du site'

/** Le premier nom connu : la fiche du client, sinon ce que le demandeur a saisi. */
function firstName(...names: readonly (string | null | undefined)[]): string {
  return names.map((name) => name?.trim()).find(Boolean) ?? VISITOR
}

const join = (...parts: readonly (string | null | undefined)[]) =>
  parts
    .map((part) => part?.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ')

type Line = Omit<InboxItem, 'label' | 'when' | 'href' | 'createdAt'> & { kind: InboxItemKind; shelf: InboxShelf; at: Date }

/**
 * Ce que la cloche affiche : le nombre de demandes à traiter et les plus
 * récentes, arrivée la plus récente en tête.
 */
export function buildInboxFeed(sources: InboxSources, timeZone: string, now: Date = new Date()): InboxFeed {
  const bookingsWithProposal = new Set(
    sources.proposals.flatMap((proposal) => (proposal.bookingId ? [proposal.bookingId] : [])),
  )
  const toComplete = sources.proposals.filter(awaitsReception)
  const openOffers = sources.offers.filter((offer) => offer.status === 'requested')

  const lines: Line[] = [
    ...sources.bookings.map(
      (booking): Line => ({
        id: booking.id,
        kind: bookingsWithProposal.has(booking.id) ? 'quote_request' : 'booking_request',
        shelf: productOf(booking.resource.resourceType).key,
        summary: join(booking.resource.name, formatSlot(booking.startsAt, booking.endsAt, timeZone)),
        who: firstName(booking.clientName, booking.bookedBy?.name, booking.requesterName),
        state: null,
        at: booking.createdAt,
      }),
    ),
    ...toComplete.map(
      (proposal): Line => ({
        id: proposal.id,
        // Une domiciliation demandée sur le site n'a pas de créneau : son
        // devis est la demande (ADR 043). Un devis de l'accueil se complète.
        kind: proposal.product === 'domiciliation' && proposal.channel !== 'staff' ? 'domiciliation_request' : 'proposal',
        // Rangé comme dans les pastilles de « Demandes » ; sans ressource, sous « Autres ».
        shelf: proposalProductKey(proposal) ?? 'autres',
        summary: join(`Devis ${proposal.number}`, proposal.resourceName ?? proposalProductLabels[proposal.product]),
        who: firstName(proposal.clientName, proposal.requesterCompany, proposal.requesterName),
        state: null,
        at: proposal.createdAt,
      }),
    ),
    ...openOffers.map(
      (offer): Line => ({
        id: offer.id,
        kind: 'offer_request',
        // Une offre groupée ne relève d'aucun produit.
        shelf: 'autres',
        summary: offer.offerName,
        who: firstName(offer.clientName, offer.requestedByName),
        state: null,
        at: offer.requestedAt,
      }),
    ),
    ...sources.mail.rows.map(
      (request): Line => ({
        id: request.id,
        kind: 'mail_request',
        shelf: 'domiciliation',
        // Ni l'expéditeur ni la consigne du client (ADR 015) : la fiche du pli les montre.
        summary: join(
          mailRequestKindLabels[request.kind],
          `${mailKindLabels[request.mailKind]} du ${formatInstant(request.mailReceivedAt, timeZone)}`,
        ),
        who: firstName(request.clientName),
        state: request.status === 'in_progress' ? 'Prise en charge' : null,
        at: request.requestedAt,
      }),
    ),
  ]

  lines.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))

  return {
    count: sources.bookings.length + toComplete.length + openOffers.length + sources.mail.total,
    items: lines.slice(0, STAFF_NOTIFICATION_PANEL_LIMIT).map(({ at, shelf, ...line }) => ({
      ...line,
      label: inboxItemLabels[line.kind],
      createdAt: at.toISOString(),
      when: staffNotificationWhen(at, timeZone, now),
      href: inboxItemHref(line.kind, line.id, shelf),
    })),
  }
}
