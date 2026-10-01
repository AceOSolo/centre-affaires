import { isCalendarDate } from '../../lib/dates.ts'
import { resourceTypes, type ResourceType } from '../ressources/schema.ts'

/**
 * Filtres et adresses du planning back-office (R03, ADR 017).
 *
 * Tout l'état du planning tient dans l'URL — jour affiché, vue, type de
 * ressource, client — pour trois raisons : une page se partage et se met en
 * favori, le retour arrière du navigateur fait ce qu'on attend, et les
 * formulaires GET marchent sans JavaScript. Passer d'une vue à l'autre garde
 * les filtres : on ne refait pas son tri en changeant d'échelle.
 */

export const planningViews = ['jour', 'semaine', 'mois'] as const
export type PlanningView = (typeof planningViews)[number]

export const planningViewLabels: Record<PlanningView, string> = {
  jour: 'Jour',
  semaine: 'Semaine',
  mois: 'Mois',
}

const viewPaths: Record<PlanningView, string> = {
  jour: '/reservations',
  semaine: '/reservations/semaine',
  mois: '/reservations/mois',
}

export type PlanningFilters = {
  /** Type de ressource ; absent = tous les types. */
  type?: ResourceType
  /** Entreprise cliente mise en avant ; absente = aucune. */
  client?: string
}

/** Paramètre d'URL tel que Next le livre : absent, simple ou répété. */
export type SearchParam = string | string[] | undefined

/** Première valeur d'un paramètre répété, la seule qu'on retient. */
export function firstParam(value: SearchParam): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Jour ISO valide, calendrier compris : le 31 février est refusé. */
export const isIsoDate = isCalendarDate

/**
 * Filtres lus dans l'URL. Une valeur inconnue est ignorée plutôt que de faire
 * échouer la page : un lien ancien ou bricolé affiche le planning complet.
 *
 * Le client n'est retenu que s'il figure parmi `knownClientIds` quand la liste
 * est fournie : un identifiant d'un client archivé ou d'un autre centre ne
 * doit pas produire un planning vide sans explication.
 */
export function parsePlanningFilters(
  params: { type?: SearchParam; client?: SearchParam },
  knownClientIds?: readonly string[],
): PlanningFilters {
  const rawType = firstParam(params.type)
  const rawClient = firstParam(params.client)?.toLowerCase()
  const type = resourceTypes.find((candidate) => candidate === rawType)
  const client =
    rawClient && UUID.test(rawClient) && (!knownClientIds || knownClientIds.includes(rawClient))
      ? rawClient
      : undefined
  return { ...(type && { type }), ...(client && { client }) }
}

/** Jour affiché : celui de l'URL s'il est valide, sinon aujourd'hui. */
export function planningDate(value: SearchParam, today: string): string {
  const date = firstParam(value)
  return isIsoDate(date) ? date : today
}

/**
 * Adresse d'une vue du planning, filtres conservés.
 *
 * Paramètres dans un ordre fixe, vides omis : deux liens vers le même écran
 * sont la même URL, ce qui compte pour le cache et pour `aria-current`.
 */
export function planningHref(
  view: PlanningView,
  params: PlanningFilters & { date?: string; ressource?: string },
): string {
  const query = new URLSearchParams()
  if (params.date) query.set('date', params.date)
  if (params.type) query.set('type', params.type)
  if (params.client) query.set('client', params.client)
  if (params.ressource && view === 'semaine') query.set('ressource', params.ressource)
  const search = query.toString()
  return search ? `${viewPaths[view]}?${search}` : viewPaths[view]
}

/**
 * Adresse du formulaire de réservation, pré-rempli depuis une case du
 * planning : le jour, la ressource, l'heure de début et le client filtré.
 */
export function newBookingHref(params: {
  date: string
  resourceId: string
  start?: string
  client?: string
}): string {
  const query = new URLSearchParams({ date: params.date, resourceId: params.resourceId })
  if (params.start) query.set('start', params.start)
  if (params.client) query.set('clientId', params.client)
  return `/reservations/nouvelle?${query.toString()}`
}

/** Ressources du type filtré, toutes si aucun type n'est choisi. */
export function filterResources<T extends { resourceType: ResourceType }>(
  resources: readonly T[],
  filters: PlanningFilters,
): T[] {
  return filters.type
    ? resources.filter((resource) => resource.resourceType === filters.type)
    : [...resources]
}

/**
 * Lignes ou colonnes du planning : les ressources réservables du type filtré,
 * plus celles qui ont quelque chose sur la période.
 *
 * Une salle mise en maintenance après coup garde ses réservations : elle reste
 * affichée tant qu'elle a quelque chose à montrer, sinon ses réservations
 * disparaîtraient du planning sans avoir été annulées. Ordre : par type, puis
 * par code, comme l'inventaire.
 */
export function planningResources<
  R extends { id: string; resourceType: ResourceType; code: string },
>(bookable: readonly R[], booked: readonly R[], filters: PlanningFilters): R[] {
  const byId = new Map(bookable.map((resource) => [resource.id, resource]))
  for (const resource of booked) {
    if (!byId.has(resource.id)) byId.set(resource.id, resource)
  }
  return filterResources([...byId.values()], filters).sort(
    (a, b) =>
      resourceTypes.indexOf(a.resourceType) - resourceTypes.indexOf(b.resourceType) ||
      a.code.localeCompare(b.code, 'fr'),
  )
}

/**
 * Regroupe des ressources déjà triées par type, pour titrer chaque groupe
 * quand aucun type n'est filtré.
 */
export function groupByType<R extends { resourceType: ResourceType }>(
  resources: readonly R[],
): { type: ResourceType; resources: R[] }[] {
  const groups: { type: ResourceType; resources: R[] }[] = []
  for (const resource of resources) {
    const last = groups[groups.length - 1]
    if (last?.type === resource.resourceType) last.resources.push(resource)
    else groups.push({ type: resource.resourceType, resources: [resource] })
  }
  return groups
}

/**
 * Réservations retenues par les filtres : celles des ressources affichées.
 *
 * Le filtre client ne retire rien ici — une réservation d'un autre client
 * occupe le créneau, elle reste à l'écran, réduite à « Occupé »
 * (`bookingFocus`). Seule la liste du jour se restreint au client.
 */
export function filterBookings<T extends { resourceId: string }>(
  bookings: readonly T[],
  resourceIds: ReadonlySet<string>,
): T[] {
  return bookings.filter((booking) => resourceIds.has(booking.resourceId))
}
