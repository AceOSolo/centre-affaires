import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CLIENT_BELL_DEFAULT_DAYS,
  CLIENT_BELL_MAX_DAYS,
  CLIENT_BELL_PANEL_LIMIT,
  buildClientBellItems,
  clientBellBadge,
  clientBellEvents,
  clientBellHref,
  clientBellLabels,
  clientBellPhrase,
  clientBellSettingsFromRow,
  clientBellSince,
  readClientBellSettingsForm,
  shownClientBellEvents,
  unreadMailPhrase,
  type ClientBellSource,
} from './cloche-client.ts'
import { notificationEventAudience } from './schema.ts'

/** Un formulaire fictif : `getAll` pour les cases, `get` pour la durée. */
const form = (fields: Record<string, string | string[]>) => ({
  get: (name: string) => {
    const value = fields[name]
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
  },
  getAll: (name: string) => {
    const value = fields[name]
    return Array.isArray(value) ? value : value === undefined ? [] : [value]
  },
})

const source = (overrides: Partial<ClientBellSource> = {}): ClientBellSource => ({
  id: '01a00000-0000-7000-8000-000000000001',
  event: 'mail_scanned',
  clientId: '01a00000-0000-7000-8000-0000000000c1',
  clientName: 'Atelier Durand',
  subject: 'Votre courrier a été numérisé — Atelier Durand',
  sentAt: new Date('2026-11-17T09:00:00Z'),
  relatedType: 'mail_item',
  relatedId: '01a00000-0000-7000-8000-0000000000a1',
  mailItemId: null,
  read: false,
  ...overrides,
})

describe('cloche de l’espace client : ce qui la nourrit', () => {
  it('ne retient que des messages adressés au client', () => {
    for (const event of clientBellEvents) assert.equal(notificationEventAudience[event], 'client', event)
  })

  it('laisse de côté l’avis quotidien, l’invitation et les factures du site', () => {
    for (const event of ['mail_none', 'member_invited', 'invoice_issued', 'invoice_reminder']) {
      assert.equal((clientBellEvents as readonly string[]).includes(event), false, event)
    }
  })

  it('nomme chaque nouveauté', () => {
    for (const event of clientBellEvents) assert.ok(clientBellLabels[event].length > 0, event)
    assert.equal(clientBellLabels.mail_scanned, 'Numérisation prête')
    assert.equal(clientBellLabels.client_broadcast, 'Message du centre')
  })
})

describe('cloche de l’espace client : où mène chaque nouveauté', () => {
  it('mène au pli, à la boîte, à la réservation, au contrat, à l’état des lieux, au message', () => {
    assert.equal(clientBellHref(source()), '/compte/courrier/01a00000-0000-7000-8000-0000000000a1')
    assert.equal(clientBellHref(source({ event: 'mail_batch_received', relatedType: 'mail_batch' })), '/compte/courrier')
    assert.equal(
      clientBellHref(source({ event: 'booking_request_accepted', relatedType: 'booking', relatedId: 'b1' })),
      '/compte/reservations#resa-b1',
    )
    assert.equal(
      clientBellHref(source({ event: 'contract_activated', relatedType: 'contract', relatedId: 'c1' })),
      '/compte/contrats#contrat-c1',
    )
    assert.equal(
      clientBellHref(source({ event: 'inspection_to_sign', relatedType: 'inspection', relatedId: 'e1' })),
      '/compte/etats-des-lieux/e1',
    )
    assert.equal(
      clientBellHref(source({ event: 'client_broadcast', relatedType: 'client_broadcast', relatedId: 'm1' })),
      '/compte/messages/m1',
    )
  })

  it('mène une demande de courrier à la fiche de son pli, à défaut à la liste des demandes', () => {
    const demande = { event: 'mail_request_done' as const, relatedType: 'mail_request' as const, relatedId: 'r1' }
    assert.equal(clientBellHref(source({ ...demande, mailItemId: 'p1' })), '/compte/courrier/p1')
    assert.equal(clientBellHref(source({ ...demande, mailItemId: null })), '/compte/courrier/demandes')
  })

  it('retombe sur la rubrique quand l’entité manque', () => {
    assert.equal(clientBellHref(source({ relatedType: null, relatedId: null })), '/compte/courrier')
    assert.equal(clientBellHref(source({ event: 'booking_cancelled', relatedType: null, relatedId: null })), '/compte/reservations')
    assert.equal(clientBellHref(source({ event: 'client_broadcast', relatedType: null, relatedId: null })), '/compte')
  })
})

describe('cloche de l’espace client : lignes du panneau', () => {
  const now = new Date('2026-11-17T10:00:00Z')

  it('range les plus récentes d’abord, bornées, avec l’état lu et le moment à l’heure du centre', () => {
    const sources = Array.from({ length: CLIENT_BELL_PANEL_LIMIT + 5 }, (_, index) =>
      source({
        id: `01a00000-0000-7000-8000-${String(index).padStart(12, '0')}`,
        sentAt: new Date(now.getTime() - (index + 1) * 60_000),
        read: index % 2 === 1,
      }),
    )
    const items = buildClientBellItems(sources.reverse(), { timeZone: 'Europe/Paris', now, showClient: false })
    assert.equal(items.length, CLIENT_BELL_PANEL_LIMIT)
    assert.equal(items[0]?.when, 'il y a 1 min')
    assert.equal(items[0]?.read, false)
    assert.equal(items[1]?.read, true)
    assert.equal(items[0]?.label, 'Numérisation prête')
    assert.equal(items[0]?.summary, 'Votre courrier a été numérisé — Atelier Durand')
    assert.equal(items[0]?.who, null)
  })

  it('nomme l’entreprise quand le compte en a plusieurs', () => {
    const [item] = buildClientBellItems([source()], { timeZone: 'Europe/Paris', now, showClient: true })
    assert.equal(item?.who, 'Atelier Durand')
  })

  it('dit le nombre en toutes lettres, et « 99+ » sur la pastille', () => {
    assert.equal(clientBellPhrase(0), 'aucune nouveauté')
    assert.equal(clientBellPhrase(1), '1 nouveauté')
    assert.equal(clientBellPhrase(4), '4 nouveautés')
    assert.equal(clientBellBadge(0), null)
    assert.equal(clientBellBadge(120), '99+')
    assert.equal(unreadMailPhrase(1), '1 nouveau courrier')
    assert.equal(unreadMailPhrase(3), '3 nouveaux courriers')
  })
})

describe('cloche de l’espace client : réglage du centre', () => {
  it('montre tout pendant trente jours tant que rien n’est réglé', () => {
    const settings = clientBellSettingsFromRow(undefined)
    assert.equal(settings.windowDays, CLIENT_BELL_DEFAULT_DAYS)
    assert.deepEqual(shownClientBellEvents(settings), [...clientBellEvents])
  })

  it('ignore une nature inconnue et une durée hors bornes relues en base', () => {
    const settings = clientBellSettingsFromRow({ hiddenEvents: ['mail_scanned', 'disparu', 'mail_scanned'], windowDays: 400 })
    assert.deepEqual(settings.hiddenEvents, ['mail_scanned'])
    assert.equal(settings.windowDays, CLIENT_BELL_DEFAULT_DAYS)
    assert.equal(shownClientBellEvents(settings).includes('mail_scanned'), false)
  })

  it('lit les cases cochées comme les nouveautés montrées, les autres retirées', () => {
    const read = readClientBellSettingsForm(form({ evenement: ['mail_scanned', 'client_broadcast', 'inconnu'], windowDays: '14' }))
    assert.ok(read.settings)
    assert.equal(read.settings.windowDays, 14)
    assert.deepEqual(shownClientBellEvents(read.settings), ['mail_scanned', 'client_broadcast'])
    assert.equal(read.settings.hiddenEvents.length, clientBellEvents.length - 2)
  })

  it('admet une cloche muette, refuse une durée hors de 1 à 90 jours', () => {
    assert.deepEqual(readClientBellSettingsForm(form({ windowDays: '1' })).settings?.hiddenEvents, [...clientBellEvents])
    for (const days of ['0', String(CLIENT_BELL_MAX_DAYS + 1), '', '7.5', '-3', 'dix']) {
      assert.ok(readClientBellSettingsForm(form({ windowDays: days })).errors?.windowDays, days)
    }
    assert.equal(readClientBellSettingsForm(form({ windowDays: String(CLIENT_BELL_MAX_DAYS) })).settings?.windowDays, 90)
  })

  it('compte la période depuis maintenant', () => {
    const now = new Date('2026-11-17T10:00:00Z')
    assert.equal(clientBellSince(now, 30).toISOString(), '2026-10-18T10:00:00.000Z')
  })
})
