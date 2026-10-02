import { openingWindows, type ClosurePeriod, type OpeningRule } from '../ressources/ouverture.ts'
import type { TimeRange } from './availability.ts'
import { freeMinutes, freeRanges } from './slots.ts'

/**
 * Disponibilités d'une journée, ressource par ressource : le moteur commun du
 * back-office, de la page publique (`listDayAvailability`) et de l'espace
 * client (`listPortalDayAvailability`, R23).
 *
 * Module pur : chaque appelant lit les ressources, les règles d'ouverture et
 * les créneaux occupés dans sa propre transaction — sous `withTenant()` pour
 * la page publique, sous la portée client pour l'espace client, qui ne lit
 * des autres réservations que leurs heures (`booking_busy_ranges()`). Le
 * calcul, lui, est le même.
 *
 * Les trous sont cherchés à l'intérieur des vraies plages d'ouverture, une par
 * une : un centre qui ferme entre 12 h et 14 h ne propose pas la pause
 * déjeuner. « Fermé » (aucune plage ce jour-là) et « complet » (des plages,
 * toutes prises) restent deux réponses distinctes.
 */

/** Un créneau occupé : seulement ses heures et sa ressource, jamais ce qui l'occupe. */
export type BusyRange = TimeRange & { resourceId: string }

export type OpeningRules = {
  rules: readonly OpeningRule[]
  closures: readonly ClosurePeriod[]
}

export type DayAvailabilityOf<R> = {
  resource: R
  free: TimeRange[]
  freeMinutes: number
  /** Fermé ce jour-là : aucune plage d'ouverture, ou fermeture exceptionnelle. */
  closed: boolean
}

/**
 * Plages libres de chaque ressource un jour donné. `busy` ne contient que ce
 * qui occupe réellement : les annulées libèrent leur créneau, les demandes en
 * attente le bloquent (ADR 005).
 */
export function dayAvailability<R extends { id: string }>(
  isoDate: string,
  timeZone: string,
  resources: readonly R[],
  busy: readonly BusyRange[],
  opening: OpeningRules,
): DayAvailabilityOf<R>[] {
  return resources.map((resource) => {
    const windows = openingWindows(isoDate, timeZone, {
      rules: opening.rules,
      closures: opening.closures,
      resourceId: resource.id,
    })
    const own = busy.filter((range) => range.resourceId === resource.id)
    const free = windows.flatMap((window) => freeRanges(window, own))
    return { resource, free, freeMinutes: freeMinutes(free), closed: windows.length === 0 }
  })
}
