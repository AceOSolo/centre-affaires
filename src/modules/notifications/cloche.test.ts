import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { inboxCount } from '../../app/(admin)/aujourdhui/journee.ts'
import type { StaffMailRequestRow } from '../courrier/demandes-queries.ts'
import type { OfferRequestRow } from '../facturation/offres-portail.ts'
import type { ProposalListItem } from '../facturation/propositions-queries.ts'
import type { PendingRequest } from '../reservations/demandes-queries.ts'
import {
  STAFF_NOTIFICATION_PANEL_LIMIT,
  inboxBadge,
  inboxItemHref,
  inboxItemKinds,
  inboxItemLabels,
  inboxPhrase,
  staffNotificationWhen,
} from './cloche.ts'
import { buildInboxFeed, type InboxSources } from './cloche-liste.ts'

/** Règles de la cloche de l'équipe (ADR 059, ADR 070), sans base. */
describe('cloche de l’équipe : règles', () => {
  it('donne à chaque sorte de demande son libellé et son ancre dans « Demandes »', () => {
    for (const kind of inboxItemKinds) {
      assert.ok(inboxItemLabels[kind], kind)
      assert.match(inboxItemHref(kind, 'abc'), /^\/demandes#(demande|devis|offre|courrier)-abc$/, kind)
    }
    assert.equal(inboxItemHref('booking_request', 'r1'), '/demandes#demande-r1')
    assert.equal(inboxItemHref('quote_request', 'r1'), '/demandes#demande-r1')
    assert.equal(inboxItemHref('domiciliation_request', 'd1'), '/demandes#devis-d1')
    assert.equal(inboxItemHref('proposal', 'd2'), '/demandes#devis-d2')
    assert.equal(inboxItemHref('offer_request', 'o1'), '/demandes#offre-o1')
    assert.equal(inboxItemHref('mail_request', 'm1'), '/demandes#courrier-m1')
  })

  it('dit « quand » à l’heure du centre', () => {
    const now = new Date('2026-11-04T09:30:00Z') // 10:30 à Paris
    const paris = 'Europe/Paris'
    assert.equal(staffNotificationWhen(new Date('2026-11-04T09:29:40Z'), paris, now), 'à l’instant')
    assert.equal(staffNotificationWhen(new Date('2026-11-04T09:18:00Z'), paris, now), 'il y a 12 min')
    assert.equal(staffNotificationWhen(new Date('2026-11-04T07:05:00Z'), paris, now), 'aujourd’hui à 08:05')
    assert.equal(staffNotificationWhen(new Date('2026-11-03T16:02:00Z'), paris, now), 'hier à 17:02')
    assert.equal(staffNotificationWhen(new Date('2026-10-30T09:00:00Z'), paris, now), '30 oct. 2026 à 10:00')
    // Minuit passé à Paris, pas encore en UTC : la veille de Paris, c'est bien « hier ».
    assert.equal(
      staffNotificationWhen(new Date('2026-11-03T22:30:00Z'), paris, new Date('2026-11-03T23:30:00Z')),
      'hier à 23:30',
    )
  })

  it('annonce le nombre à traiter, et borne la pastille', () => {
    assert.equal(inboxPhrase(0), 'aucune demande à traiter')
    assert.equal(inboxPhrase(1), '1 demande à traiter')
    assert.equal(inboxPhrase(4), '4 demandes à traiter')
    assert.equal(inboxBadge(0), null)
    assert.equal(inboxBadge(7), '7')
    assert.equal(inboxBadge(150), '99+')
  })
})

describe('cloche de l’équipe : les lignes', () => {
  const paris = 'Europe/Paris'
  const now = new Date('2026-11-05T10:00:00Z')
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000)

  // Des files réduites aux champs que la cloche lit.
  const booking = (id: string, minutesAgo: number, extra: Partial<PendingRequest> = {}) =>
    ({
      id,
      createdAt: at(minutesAgo),
      startsAt: new Date('2026-11-09T08:00:00Z'),
      endsAt: new Date('2026-11-09T10:00:00Z'),
      requesterName: null,
      clientName: 'Atelier Durand',
      bookedBy: null,
      resource: { name: 'Salle Atlas' },
      ...extra,
    }) as unknown as PendingRequest
  const proposal = (id: string, minutesAgo: number, extra: Partial<ProposalListItem> = {}) =>
    ({
      id,
      number: `DV-${id}`,
      product: 'espace',
      status: 'draft',
      channel: 'public',
      requesterName: 'Camille Rousseau',
      requesterCompany: null,
      createdAt: at(minutesAgo),
      bookingId: null,
      bookingStatus: null,
      clientName: null,
      resourceName: null,
      ...extra,
    }) as unknown as ProposalListItem
  const offer = (id: string, minutesAgo: number, status: OfferRequestRow['status']) =>
    ({
      id,
      requestedAt: at(minutesAgo),
      clientName: 'Atelier Durand',
      offerName: 'Domiciliation premium',
      requestedByName: 'Jeanne Durand',
      status,
    }) as unknown as OfferRequestRow
  const mail = (id: string, minutesAgo: number, status: StaffMailRequestRow['status']) =>
    ({
      id,
      kind: 'scan',
      status,
      requestedAt: at(minutesAgo),
      clientName: 'Atelier Durand',
      mailKind: 'lettre',
      mailSender: 'URSSAF',
      mailReceivedAt: new Date('2026-11-04T08:00:00Z'),
    }) as unknown as StaffMailRequestRow

  const sources: InboxSources = {
    bookings: [booking('b1', 50), booking('b2', 5, { clientName: null, requesterName: 'Camille Rousseau' })],
    proposals: [
      // Né avec la demande b2, encore en attente : il ne compte pas à part.
      proposal('p1', 5, { bookingId: 'b2', bookingStatus: 'pending' }),
      proposal('p2', 30, { product: 'domiciliation', requesterCompany: 'Rousseau Conseil' }),
      // Un devis de l'accueil, à compléter.
      proposal('p3', 90, { channel: 'staff', clientName: 'Atelier Durand', resourceName: 'Bureau 12' }),
      // Prêt : Dolibarr va le chercher, rien n'attend l'accueil.
      proposal('p4', 1, { status: 'ready' }),
    ],
    offers: [offer('o1', 20, 'requested'), offer('o2', 2, 'dismissed')],
    // Deux lignes lues sur trois demandes : le nombre vient du total.
    mail: { rows: [mail('m1', 10, 'requested'), mail('m2', 40, 'in_progress')], total: 3 },
  }

  it('compte comme « Demandes » et « Aujourd’hui » (`inboxCount`)', () => {
    const feed = buildInboxFeed(sources, paris, now)
    assert.equal(feed.count, 2 + 2 + 1 + 3)
    assert.equal(
      feed.count,
      inboxCount({
        pendingBookings: sources.bookings.length,
        proposalsToComplete: 2,
        offerRequests: sources.offers,
        mailRequests: sources.mail.total,
      }),
    )
  })

  it('range les plus récentes en tête, chacune avec son libellé et son demandeur', () => {
    const feed = buildInboxFeed(sources, paris, now)
    assert.deepEqual(
      feed.items.map((item) => [item.id, item.label, item.who]),
      [
        ['b2', 'Demande de devis', 'Camille Rousseau'],
        ['m1', 'Demande de courrier', 'Atelier Durand'],
        ['o1', 'Offre demandée', 'Atelier Durand'],
        ['p2', 'Demande de domiciliation', 'Rousseau Conseil'],
        ['m2', 'Demande de courrier', 'Atelier Durand'],
        ['b1', 'Demande de réservation', 'Atelier Durand'],
        ['p3', 'Devis à compléter', 'Atelier Durand'],
      ],
    )
    const [b2] = feed.items
    assert.equal(b2.when, 'il y a 5 min')
    assert.equal(b2.href, '/demandes#demande-b2')
    assert.equal(b2.createdAt, at(5).toISOString())
  })

  it('dit le visiteur à défaut de nom, et la prise en charge', () => {
    const anonyme = buildInboxFeed(
      { ...sources, bookings: [booking('b3', 1, { clientName: null, requesterName: '  ' })], proposals: [] },
      paris,
      now,
    )
    assert.equal(anonyme.items[0].who, 'Visiteur du site')

    const feed = buildInboxFeed(sources, paris, now)
    const state = (id: string) => feed.items.find((item) => item.id === id)?.state
    assert.equal(state('m2'), 'Prise en charge')
    assert.equal(state('m1'), null)
  })

  it('résume sans l’expéditeur du pli, à l’heure du centre', () => {
    const feed = buildInboxFeed(sources, paris, now)
    const m1 = feed.items.find((item) => item.id === 'm1')
    assert.equal(m1?.summary, 'Numérisation · Lettre du 4 nov. 2026 à 09:00')
    assert.doesNotMatch(JSON.stringify(feed), /URSSAF/)
    assert.equal(feed.items.find((item) => item.id === 'p3')?.summary, 'Devis DV-p3 · Bureau 12')
    assert.equal(feed.items.find((item) => item.id === 'p2')?.summary, 'Devis DV-p2 · Domiciliation')
  })

  it('borne la liste, pas le nombre', () => {
    const many = Array.from({ length: STAFF_NOTIFICATION_PANEL_LIMIT + 5 }, (_, index) =>
      booking(`b${String(index).padStart(2, '0')}`, index),
    )
    const feed = buildInboxFeed({ bookings: many, proposals: [], offers: [], mail: { rows: [], total: 0 } }, paris, now)
    assert.equal(feed.count, STAFF_NOTIFICATION_PANEL_LIMIT + 5)
    assert.equal(feed.items.length, STAFF_NOTIFICATION_PANEL_LIMIT)
    assert.equal(feed.items[0].id, 'b00')
  })
})
