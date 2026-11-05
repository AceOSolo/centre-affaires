import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  feedIdFromToken,
  feedToken,
  feedUrl,
  googleCalendarAddUrl,
  icsCalendar,
  isFeedToken,
  isListedInFeed,
  webcalUrl,
} from './agenda-ics.ts'
import type { Booking } from './schema.ts'

const FEED_ID = '01999f00-0000-7000-8000-0000000000f1'
const TENANT_ID = '01999f00-0000-7000-8000-000000000001'
const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000c9'
const SECRET = 'secret-du-serveur'

describe('lien d’agenda : le jeton (ADR 071)', () => {
  const token = feedToken(FEED_ID, TENANT_ID, SECRET)

  it('porte l’identifiant du lien et une signature, sans rien à échapper', () => {
    assert.match(token, /^[0-9a-f]{72}$/)
    assert.equal(feedIdFromToken(token), FEED_ID)
  })

  it('n’ouvre que le lien et le centre pour lesquels il a été signé', () => {
    assert.ok(isFeedToken(token, { id: FEED_ID, tenantId: TENANT_ID }, SECRET))
    assert.equal(isFeedToken(token, { id: FEED_ID, tenantId: AUTRE_CENTRE }, SECRET), false)
    assert.equal(isFeedToken(token, { id: FEED_ID, tenantId: TENANT_ID }, 'autre-secret'), false)
    const altere = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')
    assert.equal(isFeedToken(altere, { id: FEED_ID, tenantId: TENANT_ID }, SECRET), false)
  })

  it('change avec le lien : régénérer, c’est un autre identifiant', () => {
    const autre = feedToken('01999f00-0000-7000-8000-0000000000f2', TENANT_ID, SECRET)
    assert.notEqual(autre, token)
    assert.equal(isFeedToken(token, { id: '01999f00-0000-7000-8000-0000000000f2', tenantId: TENANT_ID }, SECRET), false)
  })

  it('refuse un jeton mal formé', () => {
    assert.equal(feedIdFromToken('abc'), undefined)
    assert.equal(feedIdFromToken(token.toUpperCase()), undefined)
    assert.equal(feedIdFromToken(`${token}0`), undefined)
  })

  it('donne l’adresse à coller, et les deux abonnements en un clic', () => {
    const url = feedUrl('https://www.handfield.fr', token)
    assert.equal(url, `https://www.handfield.fr/api/agendas/${token}.ics`)
    assert.equal(webcalUrl(url), `webcal://www.handfield.fr/api/agendas/${token}.ics`)
    const google = new URL(googleCalendarAddUrl(url))
    assert.equal(google.origin, 'https://calendar.google.com')
    assert.equal(google.searchParams.get('cid'), webcalUrl(url))
  })
})

describe('lien d’agenda : ce qu’il montre', () => {
  /** Une demande du site public, avec l'identité que l'ADR 005 lui fait porter. */
  const demande = {
    id: '01999f00-0000-7000-8000-0000000000c1',
    kind: 'booking' as Booking['kind'],
    status: 'confirmed' as Booking['status'],
    title: 'Réunion de cadrage',
    startsAt: new Date('2026-10-25T08:00:00Z'),
    endsAt: new Date('2026-10-25T10:00:00Z'),
    updatedAt: new Date('2026-10-20T09:30:00.123Z'),
    notes: 'Prévoir un vidéoprojecteur, rappeler Camille au 06 12 34 56 78',
    requesterName: 'Camille Rousseau',
    requesterEmail: 'camille@exemple.fr',
    requesterPhone: '06 12 34 56 78',
  }
  const options = { tenantName: 'Centre Lyon', timeZone: 'Europe/Paris', appUrl: 'https://www.handfield.fr' }
  const agenda = (bookings: (typeof demande)[], name = 'Salle Mont-Blanc') => icsCalendar(bookings, { name }, options)
  const unfold = (ics: string) => ics.replace(/\r\n /g, '')

  it('montre les réservations confirmées, pas les demandes en attente, annulées ou les indisponibilités', () => {
    assert.ok(isListedInFeed(demande))
    assert.equal(isListedInFeed({ ...demande, status: 'pending' }), false)
    assert.equal(isListedInFeed({ ...demande, status: 'cancelled' }), false)
    assert.equal(isListedInFeed({ ...demande, kind: 'unavailability' }), false)

    const ics = agenda([
      demande,
      { ...demande, id: '01999f00-0000-7000-8000-0000000000c2', status: 'pending' },
      { ...demande, id: '01999f00-0000-7000-8000-0000000000c3', status: 'cancelled' },
    ])
    assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 1)
    assert.match(ics, /UID:01999f00-0000-7000-8000-0000000000c1@www\.handfield\.fr/)
  })

  it('ne transmet aucune donnée personnelle du demandeur', () => {
    const ics = unfold(agenda([demande]))
    for (const personnel of ['Camille', 'camille@exemple.fr', '06 12 34 56 78', 'vidéoprojecteur']) {
      assert.ok(!ics.includes(personnel), `${personnel} ne doit pas figurer dans l’agenda`)
    }
  })

  it('écrit les instants en UTC, et nomme l’agenda d’après la ressource et le centre', () => {
    const ics = unfold(agenda([demande]))
    assert.match(ics, /\r\nDTSTART:20261025T080000Z\r\n/)
    assert.match(ics, /\r\nDTEND:20261025T100000Z\r\n/)
    assert.match(ics, /\r\nDTSTAMP:20261020T093000Z\r\n/)
    assert.match(ics, /\r\nX-WR-CALNAME:Salle Mont-Blanc — Centre Lyon\r\n/)
    assert.match(ics, /\r\nX-WR-TIMEZONE:Europe\/Paris\r\n/)
    assert.match(ics, /DESCRIPTION:Fiche de la réservation : https:\/\/www\.handfield\.fr\/reservations\/01999f00/)
  })

  it('garde d’un bloc une location de plusieurs jours, changement d’heure compris', () => {
    const location = { ...demande, startsAt: new Date('2026-10-23T06:00:00Z'), endsAt: new Date('2026-10-26T17:00:00Z') }
    const ics = unfold(agenda([location], 'Camion'))
    assert.match(ics, /DTSTART:20261023T060000Z\r\nDTEND:20261026T170000Z/)
  })

  it('échappe le texte libre de l’objet', () => {
    const ics = unfold(agenda([{ ...demande, title: 'Séminaire; étage 2, salle A\\B\nsuite' }]))
    assert.match(ics, /\r\nSUMMARY:Séminaire\\; étage 2\\, salle A\\\\B\\nsuite\r\n/)
  })

  it('suit le format attendu : lignes CRLF de 75 octets au plus, accents intacts', () => {
    const long = `Comité de direction élargi — préparation du budget ${'é'.repeat(80)}`
    const ics = agenda([{ ...demande, title: long }])
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'))
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'))
    assert.ok(!/[^\r]\n/.test(ics), 'chaque fin de ligne est un CRLF')
    for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line)
    assert.ok(unfold(ics).includes(`SUMMARY:${long}`))
    assert.ok(!ics.includes('�'))
  })

  it('reste un agenda valide sans aucune réservation', () => {
    const ics = agenda([])
    assert.ok(!ics.includes('BEGIN:VEVENT'))
    assert.match(ics, /BEGIN:VCALENDAR[\s\S]*END:VCALENDAR\r\n$/)
  })
})
