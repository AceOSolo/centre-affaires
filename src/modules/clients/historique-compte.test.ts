import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatCents } from '../facturation/tarifs.ts'
import {
  bookingHistoryEntry,
  buildAccountHistory,
  contractDocumentHistoryEntry,
  groupHistoryByMonth,
  invoiceHistoryEntry,
  isHistoryCategory,
  mailRequestHistoryEntry,
  type HistoryBookingRow,
  type HistoryInvoiceRow,
  type HistoryMailRequestRow,
} from './historique-compte.ts'

const TZ = 'Europe/Paris'
const TODAY = '2026-10-15'
const DURAND = '01a00000-0000-7000-8000-00000000aa01'

const reservation = (overrides: Partial<HistoryBookingRow> = {}): HistoryBookingRow => ({
  id: 'b1',
  clientId: DURAND,
  clientName: 'Atelier Durand',
  resourceName: 'Salle Europe',
  title: 'Comité de direction',
  status: 'pending',
  channel: 'client',
  createdAt: new Date('2026-10-01T08:00:00Z'),
  startsAt: new Date('2026-10-20T07:00:00Z'),
  endsAt: new Date('2026-10-20T09:00:00Z'),
  bookedByName: 'Jeanne Martin',
  cancelledAt: null,
  cancellationReason: null,
  cancelledByMemberName: null,
  cancelledByStaff: false,
  ...overrides,
})

const demande = (overrides: Partial<HistoryMailRequestRow> = {}): HistoryMailRequestRow => ({
  id: 'm1',
  clientId: DURAND,
  clientName: 'Atelier Durand',
  kind: 'open_and_scan',
  status: 'requested',
  mailKind: 'recommande',
  sender: 'URSSAF',
  mailItemRemoved: false,
  receivedAt: new Date('2026-10-02T08:00:00Z'),
  requestedAt: new Date('2026-10-02T09:00:00Z'),
  requestedByMemberName: 'Jeanne Martin',
  startedAt: null,
  completedAt: null,
  refusedAt: null,
  refusalReason: null,
  cancelledAt: null,
  cancelledByMemberName: null,
  cancelledByStaff: false,
  forwardTrackingNumber: null,
  ...overrides,
})

const facture = (overrides: Partial<HistoryInvoiceRow> = {}): HistoryInvoiceRow => ({
  id: 'f1',
  kind: 'invoice',
  number: 'FA-2026-0012',
  status: 'issued',
  clientId: DURAND,
  clientName: 'Atelier Durand',
  currency: 'EUR',
  totalInclTaxCents: 12_000,
  paidCents: 0,
  creditedCents: 0,
  dueDate: '2026-10-31',
  issuedAt: new Date('2026-10-01T10:00:00Z'),
  ...overrides,
})

describe('historique du compte : réservations', () => {
  it('dit qui a demandé la réservation depuis l’espace client, et qu’elle attend', () => {
    const entry = bookingHistoryEntry(reservation(), TZ)
    assert.equal(entry.title, 'Réservation — Salle Europe')
    assert.deepEqual(entry.outcome, { label: 'En attente de validation', tone: 'waiting' })
    assert.equal(entry.steps[0].label, 'Demandée depuis l’espace client par Jeanne Martin')
    assert.match(entry.detail ?? '', /mardi 20 octobre 2026, 09:00 – 11:00 · Comité de direction/)
  })

  it('garde une demande annulée, avec la date et la personne qui l’a annulée', () => {
    const cancelledAt = new Date('2026-10-03T12:00:00Z')
    const entry = bookingHistoryEntry(
      reservation({
        status: 'cancelled',
        cancelledAt,
        cancellationReason: 'Annulée par le client',
        cancelledByMemberName: 'Paul Durand',
      }),
      TZ,
    )
    assert.deepEqual(entry.outcome, { label: 'Annulée', tone: 'closed' })
    assert.deepEqual(entry.steps.at(-1), { label: 'Annulée par Paul Durand', at: cancelledAt })
    // Le motif posé par l'espace client répète l'étape : il n'est pas redit.
    assert.deepEqual(entry.notes, [])
  })

  it('donne le motif d’une annulation par le centre', () => {
    const entry = bookingHistoryEntry(
      reservation({
        status: 'cancelled',
        cancelledAt: new Date('2026-10-03T12:00:00Z'),
        cancellationReason: 'Salle indisponible ce jour-là',
        cancelledByStaff: true,
      }),
      TZ,
    )
    assert.equal(entry.steps.at(-1)?.label, 'Annulée par le centre')
    assert.deepEqual(entry.notes, ['Motif : Salle indisponible ce jour-là'])
  })

  it('distingue une réservation saisie par le centre d’une demande du site', () => {
    assert.equal(
      bookingHistoryEntry(reservation({ channel: 'staff', bookedByName: null, status: 'confirmed' }), TZ)
        .steps[0].label,
      'Enregistrée par le centre',
    )
    const publique = bookingHistoryEntry(reservation({ channel: 'public', bookedByName: null, status: 'confirmed' }), TZ)
    assert.equal(publique.steps[0].label, 'Demandée depuis le site')
    // La base ne date pas la confirmation : l'étape est dite, sans date.
    assert.deepEqual(publique.steps.at(-1), { label: 'Confirmée', at: null })
  })

  it('écrit un créneau de plusieurs jours de bout en bout', () => {
    const entry = bookingHistoryEntry(
      reservation({
        startsAt: new Date('2026-10-20T07:00:00Z'),
        endsAt: new Date('2026-10-22T16:00:00Z'),
      }),
      TZ,
    )
    assert.match(entry.detail ?? '', /^du 20 oct\. 2026 à 09:00 au 22 oct\. 2026 à 18:00/)
  })
})

describe('historique du compte : demandes de courrier', () => {
  it('retrace chaque étape d’une demande faite', () => {
    const entry = mailRequestHistoryEntry(
      demande({
        status: 'done',
        startedAt: new Date('2026-10-02T10:00:00Z'),
        completedAt: new Date('2026-10-02T11:00:00Z'),
      }),
      TZ,
    )
    assert.equal(entry.title, 'Demande d’ouverture et de numérisation')
    assert.deepEqual(entry.outcome, { label: 'Faite', tone: 'done' })
    assert.deepEqual(
      entry.steps.map((step) => step.label),
      ['Déposée par Jeanne Martin', 'Prise en charge par le centre', 'Pli ouvert et numérisé'],
    )
    assert.match(entry.detail ?? '', /^Recommandé de URSSAF, reçu le 2 oct\. 2026/)
  })

  it('garde une demande annulée par la personne, sans l’effacer', () => {
    const cancelledAt = new Date('2026-10-02T09:30:00Z')
    const entry = mailRequestHistoryEntry(
      demande({ status: 'cancelled', cancelledAt, cancelledByMemberName: 'Jeanne Martin' }),
      TZ,
    )
    assert.deepEqual(entry.outcome, { label: 'Annulée', tone: 'closed' })
    assert.deepEqual(entry.steps.at(-1), { label: 'Annulée par Jeanne Martin', at: cancelledAt })
  })

  it('donne le motif d’un refus et le suivi d’une réexpédition', () => {
    const refusee = mailRequestHistoryEntry(
      demande({ kind: 'scan', status: 'refused', refusedAt: new Date('2026-10-03T08:00:00Z'), refusalReason: 'Pli déjà numérisé' }),
      TZ,
    )
    assert.deepEqual(refusee.notes, ['Motif : Pli déjà numérisé'])
    const reexpediee = mailRequestHistoryEntry(
      demande({
        kind: 'forward',
        status: 'done',
        requestedByMemberName: null,
        completedAt: new Date('2026-10-04T08:00:00Z'),
        forwardTrackingNumber: '1A23456789',
      }),
      TZ,
    )
    assert.equal(reexpediee.steps[0].label, 'Déposée par l’accueil, à votre demande')
    assert.equal(reexpediee.steps.at(-1)?.label, 'Pli réexpédié')
    assert.deepEqual(reexpediee.notes, ['Numéro de suivi : 1A23456789'])
  })

  it('ne montre plus l’expéditeur d’un pli retiré par le centre', () => {
    const entry = mailRequestHistoryEntry(
      demande({ status: 'refused', sender: null, mailItemRemoved: true, refusedAt: new Date('2026-10-03T08:00:00Z'), refusalReason: 'Courrier retiré : enregistré par erreur.' }),
      TZ,
    )
    assert.doesNotMatch(entry.detail ?? '', /URSSAF/)
    assert.match(entry.detail ?? '', /retiré par le centre/)
    assert.equal(entry.link, null)
  })
})

describe('historique du compte : documents et factures', () => {
  it('ouvre le document archivé d’un avenant', () => {
    const entry = contractDocumentHistoryEntry({
      contractId: 'c1',
      clientId: DURAND,
      clientName: 'Atelier Durand',
      reference: 'CT-2026-0004',
      version: 2,
      amendmentNumber: 1,
      createdAt: new Date('2026-09-01T08:00:00Z'),
    })
    assert.equal(entry.title, 'Avenant n° 1 au contrat CT-2026-0004')
    assert.deepEqual(entry.link, { href: '/compte/contrats/c1/document?version=2', label: 'Voir le document' })
  })

  it('dit d’une facture ce qu’il reste à régler', () => {
    const entry = invoiceHistoryEntry(facture({ status: 'partially_paid', paidCents: 2_000 }), TODAY)
    assert.equal(entry.title, 'Facture FA-2026-0012')
    assert.deepEqual(entry.outcome, { label: 'Payée en partie', tone: 'due' })
    assert.deepEqual(entry.notes, [`Reste à régler : ${formatCents(10_000, 'EUR')}`])
    assert.equal(entry.link?.href, '/compte/factures/f1')
  })

  it('présente un avoir comme émis, sans rien à régler', () => {
    const entry = invoiceHistoryEntry(facture({ kind: 'credit_note', number: 'AV-2026-0001', dueDate: null }), TODAY)
    assert.equal(entry.title, 'Avoir AV-2026-0001')
    assert.equal(entry.steps[0].label, 'Émis')
    assert.deepEqual(entry.notes, [])
  })
})

describe('historique du compte : assemblage', () => {
  it('range tout du plus récent au plus ancien, toutes rubriques confondues', () => {
    const entries = buildAccountHistory(
      {
        bookings: [reservation({ createdAt: new Date('2026-10-01T08:00:00Z') })],
        mailRequests: [demande({ requestedAt: new Date('2026-10-02T09:00:00Z') })],
        contractDocuments: [
          {
            contractId: 'c1',
            clientId: DURAND,
            clientName: 'Atelier Durand',
            reference: 'CT-2026-0004',
            version: 1,
            amendmentNumber: null,
            createdAt: new Date('2026-09-30T08:00:00Z'),
          },
        ],
        invoices: [facture({ issuedAt: new Date('2026-10-01T10:00:00Z') })],
      },
      { timeZone: TZ, today: TODAY },
    )
    assert.deepEqual(
      entries.map((entry) => entry.key),
      ['courrier:m1', 'factures:f1', 'reservations:b1', 'contrats:c1:1'],
    )
  })

  it('groupe par mois du centre, pas par mois UTC', () => {
    // Le 1er octobre à 0h30 à Paris est encore le 30 septembre en UTC.
    const entries = buildAccountHistory(
      {
        bookings: [
          reservation({ id: 'oct', createdAt: new Date('2026-09-30T22:30:00Z') }),
          reservation({ id: 'sep', createdAt: new Date('2026-09-30T21:30:00Z') }),
        ],
        mailRequests: [],
        contractDocuments: [],
        invoices: [],
      },
      { timeZone: TZ, today: TODAY },
    )
    assert.deepEqual(
      groupHistoryByMonth(entries, TZ).map((group) => [group.month, group.entries.map((entry) => entry.key)]),
      [
        ['2026-10', ['reservations:oct']],
        ['2026-09', ['reservations:sep']],
      ],
    )
  })

  it('ne connaît que ses quatre rubriques', () => {
    assert.equal(isHistoryCategory('factures'), true)
    assert.equal(isHistoryCategory('brouillons'), false)
    assert.equal(isHistoryCategory(undefined), false)
  })
})
