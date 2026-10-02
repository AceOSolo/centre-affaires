import { formatCalendarDate, toIsoDate } from '../../lib/dates.ts'

/**
 * « 02/10/2026 » : le jour du centre où tombe un instant de la base (UTC,
 * décision 4) — date d'anonymisation, de retrait.
 */
export function formatCentreDay(instant: Date, timeZone: string): string {
  return formatCalendarDate(toIsoDate(instant, timeZone))
}

/** « 02/10/2026 » pour une date de calendrier déjà au jour du centre. */
export { formatCalendarDate }
