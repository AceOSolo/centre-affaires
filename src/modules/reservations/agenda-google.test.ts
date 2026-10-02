import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  GOOGLE_SCOPES,
  authorizationUrl,
  calendarActionFor,
  calendarEventFor,
  calendarOperationsFor,
  emailFromIdToken,
  googleConfig,
  googleEventId,
  hasCalendarScope,
  pkceChallenge,
} from './agenda-google.ts'

const BOOKING_ID = '01999f00-0000-7000-8000-0000000000c1'

/** Une demande du site public, avec l'identité que l'ADR 005 lui fait porter. */
const demande = {
  id: BOOKING_ID,
  resourceId: 'salle-mont-blanc',
  kind: 'booking' as const,
  status: 'confirmed' as const,
  title: 'Réunion de cadrage',
  notes: 'Prévoir un vidéoprojecteur, rappeler Camille au 06 12 34 56 78',
  startsAt: new Date('2026-10-25T08:00:00Z'),
  endsAt: new Date('2026-10-25T10:00:00Z'),
  requesterName: 'Camille Rousseau',
  requesterEmail: 'camille@exemple.fr',
  requesterPhone: '06 12 34 56 78',
}

const config = googleConfig({
  GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'secret',
  APP_URL: 'https://centre.exemple.fr',
  SECRETS_ENCRYPTION_KEY: 'clé',
})!

describe('Google Agenda : ce qui y est écrit', () => {
  it('écrit toute réservation confirmée et retire une réservation annulée', () => {
    assert.equal(calendarActionFor(demande), 'write')
    assert.equal(calendarActionFor({ ...demande, status: 'cancelled' }), 'remove')
  })

  it('écrit aussi les réservations posées par l’équipe, qui n’ont pas de demandeur', () => {
    const reservationEquipe = { ...demande, requesterName: null, requesterEmail: null, requesterPhone: null }
    assert.equal(calendarActionFor(reservationEquipe), 'write')
  })

  it('n’écrit ni une demande encore en attente, ni une indisponibilité', () => {
    assert.equal(calendarActionFor({ ...demande, status: 'pending' }), 'none')
    assert.equal(calendarActionFor({ ...demande, kind: 'unavailability' }), 'none')
  })

  const calendars = new Map([
    ['salle-mont-blanc', 'agenda-mont-blanc'],
    ['salle-cervin', 'agenda-cervin'],
  ])

  it('n’écrit que dans l’agenda de la ressource réservée', () => {
    assert.deepEqual(calendarOperationsFor(demande, calendars), [
      { type: 'write', calendarId: 'agenda-mont-blanc' },
    ])
    assert.deepEqual(calendarOperationsFor({ ...demande, resourceId: 'salle-sans-agenda' }, calendars), [])
  })

  it('retire de l’ancienne salle une réservation déplacée dans une autre', () => {
    assert.deepEqual(calendarOperationsFor({ ...demande, resourceId: 'salle-cervin' }, calendars, 'salle-mont-blanc'), [
      { type: 'remove', calendarId: 'agenda-mont-blanc' },
      { type: 'write', calendarId: 'agenda-cervin' },
    ])
    // Vers une salle sans agenda : elle quitte quand même l'ancien.
    assert.deepEqual(calendarOperationsFor({ ...demande, resourceId: 'salle-sans-agenda' }, calendars, 'salle-mont-blanc'), [
      { type: 'remove', calendarId: 'agenda-mont-blanc' },
    ])
    // Déplacée dans la même salle : une seule écriture.
    assert.deepEqual(calendarOperationsFor(demande, calendars, 'salle-mont-blanc'), [
      { type: 'write', calendarId: 'agenda-mont-blanc' },
    ])
  })

  it('ne transmet à Google aucune donnée personnelle du demandeur', () => {
    const event = calendarEventFor(demande, { name: 'Salle Mont Blanc' }, {
      timeZone: 'Europe/Paris',
      appUrl: 'https://centre.exemple.fr',
    })
    const sent = JSON.stringify(event)
    for (const personal of ['Camille', 'camille@exemple.fr', '06 12 34 56 78', 'vidéoprojecteur']) {
      assert.ok(!sent.includes(personal), `« ${personal} » ne doit pas partir chez Google`)
    }
    assert.equal(event.summary, 'Réunion de cadrage')
    assert.equal(event.location, 'Salle Mont Blanc')
    assert.match(event.description, /https:\/\/centre\.exemple\.fr\/reservations\/01999f00-/)
  })

  it('envoie les instants en UTC, accompagnés du fuseau du centre', () => {
    const event = calendarEventFor(demande, { name: 'Salle' }, {
      timeZone: 'Europe/Paris',
      appUrl: 'https://centre.exemple.fr',
    })
    assert.deepEqual(event.start, { dateTime: '2026-10-25T08:00:00.000Z', timeZone: 'Europe/Paris' })
    assert.deepEqual(event.end, { dateTime: '2026-10-25T10:00:00.000Z', timeZone: 'Europe/Paris' })
  })

  it('dérive de la réservation un identifiant d’événement stable et accepté par Google', () => {
    const id = googleEventId(BOOKING_ID)
    assert.equal(id, googleEventId(BOOKING_ID))
    // base32hex : a–v et 0–9, de 5 à 1024 caractères.
    assert.match(id, /^[a-v0-9]{5,1024}$/)
    assert.equal(calendarEventFor(demande, { name: 'Salle' }, {
      timeZone: 'Europe/Paris',
      appUrl: 'https://centre.exemple.fr',
    }).id, id)
  })
})

describe('Google Agenda : connexion', () => {
  it('n’est configurée que si toutes les pièces sont là', () => {
    assert.equal(googleConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', APP_URL: 'https://x.fr' }), undefined)
    assert.equal(config.redirectUri, 'https://centre.exemple.fr/ressources/agendas/retour')
  })

  it('demande le seul accès à l’agenda de l’application, hors ligne, avec PKCE', () => {
    const url = new URL(authorizationUrl(config, { state: 'etat', codeChallenge: 'defi' }))
    const scopes = url.searchParams.get('scope')?.split(' ')
    assert.deepEqual(scopes, GOOGLE_SCOPES)
    assert.ok(!scopes?.includes('https://www.googleapis.com/auth/calendar'))
    assert.ok(!scopes?.includes('https://www.googleapis.com/auth/calendar.events'))
    assert.equal(url.searchParams.get('access_type'), 'offline')
    assert.equal(url.searchParams.get('prompt'), 'consent')
    assert.equal(url.searchParams.get('state'), 'etat')
    assert.equal(url.searchParams.get('code_challenge'), 'defi')
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri)
  })

  it('calcule le défi PKCE de la RFC 7636', () => {
    // Vecteur de l'annexe B de la RFC.
    assert.equal(
      pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('refuse une connexion où l’accès à l’agenda a été décoché', () => {
    assert.equal(hasCalendarScope('openid https://www.googleapis.com/auth/userinfo.email'), false)
    assert.equal(hasCalendarScope(undefined), false)
    assert.equal(
      hasCalendarScope('https://www.googleapis.com/auth/calendar.app.created openid'),
      true,
    )
  })

  it('lit l’adresse du compte dans le jeton d’identité', () => {
    const token = (claims: object) =>
      `entete.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
    assert.equal(emailFromIdToken(token({ email: 'Centre@Gmail.com', email_verified: true })), 'centre@gmail.com')
    assert.equal(emailFromIdToken(token({ email: 'x@y.fr', email_verified: false })), undefined)
    assert.equal(emailFromIdToken('illisible'), undefined)
    assert.equal(emailFromIdToken(undefined), undefined)
  })
})
