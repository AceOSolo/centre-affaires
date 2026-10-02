import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'

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
  refreshAccessToken,
  removeEvent,
  revokeToken,
  writeEvent,
  type GoogleConfig,
} from './agenda-google.ts'
import { listBookingSeries } from './bulk-queries.ts'
import { findBooking, type BookingWithResource } from './queries.ts'
import {
  bookings,
  googleCalendarConnections,
  resourceGoogleCalendars,
  type GoogleCalendarConnection,
} from './schema.ts'

/* ------------------------------------------------------------------------ */
/* Compte Google du centre (ADR 014)                                        */
/* ------------------------------------------------------------------------ */

async function findConnection(): Promise<GoogleCalendarConnection | undefined> {
  const [connection] = await withTenant(currentTenantId(), (tx) =>
    tx.select().from(googleCalendarConnections).limit(1),
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
  const config = googleConfig()
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

    await withTenant(currentTenantId(), async (tx) => {
      // Une connexion par centre : la nouvelle remplace l'ancienne, et emporte
      // les agendas des ressources, écrits dans l'ancien compte. La RLS borne
      // la suppression au centre courant.
      await tx.delete(googleCalendarConnections)
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
        linkedAt: resourceGoogleCalendars.createdAt,
      })
      .from(resources)
      .leftJoin(resourceGoogleCalendars, eq(resourceGoogleCalendars.resourceId, resources.id))
      .where(isNull(resources.deletedAt))
      .orderBy(asc(resources.name)),
  )
}

export type ResourceCalendarLink = Awaited<ReturnType<typeof listResourceCalendarLinks>>[number]

/**
 * Crée l'agenda Google de chaque ressource choisie qui n'en a pas encore.
 *
 * Fait pendant la requête, et non après : l'administrateur attend de voir ses
 * agendas créés. Rend les ressources servies, dont les réservations à venir
 * sont ensuite recopiées par `backfillResourceCalendars`.
 */
export async function createResourceCalendars(
  resourceIds: string[],
): Promise<{ created: string[]; failed: number }> {
  const connection = await findConnection()
  const config = googleConfig()
  if (!connection || !config || !resourceIds.length) return { created: [], failed: 0 }

  const pending = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ id: resources.id, name: resources.name })
      .from(resources)
      .leftJoin(resourceGoogleCalendars, eq(resourceGoogleCalendars.resourceId, resources.id))
      .where(
        and(
          inArray(resources.id, resourceIds),
          isNull(resources.deletedAt),
          isNull(resourceGoogleCalendars.id),
        ),
      ),
  )
  if (!pending.length) return { created: [], failed: 0 }

  const tenant = await currentTenant()
  const created: string[] = []
  const failures: string[] = []
  let accessToken: string
  try {
    accessToken = await accessTokenFor(connection, config)
  } catch (error) {
    await recordOutcome(connection.id, 0, [describeFailure(error)])
    return { created, failed: pending.length }
  }

  for (const resource of pending) {
    try {
      const calendarId = await withBackoff(() =>
        createCalendar(accessToken, {
          summary: calendarSummaryFor(resource.name, tenant.name),
          timeZone: tenant.timezone,
        }),
      )
      await withTenant(currentTenantId(), (tx) =>
        tx
          .insert(resourceGoogleCalendars)
          .values({ resourceId: resource.id, connectionId: connection.id, calendarId })
          .onConflictDoNothing(),
      )
      created.push(resource.id)
    } catch (error) {
      console.error(`Google Agenda, agenda de la ressource ${resource.id} :`, error)
      failures.push(`agenda de « ${resource.name} » — ${describeFailure(error)}`)
    }
  }
  await recordOutcome(connection.id, created.length, failures)
  return { created, failed: failures.length }
}

/**
 * Retire la liaison. L'agenda reste dans le compte Google et n'est plus tenu à
 * jour : l'effacer ferait disparaître un agenda que l'équipe a peut-être
 * partagé ou annoté.
 */
export async function removeResourceCalendars(resourceIds: string[]): Promise<number> {
  if (!resourceIds.length) return 0
  const removed = await withTenant(currentTenantId(), (tx) =>
    tx
      .delete(resourceGoogleCalendars)
      .where(inArray(resourceGoogleCalendars.resourceId, resourceIds))
      .returning({ id: resourceGoogleCalendars.id }),
  )
  return removed.length
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
            gt(bookings.endsAt, sql`now()`),
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
        .from(resourceGoogleCalendars),
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
    const config = googleConfig()
    let accessToken: string
    try {
      if (!config) {
        throw new GoogleCalendarError("Google Agenda n'est plus configuré sur ce serveur (ADR 014).")
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
        ...(succeeded ? { lastSyncedAt: sql`now()` } : {}),
        ...(lastError ? { lastErrorAt: sql`now()`, lastError } : {}),
      })
      .where(eq(googleCalendarConnections.id, connectionId)),
  )
}
