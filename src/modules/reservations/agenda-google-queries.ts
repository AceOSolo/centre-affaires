import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm'

import { maintenant } from '../../db/columns.ts'
import { withTenant } from '../../db/index.ts'
import { openSecret, sealSecret } from '../../lib/chiffrement.ts'
import { formatDateTime } from '../../lib/dates.ts'
import { currentTenant, currentTenantId } from '../../lib/tenant.ts'
import { resources } from '../ressources/schema.ts'
import {
  GoogleCalendarError,
  calendarEventFor,
  calendarOperationsFor,
  calendarSummaryFor,
  createCalendar,
  emailFromIdToken,
  exchangeCode,
  googleConfig,
  googleEventId,
  hasCalendarScope,
  listOwnedCalendars,
  refreshAccessToken,
  removeEvent,
  revokeToken,
  writeEvent,
  type GoogleCalendarEntry,
  type GoogleClient,
  type GoogleConfig,
} from './agenda-google.ts'
import { listBookingSeries } from './bulk-queries.ts'
import { findBooking, type BookingWithResource } from './queries.ts'
import {
  bookings,
  googleCalendarConnections,
  googleOAuthClients,
  resourceGoogleCalendars,
  type GoogleCalendarConnection,
} from './schema.ts'

/* ------------------------------------------------------------------------ */
/* Identifiants Google Cloud du centre (ADR 069)                            */
/* ------------------------------------------------------------------------ */

async function findOAuthClient() {
  const [client] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(googleOAuthClients)
      .where(eq(googleOAuthClients.tenantId, currentTenantId()))
      .limit(1),
  )
  return client
}

/**
 * D'où viennent les identifiants du centre, pour l'écran. L'ID client n'est pas
 * un secret — il figure dans l'adresse de la page de consentement ; le code
 * secret n'est jamais relu pour l'affichage, seulement éprouvé.
 */
export type GoogleClientStatus =
  | { source: 'ecran'; clientId: string; updatedAt: Date; readable: boolean }
  | { source: 'serveur'; clientId: string }
  | { source: 'aucune' }

export async function googleClientStatus(): Promise<GoogleClientStatus> {
  const client = await findOAuthClient()
  if (client) {
    return {
      source: 'ecran',
      clientId: client.clientId,
      updatedAt: client.updatedAt,
      readable: readSecret(client.clientSecretSealed) !== undefined,
    }
  }
  const fromEnv = googleConfig()
  return fromEnv ? { source: 'serveur', clientId: fromEnv.clientId } : { source: 'aucune' }
}

/** Le secret en clair, ou `undefined` s'il a été chiffré par une autre clé de serveur. */
function readSecret(sealed: string): string | undefined {
  try {
    return openSecret(sealed)
  } catch {
    return undefined
  }
}

/**
 * La configuration du centre courant. Les identifiants réglés à l'écran
 * l'emportent ; illisibles, ils ne laissent pas la place à ceux du serveur :
 * l'écran demande de les ressaisir.
 */
export async function loadGoogleConfig(): Promise<GoogleConfig | undefined> {
  const client = await findOAuthClient()
  if (!client) return googleConfig()
  const clientSecret = readSecret(client.clientSecretSealed)
  return clientSecret ? googleConfig(process.env, { clientId: client.clientId, clientSecret }) : undefined
}

const MISSING_CLIENT =
  'Identifiants Google Cloud absents ou illisibles avec la clé de ce serveur : ressaisissez-les dans l’espace des agendas.'

/** Enregistre (ou remplace) les identifiants du centre, le code secret chiffré. */
export async function saveGoogleClient(client: GoogleClient, staffMemberId: string): Promise<void> {
  const values = {
    clientId: client.clientId,
    clientSecretSealed: sealSecret(client.clientSecret),
    updatedBy: staffMemberId,
  }
  await withTenant(currentTenantId(), (tx) =>
    tx
      .insert(googleOAuthClients)
      .values(values)
      .onDuplicateKeyUpdate({ set: values }),
  )
}

/* ------------------------------------------------------------------------ */
/* Compte Google du centre (ADR 014)                                        */
/* ------------------------------------------------------------------------ */

async function findConnection(): Promise<GoogleCalendarConnection | undefined> {
  const [connection] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(googleCalendarConnections)
      .where(eq(googleCalendarConnections.tenantId, currentTenantId()))
      .limit(1),
  )
  return connection
}

/** Ce que l'écran montre de la connexion. Le jeton n'est jamais lu pour l'affichage. */
export async function googleCalendarStatus() {
  const [status] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        googleEmail: googleCalendarConnections.googleEmail,
        connectedAt: googleCalendarConnections.createdAt,
        lastSyncedAt: googleCalendarConnections.lastSyncedAt,
        lastErrorAt: googleCalendarConnections.lastErrorAt,
        lastError: googleCalendarConnections.lastError,
      })
      .from(googleCalendarConnections)
      .where(eq(googleCalendarConnections.tenantId, currentTenantId()))
      .limit(1),
  )
  return status
}

export type GoogleCalendarStatus = NonNullable<Awaited<ReturnType<typeof googleCalendarStatus>>>

/** Issue d'une connexion ou d'une déconnexion, rendue dans l'URL de retour et traduite par l'écran. */
export type ConnectionOutcome =
  | 'connecte'
  | 'deconnecte'
  | 'refuse'
  | 'expire'
  | 'portee'
  | 'erreur'
  | 'non-configure'

/**
 * Retour de Google après le consentement : échange du code, enregistrement du
 * jeton chiffré. Aucun agenda n'est créé ici : c'est ressource par ressource,
 * depuis l'espace des agendas.
 *
 * `pending` est le cookie posé au départ par `connectGoogleCalendarAction` :
 * l'état qui prouve que ce retour répond à une demande partie de ce navigateur,
 * et le vérificateur PKCE sans lequel le code ne s'échange pas.
 */
export async function completeGoogleCalendarConnection(
  params: URLSearchParams,
  pending: string | undefined,
  staffMemberId: string,
): Promise<ConnectionOutcome> {
  const config = await loadGoogleConfig()
  if (!config) return 'non-configure'
  // `access_denied` : la personne a refusé sur l'écran de Google.
  if (params.get('error')) return 'refuse'

  const [state, verifier] = pending?.split('.') ?? []
  if (!state || !verifier || params.get('state') !== state) return 'expire'
  const code = params.get('code')
  if (!code) return 'erreur'

  try {
    const tokens = await exchangeCode(config, code, verifier)
    if (!hasCalendarScope(tokens.scope)) {
      // Un accès sans les agendas ne sert à rien : on ne le garde pas.
      await revokeToken(tokens.access_token).catch(() => {})
      return 'portee'
    }
    const googleEmail = emailFromIdToken(tokens.id_token)
    if (!tokens.refresh_token || !googleEmail) return 'erreur'
    const refreshTokenSealed = sealSecret(tokens.refresh_token)

    const previous = await findConnection()
    await withTenant(currentTenantId(), async (tx) => {
      if (previous?.googleEmail === googleEmail) {
        // Le même compte, reconnecté (autorisations élargies par l'ADR 072,
        // accès retiré puis redonné) : ses agendas restent ceux des salles.
        await tx
          .update(googleCalendarConnections)
          .set({ refreshTokenSealed, connectedBy: staffMemberId, lastError: null, lastErrorAt: null })
          .where(eq(googleCalendarConnections.id, previous.id))
        return
      }
      // Une connexion par centre : un autre compte remplace l'ancien, et
      // emporte les liaisons des ressources, dont les agendas sont dans
      // l'ancien compte. Pas de RLS : la suppression est bornée au centre
      // courant par le filtre.
      await tx
        .delete(googleCalendarConnections)
        .where(eq(googleCalendarConnections.tenantId, currentTenantId()))
      await tx.insert(googleCalendarConnections).values({
        googleEmail,
        refreshTokenSealed,
        connectedBy: staffMemberId,
      })
    })
    return 'connecte'
  } catch (error) {
    console.error('Connexion à Google Agenda impossible :', error)
    return 'erreur'
  }
}

/**
 * Déconnexion : le jeton est révoqué chez Google puis effacé, et les liaisons
 * des ressources avec lui. Les agendas restent dans le compte Google — ce sont
 * désormais les données de son titulaire.
 */
export async function disconnectGoogleCalendar(): Promise<void> {
  const connection = await findConnection()
  if (!connection) return
  try {
    await revokeToken(openSecret(connection.refreshTokenSealed))
  } catch (error) {
    // Le jeton est effacé quoi qu'il arrive ; l'accès reste retirable depuis
    // le compte Google (Sécurité > Applications tierces).
    console.error('Révocation du jeton Google impossible :', error)
  }
  await withTenant(currentTenantId(), (tx) =>
    tx.delete(googleCalendarConnections).where(eq(googleCalendarConnections.id, connection.id)),
  )
}

/* ------------------------------------------------------------------------ */
/* Agendas des ressources                                                   */
/* ------------------------------------------------------------------------ */

/** Les ressources du centre et, pour chacune, si elle a son agenda Google. */
export async function listResourceCalendarLinks() {
  return withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        id: resources.id,
        name: resources.name,
        code: resources.code,
        resourceType: resources.resourceType,
        // Changée quand l'agenda de la ressource change (ADR 072).
        linkedAt: resourceGoogleCalendars.updatedAt,
        // Pour le code d'intégration dans une autre page (ADR 064). Ce n'est
        // pas un secret : l'agenda ne s'affiche qu'aux comptes avec qui il est partagé.
        calendarId: resourceGoogleCalendars.calendarId,
      })
      .from(resources)
      .leftJoin(resourceGoogleCalendars, eq(resourceGoogleCalendars.resourceId, resources.id))
      .where(and(eq(resources.tenantId, currentTenantId()), isNull(resources.deletedAt)))
      .orderBy(asc(resources.name)),
  )
}

export type ResourceCalendarLink = Awaited<ReturnType<typeof listResourceCalendarLinks>>[number]

/**
 * Les agendas du compte connecté où le site peut écrire, pour le choix de
 * chaque ressource (ADR 072). `undefined` sans compte connecté ; un message si
 * Google refuse — le plus souvent une connexion faite avant l'ADR 072, qui
 * n'avait pas l'accès aux agendas existants.
 */
export async function listGoogleCalendarChoices(): Promise<
  { calendars: GoogleCalendarEntry[] } | { error: string; reconnect: boolean } | undefined
> {
  const connection = await findConnection()
  if (!connection) return undefined
  const config = await loadGoogleConfig()
  if (!config) return { error: MISSING_CLIENT, reconnect: false }
  try {
    return { calendars: await listOwnedCalendars(await accessTokenFor(connection, config)) }
  } catch (error) {
    return {
      error: describeFailure(error),
      reconnect: error instanceof GoogleCalendarError && error.reconnect,
    }
  }
}

/** Valeur du choix « créer un agenda pour cette ressource ». */
export const NEW_CALENDAR = 'nouveau'

/** Pour une ressource : un agenda du compte, `NEW_CALENDAR`, ou aucun (`null`). */
export type CalendarChoice = { resourceId: string; calendarId: string | null }

/** Ce qu'il reste à faire après la réponse, et le bilan à montrer. */
export type SavedCalendars = {
  /** Ressources reliées à un nouvel agenda : leurs réservations à venir y sont recopiées. */
  linked: string[]
  /** Agendas quittés : les réservations à venir que le site y avait écrites en sont retirées. */
  left: { resourceId: string; calendarId: string }[]
  changed: number
  failed: number
}

/**
 * Enregistre l'agenda choisi pour chaque ressource (ADR 072). Seules les
 * ressources dont le choix change sont touchées.
 *
 * Un agenda choisi doit être l'un de ceux que le compte possède : le
 * formulaire ne doit pas pouvoir faire écrire le site ailleurs. Plusieurs
 * ressources peuvent partager un agenda (« Autre salle ») : chaque événement
 * porte le nom de sa ressource.
 *
 * Fait pendant la requête, et non après : l'administrateur attend de voir ses
 * choix enregistrés, et un agenda à créer l'est chez Google.
 */
export async function saveResourceCalendars(choices: CalendarChoice[]): Promise<SavedCalendars> {
  const outcome: SavedCalendars = { linked: [], left: [], changed: 0, failed: 0 }
  const connection = await findConnection()
  if (!connection || !choices.length) return outcome

  const tenantId = currentTenantId()
  const [current, active] = await withTenant(tenantId, async (tx) => [
    await tx
      .select({ resourceId: resourceGoogleCalendars.resourceId, calendarId: resourceGoogleCalendars.calendarId })
      .from(resourceGoogleCalendars)
      .where(eq(resourceGoogleCalendars.tenantId, tenantId)),
    await tx
      .select({ id: resources.id, name: resources.name })
      .from(resources)
      .where(
        and(
          eq(resources.tenantId, tenantId),
          inArray(
            resources.id,
            choices.map((choice) => choice.resourceId),
          ),
          isNull(resources.deletedAt),
        ),
      ),
  ] as const)
  const linkedTo = new Map(current.map((link) => [link.resourceId, link.calendarId]))
  const names = new Map(active.map((resource) => [resource.id, resource.name]))
  const changes = choices.filter(
    (choice) =>
      names.has(choice.resourceId) &&
      (choice.calendarId === NEW_CALENDAR || (choice.calendarId ?? undefined) !== linkedTo.get(choice.resourceId)),
  )
  if (!changes.length) return outcome

  // Retirer une liaison ne demande rien à Google ; relier, si.
  let accessToken: string | undefined
  let owned: Set<string> | undefined
  let unreachable: string | undefined
  if (changes.some((choice) => choice.calendarId !== null)) {
    try {
      const config = await loadGoogleConfig()
      if (!config) throw new GoogleCalendarError(MISSING_CLIENT)
      accessToken = await accessTokenFor(connection, config)
      owned = new Set((await listOwnedCalendars(accessToken)).map((calendar) => calendar.id))
    } catch (error) {
      accessToken = undefined
      owned = undefined
      console.error('Google Agenda, liste des agendas :', error)
      unreachable = describeFailure(error)
    }
  }

  const tenant = await currentTenant()
  const failures: string[] = []
  for (const { resourceId, calendarId: wanted } of changes) {
    const name = names.get(resourceId)!
    const previous = linkedTo.get(resourceId)
    try {
      if (wanted === null) {
        await withTenant(tenantId, (tx) =>
          tx
            .delete(resourceGoogleCalendars)
            .where(
              and(eq(resourceGoogleCalendars.tenantId, tenantId), eq(resourceGoogleCalendars.resourceId, resourceId)),
            ),
        )
      } else {
        const token = accessToken
        if (!token || !owned) throw new GoogleCalendarError(unreachable ?? 'Google Agenda injoignable.')
        if (wanted !== NEW_CALENDAR && !owned.has(wanted)) {
          throw new GoogleCalendarError('cet agenda n’est pas, ou plus, dans le compte Google connecté.')
        }
        const calendarId =
          wanted === NEW_CALENDAR
            ? await withBackoff(() =>
                createCalendar(token, { summary: calendarSummaryFor(name, tenant.name), timeZone: tenant.timezone }),
              )
            : wanted
        await withTenant(tenantId, (tx) =>
          tx
            .insert(resourceGoogleCalendars)
            .values({ resourceId, connectionId: connection.id, calendarId })
            .onDuplicateKeyUpdate({ set: { calendarId, connectionId: connection.id } }),
        )
        outcome.linked.push(resourceId)
      }
      if (previous) outcome.left.push({ resourceId, calendarId: previous })
      outcome.changed++
    } catch (error) {
      console.error(`Google Agenda, agenda de la ressource ${resourceId} :`, error)
      failures.push(`agenda de « ${name} » — ${describeFailure(error)}`)
    }
  }
  outcome.failed = failures.length
  await recordOutcome(connection.id, 0, failures)
  return outcome
}

/**
 * Retire d'un agenda quitté les réservations à venir que le site y avait
 * écrites : changer l'agenda d'une salle ne doit pas laisser dans l'ancien des
 * créneaux qui ne seraient plus tenus à jour. Le passé y reste. Les événements
 * saisis par l'équipe n'y sont jamais touchés : seuls ceux dont le site a
 * dérivé l'identifiant sont visés.
 */
export function clearLeftCalendars(left: SavedCalendars['left']) {
  if (!left.length) return Promise.resolve()
  return runAfterResponse(async (connection, accessToken) => {
    const rows = await withTenant(currentTenantId(), (tx) =>
      tx
        .select({ id: bookings.id, resourceId: bookings.resourceId })
        .from(bookings)
        .where(
          and(
            eq(bookings.tenantId, currentTenantId()),
            inArray(
              bookings.resourceId,
              left.map((entry) => entry.resourceId),
            ),
            eq(bookings.kind, 'booking'),
            gt(bookings.endsAt, maintenant()),
          ),
        ),
    )
    let succeeded = 0
    const failures: string[] = []
    for (const { resourceId, calendarId } of left) {
      for (const booking of rows.filter((row) => row.resourceId === resourceId)) {
        try {
          await withBackoff(() => removeEvent(accessToken, calendarId, googleEventId(booking.id)))
          succeeded++
        } catch (error) {
          failures.push(`retrait de l’ancien agenda — ${describeFailure(error)}`)
        }
      }
    }
    await recordOutcome(connection.id, succeeded, failures)
  })
}

/* ------------------------------------------------------------------------ */
/* Écriture des réservations                                                */
/* ------------------------------------------------------------------------ */

/**
 * Toutes ces fonctions tournent **après** la réponse (`after()`) : Google lent
 * ou en panne ne retarde ni ne fait échouer une réservation, qui est faite en
 * base quoi qu'il arrive. L'échec est inscrit sur la connexion, où l'espace des
 * agendas le montre.
 *
 * Idempotentes : l'identifiant de l'événement est dérivé de la réservation,
 * rejouer un appel ne crée pas de doublon.
 */

/** Après une création, une validation, un déplacement ou une annulation. */
export function syncBookingToGoogleCalendar(bookingId: string, previousResourceId?: string) {
  return sync(async () => {
    const booking = await findBooking(bookingId)
    return booking ? [{ booking, previousResourceId }] : []
  })
}

/** Après l'annulation des occurrences à venir d'une série. */
export function syncBookingsToGoogleCalendar(bookingIds: string[]) {
  if (!bookingIds.length) return Promise.resolve()
  return sync(async () => (await loadBookings(bookingIds)).map((booking) => ({ booking })))
}

/** Après la création d'une série : jusqu'à 500 écritures. */
export function syncSeriesToGoogleCalendar(seriesId: string) {
  return sync(async () => (await listBookingSeries(seriesId)).map((booking) => ({ booking })))
}

/**
 * Recopie les réservations confirmées à venir d'une ressource qui vient de
 * recevoir son agenda : sans elle, l'agenda montrerait libre une salle déjà
 * réservée.
 */
export function backfillResourceCalendars(resourceIds: string[]) {
  if (!resourceIds.length) return Promise.resolve()
  return sync(async () => {
    const rows = await withTenant(currentTenantId(), (tx) =>
      tx
        .select({ booking: bookings, resource: resources })
        .from(bookings)
        .innerJoin(resources, eq(resources.id, bookings.resourceId))
        .where(
          and(
            inArray(bookings.resourceId, resourceIds),
            eq(bookings.status, 'confirmed'),
            eq(bookings.kind, 'booking'),
            gt(bookings.endsAt, maintenant()),
          ),
        )
        .orderBy(asc(bookings.startsAt)),
    )
    return rows.map(({ booking, resource }) => ({ booking: { ...booking, resource } }))
  })
}

async function loadBookings(ids: string[]): Promise<BookingWithResource[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ booking: bookings, resource: resources })
      .from(bookings)
      .innerJoin(resources, eq(resources.id, bookings.resourceId))
      .where(inArray(bookings.id, ids)),
  )
  return rows.map(({ booking, resource }) => ({ ...booking, resource }))
}

type SyncItem = { booking: BookingWithResource; previousResourceId?: string }

/**
 * Aligne les agendas des ressources sur l'état des réservations.
 *
 * Un seul jeton d'accès pour tout le lot, et les écritures une à une : une
 * série de 500 occurrences ne doit pas déclencher 500 appels simultanés, que
 * Google refuserait.
 */
async function sync(load: () => Promise<SyncItem[]>): Promise<void> {
  try {
    const connection = await findConnection()
    if (!connection) return
    const links = await withTenant(currentTenantId(), (tx) =>
      tx
        .select({
          resourceId: resourceGoogleCalendars.resourceId,
          calendarId: resourceGoogleCalendars.calendarId,
        })
        .from(resourceGoogleCalendars)
        .where(eq(resourceGoogleCalendars.tenantId, currentTenantId())),
    )
    if (!links.length) return
    const calendars = new Map(links.map((link) => [link.resourceId, link.calendarId]))

    const work = (await load()).flatMap(({ booking, previousResourceId }) =>
      calendarOperationsFor(booking, calendars, previousResourceId).map((operation) => ({
        booking,
        operation,
      })),
    )
    if (!work.length) return

    const { timezone: timeZone } = await currentTenant()
    const config = await loadGoogleConfig()
    let accessToken: string
    try {
      if (!config) {
        throw new GoogleCalendarError(MISSING_CLIENT)
      }
      accessToken = await accessTokenFor(connection, config)
    } catch (error) {
      await recordOutcome(connection.id, 0, [describeFailure(error)])
      return
    }

    let succeeded = 0
    const failures: string[] = []
    for (const { booking, operation } of work) {
      try {
        await withBackoff(() =>
          operation.type === 'write'
            ? writeEvent(
                accessToken,
                operation.calendarId,
                calendarEventFor(booking, booking.resource, { timeZone, appUrl: config.appUrl }),
              )
            : removeEvent(accessToken, operation.calendarId, googleEventId(booking.id)),
        )
        succeeded++
      } catch (error) {
        console.error(`Google Agenda, réservation ${booking.id} :`, error)
        failures.push(
          `« ${booking.title} » (${booking.resource.name}) du ${formatDateTime(booking.startsAt, timeZone)} — ${describeFailure(error)}`,
        )
      }
    }
    await recordOutcome(connection.id, succeeded, failures)
  } catch (error) {
    // Rien ne doit remonter : la réponse est partie, personne n'attend ce résultat.
    console.error('Synchronisation Google Agenda interrompue :', error)
  }
}

/** Compte, configuration et jeton d'accès, puis le travail ; rien ne remonte. */
async function runAfterResponse(
  work: (connection: GoogleCalendarConnection, accessToken: string) => Promise<void>,
): Promise<void> {
  try {
    const connection = await findConnection()
    if (!connection) return
    const config = await loadGoogleConfig()
    let accessToken: string
    try {
      if (!config) throw new GoogleCalendarError(MISSING_CLIENT)
      accessToken = await accessTokenFor(connection, config)
    } catch (error) {
      await recordOutcome(connection.id, 0, [describeFailure(error)])
      return
    }
    await work(connection, accessToken)
  } catch (error) {
    console.error('Google Agenda, travail après la réponse interrompu :', error)
  }
}

async function accessTokenFor(
  connection: GoogleCalendarConnection,
  config: GoogleConfig,
): Promise<string> {
  let refreshToken: string
  try {
    refreshToken = openSecret(connection.refreshTokenSealed)
  } catch {
    // Typiquement une branche copiée depuis la production : même ligne, autre
    // clé. C'est voulu, et la réponse est de connecter un compte de test.
    throw new GoogleCalendarError(
      'Jeton illisible avec la clé de ce serveur (SECRETS_ENCRYPTION_KEY) : reconnectez le compte.',
    )
  }
  return refreshAccessToken(config, refreshToken)
}

/**
 * Réessaie un appel refusé pour excès de débit, avec une attente qui double à
 * chaque fois — ce que Google recommande. Toute autre erreur remonte aussitôt.
 */
async function withBackoff<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (!(error instanceof GoogleCalendarError && error.rateLimited) || attempt >= 3) throw error
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000))
    }
  }
}

function describeFailure(error: unknown): string {
  return error instanceof GoogleCalendarError
    ? error.message
    : 'erreur inattendue, détail dans les journaux du serveur.'
}

/**
 * Inscrit le bilan d'un lot sur la connexion. Réussite et échec dans le même
 * lot reçoivent la même heure : l'écran montre alors l'échec, qui est ce qui
 * demande une action.
 */
function recordOutcome(connectionId: string, succeeded: number, failures: string[]) {
  if (!succeeded && !failures.length) return Promise.resolve()
  const lastError =
    failures.length > 1
      ? `${failures.length} écritures en échec. Dernière : ${failures.at(-1)}`
      : failures[0]
  return withTenant(currentTenantId(), (tx) =>
    tx
      .update(googleCalendarConnections)
      .set({
        ...(succeeded ? { lastSyncedAt: maintenant() } : {}),
        ...(lastError ? { lastErrorAt: maintenant(), lastError } : {}),
      })
      .where(eq(googleCalendarConnections.id, connectionId)),
  )
}
