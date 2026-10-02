import type { AnonymizationBasis } from '../../db/staff.ts'
import { formatCalendarDate } from '../../lib/dates.ts'

/**
 * Fondement d'une anonymisation (R29, ADR 040 et 041) : ce que l'équipe dit
 * d'une anonymisation à la demande, et ce que les écrans en montrent.
 *
 * La base refuse les mêmes choses (`anonymization_request_check`, `CA012`) ;
 * cette règle les dit avant, près du champ, sans aller-retour.
 */

/** Fondements d'une anonymisation décidée par l'équipe ; « au terme » est celui de la nuit. */
export const onRequestBases = ['erasure_request', 'relationship_ended'] as const
export type OnRequestBasis = (typeof onRequestBases)[number]

export const onRequestBasisLabels: Record<OnRequestBasis, string> = {
  erasure_request: 'Demande d’effacement de la personne concernée (droit à l’effacement)',
  relationship_ended: 'Fin de la relation constatée par le centre',
}

export type AnonymizationRequestInput =
  | { ok: true; basis: OnRequestBasis; erasureRequestedOn: string | null }
  | { ok: false; error: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * Le fondement saisi : une demande d'effacement est datée du jour où le centre
 * l'a reçue, jamais à venir — le centre a un mois pour y répondre
 * (art. 12-3 du RGPD) ; une fin de relation ne porte pas de date.
 */
export function parseAnonymizationRequest(
  input: { basis: string; erasureRequestedOn: string },
  today: string,
): AnonymizationRequestInput {
  const basis = onRequestBases.find((candidate) => candidate === input.basis)
  if (!basis) {
    return { ok: false, error: 'Choisissez le fondement de l’anonymisation : demande d’effacement, ou fin de la relation.' }
  }
  if (basis === 'relationship_ended') return { ok: true, basis, erasureRequestedOn: null }
  const day = input.erasureRequestedOn.trim()
  if (!day) {
    return { ok: false, error: 'Indiquez le jour où la demande d’effacement a été reçue.' }
  }
  if (!isCalendarDate(day)) {
    return { ok: false, error: 'Date de la demande invalide : utilisez le sélecteur de date (jj/mm/aaaa).' }
  }
  if (day > today) {
    return { ok: false, error: 'La demande d’effacement ne peut pas être datée d’un jour à venir.' }
  }
  return { ok: true, basis, erasureRequestedOn: day }
}

/** Ce qu'une ligne anonymisée dit de son anonymisation. */
export type AnonymizationTrace = {
  basis: AnonymizationBasis | null
  erasureRequestedOn: string | null
  /** Nom du membre de l'équipe qui l'a décidée ; nul pour la nuit. */
  byName: string | null
}

/**
 * « à la demande d'effacement reçue le 28/09/2026, par Camille Martin » ;
 * « au terme de la durée de conservation » ; rien pour une anonymisation
 * antérieure au fondement tracé (migration 0044).
 */
export function anonymizationTraceLabel(trace: AnonymizationTrace): string | null {
  const by = trace.byName ? `, par ${trace.byName}` : ''
  switch (trace.basis) {
    case 'retention':
      return 'au terme de la durée de conservation'
    case 'erasure_request':
      return `à la demande d’effacement${
        trace.erasureRequestedOn ? ` reçue le ${formatCalendarDate(trace.erasureRequestedOn)}` : ''
      }${by}`
    case 'relationship_ended':
      return `à la fin de la relation${by}`
    default:
      return null
  }
}
