import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import {
  GOOGLE_SCOPES,
  GoogleCalendarError,
  authorizationUrl,
  calendarActionFor,
  calendarEmbedCode,
  calendarEmbedUrl,
  calendarEventFor,
  calendarOperationsFor,
  checkGoogleClient,
  emailFromIdToken,
  googleConfig,
  googleEventId,
  hasCalendarScope,
  isGoogleClientId,
  listOwnedCalendars,
  isGoogleClientSecret,
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

describe('Google Agenda : le camion, et son agenda dans une autre page (ADR 064)', () => {
  // Rien n'est propre aux salles : le camion (type `vehicule`) a son agenda
  // comme toute ressource, y compris pour une location de plusieurs jours.
  const location = {
    ...demande,
    resourceId: 'camion',
    title: 'Déménagement',
    startsAt: new Date('2026-10-23T06:00:00Z'),
    endsAt: new Date('2026-10-26T17:00:00Z'),
  }

  it('écrit la location du camion dans l’agenda du camion, et la retire à l’annulation', () => {
    const calendars = new Map([['camion', 'agenda-camion']])
    assert.deepEqual(calendarOperationsFor(location, calendars), [{ type: 'write', calendarId: 'agenda-camion' }])
    assert.deepEqual(calendarOperationsFor({ ...location, status: 'cancelled' }, calendars), [
      { type: 'remove', calendarId: 'agenda-camion' },
    ])
  })

  it('garde d’un bloc une location de plusieurs jours, changement d’heure compris', () => {
    const event = calendarEventFor(location, { name: 'Camion 20 m³' }, {
      timeZone: 'Europe/Paris',
      appUrl: 'https://centre.exemple.fr',
    })
    assert.deepEqual(event.start, { dateTime: '2026-10-23T06:00:00.000Z', timeZone: 'Europe/Paris' })
    assert.deepEqual(event.end, { dateTime: '2026-10-26T17:00:00.000Z', timeZone: 'Europe/Paris' })
  })

  const calendarId = 'c0ffee42@group.calendar.google.com'

  it('donne l’adresse d’intégration de l’agenda, à l’heure du centre', () => {
    const url = new URL(calendarEmbedUrl(calendarId, 'Europe/Paris'))
    assert.equal(url.origin + url.pathname, 'https://calendar.google.com/calendar/embed')
    assert.equal(url.searchParams.get('src'), calendarId)
    assert.equal(url.searchParams.get('ctz'), 'Europe/Paris')
  })

  it('écrit un code d’intégration titré, sans rien rendre public', () => {
    const code = calendarEmbedCode({ calendarId, resourceName: 'Camion "20 m³" <utilitaire>' }, 'Europe/Paris')
    assert.match(code, /^<iframe src="https:\/\/calendar\.google\.com\/calendar\/embed\?src=c0ffee42%40group\.calendar\.google\.com&amp;ctz=Europe%2FParis" /)
    // Un nom de ressource ne casse pas l'attribut.
    assert.ok(code.includes('title="Agenda Google — Camion &quot;20 m³&quot; &lt;utilitaire&gt;"'))
    assert.ok(code.endsWith('></iframe>'))
    // Aucun paramètre ne touche au partage : il se règle dans Google Agenda.
    assert.deepEqual([...new URL(calendarEmbedUrl(calendarId, 'Europe/Paris')).searchParams.keys()], ['src', 'ctz'])
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
    // Écrire dans les agendas existants des salles (ADR 072), sans plus :
    // ni l'accès complet, ni les événements des agendas partagés au compte,
    // ni la lecture du contenu des agendas.
    assert.deepEqual(scopes?.filter((scope) => scope.includes('/auth/calendar')).sort(), [
      'https://www.googleapis.com/auth/calendar.app.created',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events.owned',
    ])
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
    // Le seul accès aux agendas créés par le site ne suffit plus (ADR 072).
    assert.equal(hasCalendarScope('https://www.googleapis.com/auth/calendar.app.created openid'), false)
    assert.equal(
      hasCalendarScope(
        'openid https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.app.created',
      ),
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

describe('Google Agenda : identifiants réglés à l’écran (ADR 069)', () => {
  const serveur = { APP_URL: 'https://centre.exemple.fr', SECRETS_ENCRYPTION_KEY: 'clé' }
  const ecran = { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-ecran' }

  it('prend les identifiants de l’écran plutôt que ceux du serveur', () => {
    const avecLesDeux = googleConfig(
      { ...serveur, GOOGLE_CLIENT_ID: 'serveur.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'serveur' },
      ecran,
    )
    assert.equal(avecLesDeux?.clientId, ecran.clientId)
    assert.equal(avecLesDeux?.clientSecret, ecran.clientSecret)
    assert.equal(avecLesDeux?.redirectUri, 'https://centre.exemple.fr/ressources/agendas/retour')
  })

  it('n’a besoin d’aucune variable GOOGLE_* sur le serveur', () => {
    assert.ok(googleConfig(serveur, ecran))
    assert.equal(googleConfig(serveur), undefined)
  })

  it('garde l’adresse du site et la clé de chiffrement comme réglages du serveur', () => {
    assert.equal(googleConfig({ APP_URL: serveur.APP_URL }, ecran), undefined)
    assert.equal(googleConfig({ SECRETS_ENCRYPTION_KEY: 'clé' }, ecran), undefined)
  })

  it('reconnaît un ID client copié de Google Cloud, et refuse un collage incomplet', () => {
    assert.ok(isGoogleClientId('1234567890-abcdefghijklmnop0123456789abcdef.apps.googleusercontent.com'))
    assert.equal(isGoogleClientId('1234567890-abcdefghijklmnop'), false)
    assert.equal(isGoogleClientId('1234 5678.apps.googleusercontent.com'), false)
    assert.equal(isGoogleClientId('.apps.googleusercontent.com'), false)
    assert.equal(isGoogleClientId(`${'a'.repeat(250)}.apps.googleusercontent.com`), false)
  })

  it('reconnaît un code secret d’un seul mot', () => {
    assert.ok(isGoogleClientSecret('GOCSPX-AbCdEf_123456-xyz'))
    assert.equal(isGoogleClientSecret('court'), false)
    assert.equal(isGoogleClientSecret('GOCSPX AbCdEf'), false)
  })

  describe('vérification auprès de Google', () => {
    const repondre = (status: number, body: unknown) =>
      mock.method(globalThis, 'fetch', async () =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
      )

    it('refuse un ID client ou un code secret que Google ne reconnaît pas', async (t) => {
      t.after(() => mock.restoreAll())
      repondre(401, { error: 'invalid_client', error_description: 'Unauthorized' })
      assert.equal(await checkGoogleClient(config), 'refuse')
    })

    it('accepte des identifiants que Google reconnaît, le faux code seul étant refusé', async (t) => {
      t.after(() => mock.restoreAll())
      const fetch = repondre(400, { error: 'invalid_grant', error_description: 'Malformed auth code.' })
      assert.equal(await checkGoogleClient(config), 'accepte')

      const [url, init] = fetch.mock.calls[0]!.arguments as [string, RequestInit]
      assert.equal(url, 'https://oauth2.googleapis.com/token')
      const body = new URLSearchParams(String(init.body))
      assert.equal(body.get('client_id'), config.clientId)
      assert.equal(body.get('client_secret'), config.clientSecret)
      assert.equal(body.get('grant_type'), 'authorization_code')
    })

    it('ne bloque pas quand Google ne répond pas ou répond autre chose', async (t) => {
      t.after(() => mock.restoreAll())
      repondre(503, 'Service Unavailable')
      assert.equal(await checkGoogleClient(config), 'inconnu')
      mock.restoreAll()
      mock.method(globalThis, 'fetch', async () => {
        throw new TypeError('fetch failed')
      })
      assert.equal(await checkGoogleClient(config), 'inconnu')
    })
  })
})

describe('Google Agenda : les agendas existants du compte (ADR 072)', () => {
  it('ne propose que les agendas dont le compte est propriétaire, l’agenda principal d’abord', async (t) => {
    t.after(() => mock.restoreAll())
    const pages = [
      {
        items: [
          { id: 'salle-mont-blanc@group.calendar.google.com', summary: '1 Salle Mont Blanc' },
          { id: 'centre@gmail.com', summary: 'centre@gmail.com', summaryOverride: 'Agenda du centre', primary: true },
        ],
        nextPageToken: 'suite',
      },
      { items: [{ id: 'einstein@group.calendar.google.com', summary: '2 Salle Albert EINSTEIN' }] },
    ]
    const fetch = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(pages.shift())))

    assert.deepEqual(await listOwnedCalendars('jeton'), [
      { id: 'centre@gmail.com', name: 'Agenda du centre', primary: true },
      { id: 'salle-mont-blanc@group.calendar.google.com', name: '1 Salle Mont Blanc', primary: false },
      { id: 'einstein@group.calendar.google.com', name: '2 Salle Albert EINSTEIN', primary: false },
    ])
    const urls = fetch.mock.calls.map((call) => new URL(String(call.arguments[0])))
    assert.equal(urls.length, 2)
    assert.equal(urls[0]!.pathname, '/calendar/v3/users/me/calendarList')
    assert.equal(urls[0]!.searchParams.get('minAccessRole'), 'owner')
    assert.equal(urls[1]!.searchParams.get('pageToken'), 'suite')
  })

  it('demande de reconnecter un compte connecté sans l’accès aux agendas existants', async (t) => {
    t.after(() => mock.restoreAll())
    mock.method(globalThis, 'fetch', async () =>
      Response.json(
        {
          error: {
            code: 403,
            message: 'Request had insufficient authentication scopes.',
            errors: [{ message: 'Insufficient Permission', domain: 'global', reason: 'insufficientPermissions' }],
            status: 'PERMISSION_DENIED',
          },
        },
        { status: 403 },
      ),
    )
    await assert.rejects(listOwnedCalendars('jeton'), (error: unknown) => {
      assert.ok(error instanceof GoogleCalendarError)
      assert.equal(error.reconnect, true)
      assert.match(error.message, /reconnectez/)
      return true
    })
  })
})
