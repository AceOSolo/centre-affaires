import { addDaysToIsoDate, toWallClock, wallClockToUtc } from '../../lib/dates.ts'
import { isoWeekday, type TimeRange } from '../ressources/ouverture.ts'
import type { PlanningWindow } from './planning.ts'

/**
 * Vue semaine : sept colonnes, une par jour, sur une graduation horaire commune.
 *
 * La vue jour donne une colonne par ressource ; la semaine fait l'inverse, elle
 * suit une ressource sur sept jours. Les deux lectures répondent à des questions
 * différentes — « qui occupe quoi aujourd'hui » contre « quand cette salle est
 * libre cette semaine ».
 *
 * Les colonnes doivent être alignées pour être comparables : une graduation
 * commune, donc une amplitude murale commune. Chaque jour garde ensuite sa
 * propre fenêtre en instants, ce qui reste juste même si la semaine contient un
 * changement d'heure.
 */

/** Lundi de la semaine qui contient cette date. */
export function weekStart(isoDate: string): string {
  return addDaysToIsoDate(isoDate, 1 - isoWeekday(isoDate))
}

/** Les sept jours de la semaine, du lundi au dimanche. */
export function weekDays(isoDate: string): string[] {
  const monday = weekStart(isoDate)
  return Array.from({ length: 7 }, (_, index) => addDaysToIsoDate(monday, index))
}

const pad = (hour: number) => String(hour).padStart(2, '0')

/** Heure murale d'un instant, arrondie à l'heure inférieure. */
function wallHour(instant: Date, timeZone: string): number {
  return Number(toWallClock(instant, timeZone).slice(11, 13))
}

/**
 * Amplitude murale commune aux jours donnés.
 *
 * Prend la première ouverture et la dernière fermeture de la semaine, arrondies
 * à l'heure. Une journée qui déborde tire toute la grille, sinon ses
 * réservations sortiraient du cadre.
 */
export function weekExtent(
  ranges: readonly TimeRange[],
  timeZone: string,
  fallback = { openHour: 8, closeHour: 19 },
): { openHour: number; closeHour: number } {
  if (ranges.length === 0) return fallback

  let openHour = 24
  let closeHour = 0
  for (const range of ranges) {
    openHour = Math.min(openHour, wallHour(range.startsAt, timeZone))
    const wall = toWallClock(range.endsAt, timeZone)
    const hour = Number(wall.slice(11, 13))
    const minute = Number(wall.slice(14, 16))
    // Une fin à 18h30 impose d'afficher jusqu'à 19h00.
    closeHour = Math.max(closeHour, minute > 0 ? hour + 1 : hour)
  }

  // Une fin à minuit revient à 00h le lendemain : c'est la fin de la journée.
  if (closeHour <= openHour) closeHour = 24
  return { openHour, closeHour: Math.min(closeHour, 24) }
}

export type WeekColumn = {
  isoDate: string
  weekday: number
  window: PlanningWindow
  /** Aucune plage d'ouverture ce jour-là. */
  closed: boolean
}

/**
 * Colonnes de la semaine, toutes sur la même amplitude murale.
 *
 * Chaque colonne porte sa propre fenêtre en instants : le jour d'un changement
 * d'heure, la même amplitude murale ne fait pas la même durée, et positionner
 * les réservations dans la fenêtre du jour est la seule façon de rester juste.
 */
export function weekColumns(
  isoDate: string,
  timeZone: string,
  extent: { openHour: number; closeHour: number },
  openingByDay: Record<string, TimeRange[]>,
): WeekColumn[] {
  return columnsForDays(weekDays(isoDate), timeZone, extent, openingByDay)
}

/**
 * Mêmes colonnes, pour une suite de jours quelconque.
 *
 * Le back-office raisonne en semaine calendaire — le staff dit « mardi
 * prochain ». Le portail, lui, n'a aucune raison d'afficher les quatre jours
 * révolus quand on y arrive un vendredi : sept jours glissants à partir
 * d'aujourd'hui remplissent la grille de créneaux réservables.
 */
export function columnsForDays(
  days: readonly string[],
  timeZone: string,
  extent: { openHour: number; closeHour: number },
  openingByDay: Record<string, TimeRange[]>,
): WeekColumn[] {
  return days.map((day) => ({
    isoDate: day,
    weekday: isoWeekday(day),
    closed: (openingByDay[day] ?? []).length === 0,
    window: {
      startsAt: wallClockToUtc(`${day}T${pad(extent.openHour)}:00`, timeZone),
      endsAt:
        extent.closeHour >= 24
          ? wallClockToUtc(`${addDaysToIsoDate(day, 1)}T00:00`, timeZone)
          : wallClockToUtc(`${day}T${pad(extent.closeHour)}:00`, timeZone),
    },
  }))
}
