import { proposalTotals, type ProposalTotals } from '../facturation/propositions.ts'
import type { QuoteDisplay } from '../facturation/devis.ts'
import type { ResourceType } from '../ressources/schema.ts'

/**
 * Matériel en option d'une réservation (ADR 062) : règles pures, sans base.
 *
 * Un appareil loué avec une salle est **une réservation à part entière**,
 * liée à celle de la salle (`bookings.parent_booking_id`) : le trigger
 * anti-chevauchement le garde comme toute réservation (décision 3), son prix
 * est figé sur lui (R11) et s'ajoute au devis de la salle. Il suit la
 * réservation principale : même période, même client, validé, déplacé et
 * annulé avec elle, dans la même transaction. La base refuse ce qui sortirait
 * de ces règles (`src/db/regles/25-reservations-liees.sql`, `CA018`).
 *
 * Module pur : il s'éprouve seul (`options.test.ts`).
 */

/** Le seul type qui se loue en option d'une autre réservation. */
export const EQUIPMENT_TYPE = 'materiel' as const satisfies ResourceType

/**
 * Types dont la réservation propose « Ajouter du matériel » : la salle
 * (recette du 04/11). La base accepte toute réservation qui n'est pas
 * elle-même du matériel ; ouvrir l'option aux bureaux ne demande que de
 * l'ajouter ici.
 */
export const typesWithEquipmentOptions: readonly ResourceType[] = ['salle']

export function isEquipment(type: ResourceType): boolean {
  return type === EQUIPMENT_TYPE
}

/** La réservation d'une ressource de ce type peut recevoir du matériel en option. */
export function acceptsEquipmentOptions(type: ResourceType): boolean {
  return typesWithEquipmentOptions.includes(type)
}

/** Ce qu'il faut savoir d'une réservation pour lui ajouter du matériel. */
export type OptionParent = {
  kind: string
  status: string
  parentBookingId: string | null
  resource: { resourceType: ResourceType }
}

/** Pourquoi une réservation ne reçoit pas de matériel, ou `undefined` si elle le peut. */
export type OptionRefusal = 'type' | 'annulee' | 'option' | 'occupation'

export const optionRefusalMessages: Record<OptionRefusal, string> = {
  type: 'Le matériel s’ajoute à une réservation de salle.',
  annulee: 'Cette réservation est annulée : on ne lui ajoute plus de matériel.',
  option: 'Ce matériel est déjà une option : ajoutez l’appareil à la réservation principale.',
  occupation: 'Une occupation de contrat ne reçoit pas de matériel en option.',
}

export function optionRefusal(parent: OptionParent): OptionRefusal | undefined {
  if (parent.parentBookingId) return 'option'
  if (parent.kind !== 'booking') return 'occupation'
  if (parent.status === 'cancelled') return 'annulee'
  if (!acceptsEquipmentOptions(parent.resource.resourceType)) return 'type'
  return undefined
}

/**
 * Ce que l'option reprend de la réservation principale : sa période et son
 * client. Le statut suit aussi : une demande en attente garde son matériel en
 * attente (la base l'impose), une réservation confirmée par l'équipe le
 * confirme.
 */
export function optionFromParent(parent: { startsAt: Date; endsAt: Date; clientId: string | null; title: string }) {
  return {
    startsAt: parent.startsAt,
    endsAt: parent.endsAt,
    clientId: parent.clientId,
    title: parent.title,
  }
}

/**
 * Identifiants d'appareils lus d'un formulaire : sans doublon, dans l'ordre,
 * bornés. Un identifiant illisible est écarté ; la base dira le reste.
 */
export const MAX_OPTIONS_PER_BOOKING = 20

export function parseEquipmentIds(values: readonly unknown[]): string[] {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const ids: string[] = []
  for (const value of values) {
    const id = String(value ?? '').trim().toLowerCase()
    if (uuid.test(id) && !ids.includes(id)) ids.push(id)
  }
  return ids.slice(0, MAX_OPTIONS_PER_BOOKING)
}

/**
 * Total de la réservation et de son matériel, comme le devis le fera : la TVA
 * par taux, sur la somme des bases (`proposalTotals`). Un élément non chiffré
 * n'y entre pas ; `unpriced` le compte, pour que l'écran dise « l'accueil
 * précisera ».
 */
export function totalWithOptions(quotes: readonly (QuoteDisplay | null | undefined)[]): ProposalTotals & {
  currency: string | null
  unpriced: number
} {
  const priced = quotes.filter((quote): quote is QuoteDisplay => Boolean(quote))
  const totals = proposalTotals(
    priced.map((quote) => ({
      quantity: quote.quantity,
      unitPriceCents: quote.unitPriceCents,
      discountBp: quote.discountBp,
      discountAmountCents: quote.discountAmountCents,
      vatRateBp: quote.vatRateBp,
    })),
  )
  return { ...totals, currency: priced[0]?.currency ?? null, unpriced: quotes.length - priced.length }
}
