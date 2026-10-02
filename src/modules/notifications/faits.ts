import { eq } from 'drizzle-orm'

import type { Transaction } from '../../db/index.ts'
import { tenants } from '../../db/tenants.ts'
import { formatDateTime, formatLongDate, formatTime, toIsoDate } from '../../lib/dates.ts'
import type { MailRequestKind } from '../courrier/schema.ts'

/**
 * Faits communs aux déclencheurs : mise en forme des dates à l'heure du
 * centre (décision 4), noms des personnes, natures des demandes. Fonctions
 * pures, sauf `centreTimeZone`.
 */

/** Fuseau du centre, lu dans la transaction du déclencheur. */
export async function centreTimeZone(tx: Transaction, tenantId: string): Promise<string> {
  const [row] = await tx.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId))
  return row?.timezone ?? 'Europe/Paris'
}

/**
 * « lundi 5 octobre 2026, de 09:00 à 11:00 » ; sur plusieurs jours, « du
 * lundi 5 octobre 2026 à 09:00 au mardi 6 octobre 2026 à 18:00 ».
 */
export function formatSlot(startsAt: Date, endsAt: Date, timeZone: string): string {
  const startDay = toIsoDate(startsAt, timeZone)
  // Une réservation qui finit à minuit pile reste sur son jour : la borne
  // haute est exclue (`[)`).
  const endDay = toIsoDate(new Date(endsAt.getTime() - 1), timeZone)
  if (startDay === endDay) {
    return `${formatLongDate(startDay, timeZone)}, de ${formatTime(startsAt, timeZone)} à ${formatTime(endsAt, timeZone)}`
  }
  return (
    `du ${formatLongDate(startDay, timeZone)} à ${formatTime(startsAt, timeZone)} ` +
    `au ${formatLongDate(toIsoDate(endsAt, timeZone), timeZone)} à ${formatTime(endsAt, timeZone)}`
  )
}

/** « 1 oct. 2026 à 09:30 », à l'heure du centre. */
export function formatInstant(instant: Date, timeZone: string): string {
  return formatDateTime(instant, timeZone)
}

/** Nom d'une personne, ou à défaut son adresse. */
export function personName(fullName: string | null | undefined, email: string | null | undefined): string | null {
  return fullName?.trim() || email?.trim() || null
}

/** Nature d'une demande de courrier, telle qu'un message la cite. */
export const mailRequestKindPhrases: Record<MailRequestKind, string> = {
  open_and_scan: 'ouverture et numérisation',
  scan: 'numérisation',
  forward: 'réexpédition',
}
