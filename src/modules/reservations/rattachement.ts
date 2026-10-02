import { contractRange, type ContractPeriod } from '../contrats/occupation.ts'
import type { ContractStatus } from '../contrats/schema.ts'
import type { TimeRange } from './availability.ts'

/**
 * Rattachement d'une réservation à un contrat (R05).
 *
 * Des heures de salle comprises dans un contrat de bureau, par exemple. La base
 * vérifie que le contrat appartient au centre (clé étrangère composite), pas
 * qu'il concorde avec la réservation (ADR 018) : c'est le rôle de cette règle,
 * appliquée par `createBooking` et `moveBooking` dans la transaction qui écrit.
 *
 * Trois conditions, toutes nécessaires :
 * - **même client** : le contrat est celui de l'entreprise pour qui la
 *   ressource est réservée ;
 * - **contrat actif** : ni brouillon, qui n'engage rien, ni résilié, ni
 *   archivé ;
 * - **période couverte** : le créneau tient entier dans les jours du contrat,
 *   bornes `[)` dans le fuseau du centre — un créneau qui finit à minuit le
 *   lendemain du dernier jour y tient encore.
 */
export type BookingContractProblem = 'sans-client' | 'autre-client' | 'pas-actif' | 'hors-periode'

export const bookingContractMessages: Record<BookingContractProblem, string> = {
  'sans-client': 'Choisissez d’abord le client : seul un contrat de ce client peut être rattaché.',
  'autre-client': 'Ce contrat appartient à un autre client que celui de la réservation.',
  'pas-actif': 'Ce contrat n’est pas en cours : seul un contrat actif peut être rattaché.',
  'hors-periode': 'Le créneau sort de la période du contrat.',
}

/** Ce qu'il faut d'un contrat pour décider. */
export type AttachableContract = ContractPeriod & {
  clientId: string
  status: ContractStatus
  deletedAt: Date | null
}

/** Premier manquement à la règle, ou `undefined` si le rattachement est permis. */
export function bookingContractProblem(
  contract: AttachableContract,
  booking: TimeRange & { clientId: string | null },
  timeZone: string,
): BookingContractProblem | undefined {
  if (!booking.clientId) return 'sans-client'
  if (contract.clientId !== booking.clientId) return 'autre-client'
  if (contract.deletedAt !== null || contract.status !== 'active') return 'pas-actif'
  const period = contractRange(contract, timeZone)
  if (
    booking.startsAt.getTime() < period.startsAt.getTime() ||
    booking.endsAt.getTime() > period.endsAt.getTime()
  ) {
    return 'hors-periode'
  }
  return undefined
}

/** Levée quand une réservation ne peut pas être rattachée au contrat demandé. */
export class BookingContractError extends Error {
  // Champ déclaré puis affecté : le strip de types de Node ne compile pas les
  // paramètres-propriétés (voir `BookingConflictError`).
  readonly problem: BookingContractProblem | 'introuvable'

  constructor(problem: BookingContractProblem | 'introuvable') {
    super(
      problem === 'introuvable'
        ? 'Ce contrat est introuvable.'
        : bookingContractMessages[problem],
    )
    this.name = 'BookingContractError'
    this.problem = problem
  }
}

/**
 * Ce qui fige le client d'une réservation (ADR 036, 039 ; correctifs de la
 * dernière vague, ADR 041) :
 *
 * - **espace client** : réservée ou annulée par une personne de l'entreprise,
 *   depuis son espace ; la base exige que cette personne soit de l'entreprise
 *   de la réservation (clé étrangère composite, `bookings_booked_by_member_consistent`) ;
 * - **état des lieux** : il porte le client de la réservation
 *   (`inspections_booking_fk`), y compris un brouillon retiré ;
 * - **facturée** : la ligne de facture est celle du client facturé ; la
 *   rattacher à un autre client contredirait la facture.
 */
export type BookingClientLock = 'espace-client' | 'etat-des-lieux' | 'facturee'

export const bookingClientLockMessages: Record<BookingClientLock, string> = {
  'espace-client':
    'Réservée ou annulée depuis l’espace client : la réservation reste à l’entreprise de la personne qui l’a faite.',
  'etat-des-lieux': 'Un état des lieux porte sur cette réservation : son client ne change plus.',
  facturee:
    'Cette réservation est facturée : son client ne change plus. Pour la facturer à un autre client, établissez d’abord un avoir.',
}

export type BookingClientFacts = {
  bookedByMemberId: string | null
  cancelledByMemberId: string | null
  /** Au moins un état des lieux, même retiré, porte sur la réservation. */
  inspected: boolean
  /** Une ligne de facture vivante la tient. */
  invoiced: boolean
}

/** Premier verrou du client de la réservation, ou `undefined` s'il peut changer. */
export function bookingClientLock(facts: BookingClientFacts): BookingClientLock | undefined {
  if (facts.bookedByMemberId || facts.cancelledByMemberId) return 'espace-client'
  if (facts.inspected) return 'etat-des-lieux'
  if (facts.invoiced) return 'facturee'
  return undefined
}
