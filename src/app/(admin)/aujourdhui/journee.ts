import type { Permission } from '../../../lib/auth/permissions.ts'
import type { OfferRequestStatus } from '../../../modules/contrats/schema.ts'
import type { BookingKind, BookingStatus } from '../../../modules/reservations/schema.ts'

/**
 * Règles de l'écran « Aujourd'hui » (ADR 050), sans base ni rendu.
 */

/** Droits qui ouvrent l'écran : il suffit d'en avoir un, chaque bloc vérifie le sien. */
export const todayPermissions = [
  'demandes.traiter',
  'courrier.gerer',
  'etats-des-lieux.gerer',
  'reservations.gerer',
] as const satisfies readonly Permission[]

/**
 * Droits qui ouvrent « Demandes » (ADR 048, ADR 057) : les réservations, devis
 * et offres relèvent de `demandes.traiter`, le courrier de `courrier.gerer`.
 * La page s'ouvre avec l'un des deux ; chaque section vérifie le sien.
 */
export const demandesPermissions = ['demandes.traiter', 'courrier.gerer'] as const satisfies readonly Permission[]

/**
 * Ce qu'attend « Demandes » (ADR 048), compté une fois chacun : les
 * réservations en attente, les devis à compléter qui n'en accompagnent pas
 * une (`awaitsReception`, compté par l'appelant), les offres demandées
 * depuis l'espace client, encore à traiter, et les demandes de courrier en
 * cours — déposées ou prises en charge, pas encore faites (ADR 057). Chacun
 * n'est compté que si le rôle peut le traiter (0 sinon, passé par
 * l'appelant). Le compteur du menu et la tuile d'« Aujourd'hui » (ADR 050)
 * disent ce même nombre.
 */
export function inboxCount(inbox: {
  pendingBookings: number
  proposalsToComplete: number
  offerRequests: readonly { status: OfferRequestStatus }[]
  mailRequests: number
}): number {
  const openOfferRequests = inbox.offerRequests.filter((request) => request.status === 'requested').length
  return inbox.pendingBookings + inbox.proposalsToComplete + openOfferRequests + inbox.mailRequests
}

export type TodayCounts = {
  /** Ce qu'attend « Demandes », comme le compteur du menu (`inboxCount`, ADR 048). */
  requests: number
  mailRequests: number
  inspectionsToFinish: number
  inspectionsToSign: number
}

export type TodoTile = {
  key: keyof TodayCounts
  href: string
  count: number
  /** « 3 demandes à traiter », ou ce qu'il faut savoir quand il n'y a rien. */
  label: string
}

const plural = (count: number, one: string, many: string) => (count > 1 ? many : one)

/**
 * Ce qui attend l'équipe, une tuile par file d'attente que le rôle peut
 * traiter. Une file vide reste affichée : « rien à traiter » est une
 * information, et la grille ne change pas de forme d'un jour à l'autre.
 */
export function todoTiles(counts: TodayCounts, can: (permission: Permission) => boolean): TodoTile[] {
  const tiles: (TodoTile & { permission: Permission | readonly Permission[] })[] = [
    {
      key: 'requests',
      permission: demandesPermissions,
      href: '/demandes',
      count: counts.requests,
      label: counts.requests
        ? `${counts.requests} ${plural(counts.requests, 'demande à traiter', 'demandes à traiter')}`
        : 'Aucune demande en attente',
    },
    {
      // Comprises dans « Demandes » (ADR 057) : la tuile en donne la part du
      // courrier (« dont 2 demandes de courrier » ; le droit du courrier ouvre
      // aussi « Demandes », sa tuile est donc là) et mène à « Demandes »
      // filtrée sur la domiciliation.
      key: 'mailRequests',
      permission: 'courrier.gerer',
      href: '/demandes?produit=domiciliation#courrier',
      count: counts.mailRequests,
      label: counts.mailRequests
        ? `dont ${counts.mailRequests} ${plural(counts.mailRequests, 'demande de courrier', 'demandes de courrier')}`
        : 'Aucune demande de courrier',
    },
    {
      key: 'inspectionsToFinish',
      permission: 'etats-des-lieux.gerer',
      href: '/etats-des-lieux?etape=draft',
      count: counts.inspectionsToFinish,
      label: counts.inspectionsToFinish
        ? `${counts.inspectionsToFinish} ${plural(counts.inspectionsToFinish, 'état des lieux à terminer', 'états des lieux à terminer')}`
        : 'Aucun état des lieux en cours',
    },
    {
      key: 'inspectionsToSign',
      permission: 'etats-des-lieux.gerer',
      href: '/etats-des-lieux?etape=to_sign',
      count: counts.inspectionsToSign,
      label: counts.inspectionsToSign
        ? `${counts.inspectionsToSign} ${plural(counts.inspectionsToSign, 'état des lieux à faire signer', 'états des lieux à faire signer')}`
        : 'Aucune signature en attente',
    },
  ]
  return tiles
    .filter((tile) => (typeof tile.permission === 'string' ? can(tile.permission) : tile.permission.some(can)))
    .map((tile) => ({ key: tile.key, href: tile.href, count: tile.count, label: tile.label }))
}

export type DayMoment = 'termine' | 'en_cours' | 'a_venir'

/**
 * La journée dans l'ordre, réservations seulement : ni les occupations de
 * contrat, qui couvrent des mois (ADR 018), ni les indisponibilités, ni les
 * annulées — tout cela reste au planning. Bornes `[)` comme partout
 * (décision 3) : une réservation qui finit à 10 h est terminée à 10 h.
 */
export function dayTimeline<T extends { kind: BookingKind; status: BookingStatus; startsAt: Date; endsAt: Date }>(
  bookings: readonly T[],
  now: Date,
): (T & { moment: DayMoment })[] {
  return bookings
    .filter((booking) => booking.kind === 'booking' && booking.status !== 'cancelled')
    .toSorted((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .map((booking) => ({
      ...booking,
      moment: booking.endsAt <= now ? 'termine' : booking.startsAt <= now ? 'en_cours' : 'a_venir',
    }))
}
