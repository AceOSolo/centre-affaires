import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test'

import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { sealSecret } from '../../lib/chiffrement.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { googleEventId } from './agenda-google.ts'
import {
  NEW_CALENDAR,
  clearLeftCalendars,
  completeGoogleCalendarConnection,
  saveResourceCalendars,
} from './agenda-google-queries.ts'

/**
 * L'agenda de chaque salle choisi parmi ceux du compte Google (ADR 072),
 * Google simulé : seuls les agendas du compte sont acceptés, un agenda quitté
 * perd les réservations à venir que le site y avait écrites, et reconnecter le
 * même compte garde les choix.
 */
describe('agendas existants des salles, en base', { skip: raisonDeSaut }, () => {
  const CLE = Buffer.alloc(32, 7).toString('base64')
  const ENV = ['SECRETS_ENCRYPTION_KEY', 'APP_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]))
  const MONT_BLANC = 'mont-blanc@group.calendar.google.com'
  const EINSTEIN = 'einstein@group.calendar.google.com'
  const PARTAGE = 'agenda-d-un-autre@group.calendar.google.com'
  const SCOPES = [
    'openid',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events.owned',
    'https://www.googleapis.com/auth/calendar.app.created',
  ].join(' ')
  let bases: TestDatabases
  let admin: string
  let salle: string
  let bureau: string
  let reservation: string
  /** Appels faits à Google, méthode et chemin. */
  let appels: string[]

  const brut = async <T>(requete: string, params: unknown[] = []) =>
    ((await bases.owner.client.query(requete, params)) as unknown as [T[]])[0]
  const agendaDe = async (resourceId: string) =>
    (await brut<{ calendar_id: string }>('select calendar_id from resource_google_calendars where resource_id = ?', [resourceId]))[0]
      ?.calendar_id

  const idToken = (email: string) =>
    `entete.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.signature`

  /** Google, réduit à ce que le site lui demande. */
  const google = (compte = 'centre@gmail.com') =>
    mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      appels.push(`${method} ${url.pathname}`)
      if (url.hostname === 'oauth2.googleapis.com') {
        return Response.json({ access_token: 'acces', refresh_token: 'renouvellement', scope: SCOPES, id_token: idToken(compte) })
      }
      if (url.pathname.endsWith('/users/me/calendarList')) {
        return Response.json({
          items: [
            { id: MONT_BLANC, summary: '1 Salle Mont Blanc' },
            { id: EINSTEIN, summary: '2 Salle Albert EINSTEIN' },
          ],
        })
      }
      if (method === 'POST' && url.pathname === '/calendar/v3/calendars') {
        return Response.json({ id: 'cree@group.calendar.google.com' })
      }
      if (method === 'DELETE') return new Response(null, { status: 204 })
      return Response.json({ error: { errors: [{ reason: 'inattendu' }] } }, { status: 500 })
    })

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
    admin = uuidv7()
    salle = uuidv7()
    bureau = uuidv7()
    reservation = uuidv7()
    await bases.owner.client.query(
      `insert into staff_members (id, tenant_id, email, full_name, role) values (?, ?, 'admin@exemple.fr', 'Admin', 'admin')`,
      [admin, DEFAULT_TENANT_ID],
    )
    await bases.owner.client.query(
      `insert into resources (id, resource_type, code, name) values (?, 'salle', 'SAL-1', 'Salle Mont Blanc'), (?, 'bureau', 'BUR-1', 'Bureau 1')`,
      [salle, bureau],
    )
    const demain = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    await bases.owner.client.query(
      `insert into bookings (id, resource_id, channel, status, title, starts_at, ends_at)
       values (?, ?, 'staff', 'confirmed', 'Réunion de cadrage', ?, ?)`,
      [reservation, salle, `${demain} 08:00:00`, `${demain} 10:00:00`],
    )
  })

  beforeEach(async () => {
    process.env.SECRETS_ENCRYPTION_KEY = CLE
    process.env.APP_URL = 'https://centre.exemple.fr'
    process.env.GOOGLE_CLIENT_ID = '123-serveur.apps.googleusercontent.com'
    process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-serveur'
    appels = []
    await viderTables(bases.owner, 'resource_google_calendars', 'google_calendar_connections', 'google_oauth_clients')
    await bases.owner.client.query(
      `insert into google_calendar_connections (id, google_email, refresh_token_sealed, connected_by) values (?, 'centre@gmail.com', ?, ?)`,
      [uuidv7(), sealSecret('renouvellement', Buffer.from(CLE, 'base64')), admin],
    )
  })

  afterEach(() => {
    mock.restoreAll()
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  })

  after(async () => {
    await viderTables(
      bases.owner,
      'resource_google_calendars',
      'google_calendar_connections',
      'bookings',
      'resources',
      'staff_members',
    )
    delete (globalThis as { database?: unknown }).database
    await bases?.fermer()
  })

  it('relie une salle à l’un des agendas du compte', async () => {
    google()
    const outcome = await saveResourceCalendars([{ resourceId: salle, calendarId: MONT_BLANC }])
    assert.deepEqual(outcome, { linked: [salle], left: [], changed: 1, failed: 0 })
    assert.equal(await agendaDe(salle), MONT_BLANC)
  })

  it('refuse un agenda qui n’est pas dans le compte', async () => {
    google()
    const outcome = await saveResourceCalendars([{ resourceId: salle, calendarId: PARTAGE }])
    assert.equal(outcome.failed, 1)
    assert.equal(await agendaDe(salle), undefined)
  })

  it('laisse deux ressources partager un agenda', async () => {
    google()
    await saveResourceCalendars([
      { resourceId: salle, calendarId: EINSTEIN },
      { resourceId: bureau, calendarId: EINSTEIN },
    ])
    assert.equal(await agendaDe(salle), EINSTEIN)
    assert.equal(await agendaDe(bureau), EINSTEIN)
  })

  it('crée un agenda pour une ressource qui n’en a pas', async () => {
    google()
    await saveResourceCalendars([{ resourceId: bureau, calendarId: NEW_CALENDAR }])
    assert.equal(await agendaDe(bureau), 'cree@group.calendar.google.com')
    assert.ok(appels.includes('POST /calendar/v3/calendars'))
  })

  it('ne touche à rien quand le choix ne change pas', async () => {
    google()
    await saveResourceCalendars([{ resourceId: salle, calendarId: MONT_BLANC }])
    appels = []
    const outcome = await saveResourceCalendars([{ resourceId: salle, calendarId: MONT_BLANC }])
    assert.equal(outcome.changed, 0)
    assert.deepEqual(appels, [])
  })

  it('change d’agenda, et retire de l’ancien les réservations à venir du site', async () => {
    google()
    await saveResourceCalendars([{ resourceId: salle, calendarId: MONT_BLANC }])
    const outcome = await saveResourceCalendars([{ resourceId: salle, calendarId: EINSTEIN }])
    assert.deepEqual(outcome.left, [{ resourceId: salle, calendarId: MONT_BLANC }])
    assert.equal(await agendaDe(salle), EINSTEIN)

    appels = []
    await clearLeftCalendars(outcome.left)
    assert.deepEqual(
      appels.filter((appel) => appel.startsWith('DELETE')),
      [`DELETE /calendar/v3/calendars/${encodeURIComponent(MONT_BLANC)}/events/${googleEventId(reservation)}`],
    )
  })

  it('retire la liaison d’une salle sans agenda choisi', async () => {
    google()
    await saveResourceCalendars([{ resourceId: salle, calendarId: MONT_BLANC }])
    const outcome = await saveResourceCalendars([{ resourceId: salle, calendarId: null }])
    assert.deepEqual(outcome.left, [{ resourceId: salle, calendarId: MONT_BLANC }])
    assert.equal(await agendaDe(salle), undefined)
  })

  it('garde les agendas des salles quand le même compte est reconnecté, pas quand il change', async () => {
    google()
    await saveResourceCalendars([{ resourceId: salle, calendarId: MONT_BLANC }])
    const retour = new URLSearchParams({ state: 'etat', code: 'code' })

    assert.equal(await completeGoogleCalendarConnection(retour, 'etat.verificateur', admin), 'connecte')
    assert.equal(await agendaDe(salle), MONT_BLANC)

    mock.restoreAll()
    google('autre-compte@gmail.com')
    assert.equal(await completeGoogleCalendarConnection(retour, 'etat.verificateur', admin), 'connecte')
    assert.equal(await agendaDe(salle), undefined)
  })
})
