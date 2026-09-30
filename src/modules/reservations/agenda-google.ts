import { createHash } from 'node:crypto'

import type { Resource } from '../ressources/schema.ts'
import type { Booking } from './schema.ts'

/**
 * Écriture des réservations confirmées dans un agenda Google par ressource
 * (ADR 014).
 *
 * Ce fichier ne touche ni à la base ni à Next : ses règles se testent seules.
 * Les appels à Google passent par `fetch` — six points d'entrée REST ne
 * justifient pas le SDK `googleapis` et ses dizaines de mégaoctets.
 */

/**
 * `calendar.app.created` : l'application crée **ses** agendas dans le compte
 * Google et n'agit que sur eux. Elle ne voit ni ne modifie les autres agendas
 * de la personne qui la connecte — c'est le plus étroit des scopes qui
 * permettent d'écrire.
 */
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created'
export const GOOGLE_SCOPES = ['openid', 'email', CALENDAR_SCOPE]

/** Espace d'administration des agendas. */
export const AGENDAS_PATH = '/ressources/agendas'
/** Adresse de retour, à déclarer telle quelle dans la console Google Cloud. */
export const CALLBACK_PATH = `${AGENDAS_PATH}/retour`
/** État et vérificateur PKCE d'une connexion en cours, le temps de l'aller-retour chez Google. */
export const OAUTH_COOKIE = 'agenda_google_oauth'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

export type GoogleConfig = {
  clientId: string
  clientSecret: string
  appUrl: string
  redirectUri: string
}

/**
 * Configuration du serveur, ou `undefined` s'il en manque une pièce : l'écran
 * dit alors que l'intégration n'est pas configurée au lieu de proposer un
 * bouton qui échouerait chez Google.
 */
export function googleConfig(
  env: Record<string, string | undefined> = process.env,
): GoogleConfig | undefined {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, APP_URL: appUrl } = env
  if (!clientId || !clientSecret || !appUrl || !env.SECRETS_ENCRYPTION_KEY) return undefined
  return { clientId, clientSecret, appUrl, redirectUri: new URL(CALLBACK_PATH, appUrl).toString() }
}

/** PKCE (RFC 7636) : un code intercepté au retour ne s'échange pas sans le vérificateur. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function authorizationUrl(
  config: GoogleConfig,
  { state, codeChallenge }: { state: string; codeChallenge: string },
): string {
  const url = new URL(AUTH_URL)
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    // Sans `offline`, pas de jeton de rafraîchissement : l'écriture cesserait
    // une heure après la connexion.
    access_type: 'offline',
    // Google ne renvoie ce jeton qu'au premier consentement ; le redemander à
    // chaque connexion évite une reconnexion qui n'en recevrait pas.
    prompt: 'consent',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString()
  return url.toString()
}

/**
 * L'écran de consentement de Google laisse décocher chaque autorisation : une
 * connexion réussie ne prouve pas que l'accès à l'agenda a été donné.
 */
export function hasCalendarScope(grantedScope: string | undefined): boolean {
  return grantedScope?.split(' ').includes(CALENDAR_SCOPE) ?? false
}

/**
 * Adresse du compte connecté, lue dans le jeton d'identité.
 *
 * Sans vérification de signature : le jeton vient directement du point de
 * terminaison de Google, sur TLS, dans la réponse à notre propre requête —
 * le cas que la norme OpenID Connect (§ 3.1.3.7) dispense de cette étape.
 */
export function emailFromIdToken(idToken: string | undefined): string | undefined {
  const payload = idToken?.split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof claims.email === 'string' && claims.email_verified !== false
      ? claims.email.toLowerCase()
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Nom de l'agenda d'une ressource dans le compte Google. Le centre y figure :
 * le compte connecté peut avoir d'autres agendas, et un jour d'autres centres.
 */
export function calendarSummaryFor(resourceName: string, tenantName: string): string {
  return `${resourceName} — ${tenantName}`
}

/**
 * Identifiant de l'événement Google, dérivé de celui de la réservation.
 *
 * Google accepte un identifiant fourni par l'appelant, en base32hex (a–v, 0–9)
 * de 5 à 1024 caractères : l'hexadécimal d'un UUID en fait partie. Dérivé, il
 * n'a pas à être stocké, et réécrire la même réservation vise toujours le même
 * événement — une validation rejouée ne crée pas de doublon.
 */
export function googleEventId(bookingId: string): string {
  return bookingId.replaceAll('-', '').toLowerCase()
}

export type CalendarAction = 'write' | 'remove' | 'none'

/**
 * Ce que l'agenda de la ressource doit refléter d'une réservation.
 *
 * Toute réservation confirmée y figure — demande acceptée ou réservation posée
 * par l'équipe : l'agenda d'une salle doit montrer son occupation réelle, pas
 * la moitié. Une demande en attente n'y est pas encore ; les indisponibilités
 * n'y sont pas du tout.
 *
 * Une réservation annulée est retirée — y compris une demande refusée, qui n'a
 * jamais eu d'événement : Google répond alors « introuvable », ce qui est déjà
 * l'état voulu.
 */
export function calendarActionFor(booking: Pick<Booking, 'kind' | 'status'>): CalendarAction {
  if (booking.kind !== 'booking') return 'none'
  if (booking.status === 'confirmed') return 'write'
  if (booking.status === 'cancelled') return 'remove'
  return 'none'
}

export type CalendarOperation = { type: 'write' | 'remove'; calendarId: string }

/**
 * Les écritures qu'une réservation demande, agenda par agenda.
 *
 * `calendars` associe une ressource à son agenda Google ; une ressource sans
 * agenda n'appelle aucune écriture. Une réservation passée d'une salle à une
 * autre (`previousResourceId`) quitte l'agenda de l'ancienne : sans cela, les
 * deux agendas la montreraient.
 */
export function calendarOperationsFor(
  booking: Pick<Booking, 'kind' | 'status' | 'resourceId'>,
  calendars: ReadonlyMap<string, string>,
  previousResourceId?: string,
): CalendarOperation[] {
  const operations: CalendarOperation[] = []
  const previous =
    booking.kind === 'booking' && previousResourceId && previousResourceId !== booking.resourceId
      ? calendars.get(previousResourceId)
      : undefined
  if (previous) operations.push({ type: 'remove', calendarId: previous })

  const action = calendarActionFor(booking)
  const current = calendars.get(booking.resourceId)
  if (current && action !== 'none') operations.push({ type: action, calendarId: current })
  return operations
}

export type CalendarEvent = {
  id: string
  status: 'confirmed'
  summary: string
  location: string
  description: string
  start: { dateTime: string; timeZone: string }
  end: { dateTime: string; timeZone: string }
}

/**
 * L'événement tel qu'il part chez Google.
 *
 * Ni le nom, ni le courriel, ni le téléphone du demandeur, ni les notes : ces
 * données personnelles restent en base, hébergée en UE (ADR 014). L'événement
 * dit quoi, où et quand, et renvoie vers la fiche du back-office pour le reste.
 *
 * Les instants partent en UTC, le fuseau du centre les accompagne pour
 * l'affichage chez Google (décision 4).
 */
export function calendarEventFor(
  booking: Pick<Booking, 'id' | 'title' | 'startsAt' | 'endsAt'>,
  resource: Pick<Resource, 'name'>,
  { timeZone, appUrl }: { timeZone: string; appUrl: string },
): CalendarEvent {
  return {
    id: googleEventId(booking.id),
    status: 'confirmed',
    summary: booking.title,
    // L'agenda est déjà celui de la ressource ; son nom sert quand plusieurs
    // agendas sont superposés dans Google.
    location: resource.name,
    description: `Fiche de la réservation : ${new URL(`/reservations/${booking.id}`, appUrl)}`,
    start: { dateTime: booking.startsAt.toISOString(), timeZone },
    end: { dateTime: booking.endsAt.toISOString(), timeZone },
  }
}

/* ------------------------------------------------------------------------ */
/* Appels à Google                                                          */
/* ------------------------------------------------------------------------ */

/** Échec d'un appel à Google, avec un message montrable à l'équipe — jamais de jeton. */
export class GoogleCalendarError extends Error {
  // Champs déclarés puis affectés : voir `BookingConflictError` dans `queries.ts`.
  readonly status: number | undefined
  /** Trop d'appels trop vite : réessayer un peu plus tard a une chance d'aboutir. */
  readonly rateLimited: boolean

  constructor(message: string, status?: number, rateLimited = false) {
    super(message)
    this.name = 'GoogleCalendarError'
    this.status = status
    this.rateLimited = rateLimited
  }
}

async function call(url: string, init: RequestInit): Promise<Response> {
  try {
    // Une validation ne doit pas laisser une requête pendue derrière elle.
    return await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new GoogleCalendarError('Google Agenda ne répond pas.')
  }
}

async function failure(response: Response, context: string): Promise<GoogleCalendarError> {
  let code = ''
  try {
    // OAuth répond `{ error: "invalid_grant" }`, l'API Agenda
    // `{ error: { errors: [{ reason: "rateLimitExceeded" }] } }`.
    const body = await response.json()
    code =
      typeof body.error === 'string'
        ? body.error
        : (body.error?.errors?.[0]?.reason ?? body.error?.status ?? '')
  } catch {
    // Corps illisible : le statut HTTP suffira.
  }
  if (code === 'invalid_grant') {
    return new GoogleCalendarError(
      "Google a retiré l'accès (révoqué depuis le compte Google, ou expiré) : reconnectez le compte.",
      response.status,
    )
  }
  // Les points de terminaison des jetons ne répondent jamais 404, et l'absence
  // d'un événement est traitée par `removeEvent` : reste l'agenda lui-même.
  if (response.status === 404) {
    return new GoogleCalendarError(
      "L'agenda de la ressource n'existe plus dans le compte Google : retirez-le, puis recréez-le.",
      response.status,
    )
  }
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(code))
  return new GoogleCalendarError(
    `${context} : Google a répondu ${response.status}${code ? ` (${code})` : ''}.`,
    response.status,
    rateLimited,
  )
}

type TokenResponse = {
  access_token: string
  refresh_token?: string
  scope?: string
  id_token?: string
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const response = await call(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  if (!response.ok) throw await failure(response, 'Jeton Google')
  return (await response.json()) as TokenResponse
}

export function exchangeCode(
  config: GoogleConfig,
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  })
}

/** Jeton d'accès d'une heure, redemandé à chaque écriture : elles se comptent en unités par jour. */
export async function refreshAccessToken(config: GoogleConfig, refreshToken: string): Promise<string> {
  const tokens = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  })
  return tokens.access_token
}

export async function revokeToken(token: string): Promise<void> {
  const response = await call(REVOKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  })
  if (!response.ok) throw await failure(response, 'Révocation')
}

function jsonHeaders(accessToken: string) {
  return { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }
}

/** Crée l'agenda secondaire de l'application et rend son identifiant. */
export async function createCalendar(
  accessToken: string,
  calendar: { summary: string; timeZone: string },
): Promise<string> {
  const response = await call(`${CALENDAR_API}/calendars`, {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: JSON.stringify(calendar),
  })
  if (!response.ok) throw await failure(response, "Création de l'agenda")
  return ((await response.json()) as { id: string }).id
}

function eventsUrl(calendarId: string): string {
  return `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`
}

/**
 * Écrit l'événement, qu'il existe ou non.
 *
 * Création d'abord — le cas de la validation, de loin le plus courant. Un 409
 * dit que l'identifiant est pris : validation rejouée, réservation déplacée,
 * ou événement effacé à la main dans Google. L'événement est alors remplacé en
 * entier : c'est l'application qui fait foi, pas l'agenda.
 */
export async function writeEvent(
  accessToken: string,
  calendarId: string,
  event: CalendarEvent,
): Promise<void> {
  const created = await call(eventsUrl(calendarId), {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: JSON.stringify(event),
  })
  if (created.ok) return
  if (created.status !== 409) throw await failure(created, "Écriture dans l'agenda")
  await created.body?.cancel()

  const replaced = await call(`${eventsUrl(calendarId)}/${event.id}`, {
    method: 'PUT',
    headers: jsonHeaders(accessToken),
    body: JSON.stringify(event),
  })
  if (!replaced.ok) throw await failure(replaced, "Mise à jour dans l'agenda")
}

/** Retire l'événement. Déjà absent (404) ou déjà supprimé (410) : l'état voulu est atteint. */
export async function removeEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  const response = await call(`${eventsUrl(calendarId)}/${eventId}`, {
    method: 'DELETE',
    headers: jsonHeaders(accessToken),
  })
  if (response.ok || response.status === 404 || response.status === 410) {
    await response.body?.cancel()
    return
  }
  throw await failure(response, "Suppression dans l'agenda")
}
