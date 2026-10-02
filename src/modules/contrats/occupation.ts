import { addDaysToIsoDate, toIsoDate, wallClockToUtc } from '../../lib/dates.ts'
import type { TimeRange } from '../reservations/availability.ts'
import { OPEN_ENDED_BOOKING_END } from '../reservations/schema.ts'
import type { ContractStatus } from './schema.ts'

/**
 * Occupation d'une ressource par son contrat (ADR 018), vue du code.
 *
 * L'autorité est en base : `apply_contract_occupation` (migration 0026) écrit
 * la ligne de `bookings`, et la contrainte d'exclusion tranche. Ces fonctions
 * reproduisent les mêmes règles pour trois usages seulement : annoncer sur la
 * fiche ce que l'activation occupera, nommer la réservation qui bloque quand la
 * base refuse, et dire si un contrat couvre un créneau (R05). Elles doivent
 * donner exactement les bornes que la base calcule.
 */

/** Ce qu'il faut d'un contrat pour dater son occupation. */
export type ContractPeriod = {
  startsOn: string
  /** Nul : durée indéterminée. */
  endsOn: string | null
  terminatedOn: string | null
}

/**
 * Dernier jour du contrat, borne comprise : le plus proche du terme prévu et de
 * la résiliation — `least(ends_on, terminated_on)` en SQL, qui ignore les nuls.
 * Nul pour un contrat sans terme, non résilié.
 */
export function lastContractDay({ endsOn, terminatedOn }: ContractPeriod): string | null {
  if (endsOn && terminatedOn) return endsOn <= terminatedOn ? endsOn : terminatedOn
  return endsOn ?? terminatedOn
}

/**
 * Le contrat occupe-t-il sa ressource ? Même prédicat que la base : non
 * archivé, en cours ou résilié, avec une ressource, et un dernier jour qui ne
 * précède pas le premier (une résiliation antérieure au début n'occupe rien).
 */
export function contractOccupiesResource(
  contract: ContractPeriod & {
    status: ContractStatus
    resourceId: string | null
    deletedAt: Date | null
  },
): boolean {
  const lastDay = lastContractDay(contract)
  return (
    contract.deletedAt === null &&
    (contract.status === 'active' || contract.status === 'terminated') &&
    contract.resourceId !== null &&
    (lastDay === null || lastDay >= contract.startsOn)
  )
}

/**
 * La ressource d'un contrat en cours peut-elle encore changer ? Seulement s'il
 * n'a pas commencé : son premier jour vient après `today`, jour du centre.
 *
 * L'occupation couvre toute la période du contrat (ADR 018). Changer de
 * ressource après le début la réécrirait depuis le premier jour : l'ancienne
 * ressource perdrait la période écoulée, et la nouvelle serait refusée dès
 * qu'elle a été occupée depuis, même dans le passé. En attendant les avenants
 * (R12), on résilie puis on crée un nouveau contrat. Un brouillon, lui, se
 * modifie en entier ; un contrat résilié ou archivé ne change plus.
 */
export function canChangeContractResource(
  contract: { status: ContractStatus; deletedAt: Date | null; startsOn: string },
  today: string,
): boolean {
  return contract.status === 'active' && contract.deletedAt === null && contract.startsOn > today
}

/**
 * Bornes `[)` de la période d'un contrat, en instants : du premier jour à
 * minuit, heure du centre, au lendemain du dernier jour à minuit. Un contrat
 * sans terme court jusqu'à `OPEN_ENDED_BOOKING_END`, comme en base.
 *
 * Le fuseau est celui du centre, jamais l'UTC : un contrat du 1er mars au
 * 30 juin à Paris commence à 23h00 UTC la veille et finit à 22h00 UTC.
 */
export function contractRange(contract: ContractPeriod, timeZone: string): TimeRange {
  const lastDay = lastContractDay(contract)
  return {
    startsAt: wallClockToUtc(`${contract.startsOn}T00:00`, timeZone),
    endsAt: lastDay
      ? wallClockToUtc(`${addDaysToIsoDate(lastDay, 1)}T00:00`, timeZone)
      : OPEN_ENDED_BOOKING_END,
  }
}

/**
 * Jours civils couverts par une occupation, pour l'afficher « du 1er mars au
 * 30 juin » plutôt qu'en instants. `lastDay` est nul pour une occupation sans
 * terme, à afficher « sans terme » (ADR 018).
 */
export function occupationDays(
  range: TimeRange,
  timeZone: string,
): { firstDay: string; lastDay: string | null } {
  return {
    firstDay: toIsoDate(range.startsAt, timeZone),
    lastDay:
      range.endsAt.getTime() >= OPEN_ENDED_BOOKING_END.getTime()
        ? null
        : addDaysToIsoDate(toIsoDate(range.endsAt, timeZone), -1),
  }
}

/** « 01/03/2026 » : une date de calendrier, identique dans tous les fuseaux. */
export function formatCalendarDate(isoDate: string): string {
  return `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}/${isoDate.slice(0, 4)}`
}

/** « du 01/03/2026 au 30/06/2026 », « à partir du 01/03/2026, sans terme ». */
export function formatContractDays({
  firstDay,
  lastDay,
}: {
  firstDay: string
  lastDay: string | null
}): string {
  if (lastDay === null) return `à partir du ${formatCalendarDate(firstDay)}, sans terme`
  if (lastDay === firstDay) return `le ${formatCalendarDate(firstDay)}`
  return `du ${formatCalendarDate(firstDay)} au ${formatCalendarDate(lastDay)}`
}
