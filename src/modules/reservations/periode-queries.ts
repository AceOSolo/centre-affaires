import { and, eq, gte, isNull, lte, or } from 'drizzle-orm'

import type { Transaction } from '../../db/index.ts'
import { addDaysToIsoDate, dayRangeUtc } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { closures, openingHours } from '../ressources/schema.ts'
import { listBusyRanges } from './creneaux-occupes.ts'
import { periodAvailability, type PeriodAvailability } from './periode.ts'

/**
 * Disponibilités d'une ressource sur plusieurs jours, à partir d'un jour
 * (ADR 061) : ses horaires, les fermetures de la période et ses créneaux
 * occupés — leurs heures seulement (`listBusyRanges`). Dans la transaction de
 * l'appelant : sous `withTenant()` pour la page publique, sous la portée
 * client pour l'espace client. Le calcul est celui de `periode.ts`.
 */
export async function loadPeriodAvailability(
  tx: Transaction,
  input: { resourceId: string; firstDate: string; dayCount: number; timeZone: string },
): Promise<PeriodAvailability> {
  const { resourceId, firstDate, timeZone } = input
  const dayCount = Math.max(1, input.dayCount)
  const lastDate = addDaysToIsoDate(firstDate, dayCount - 1)
  const tenantId = currentTenantId()
  // Les horaires propres de la ressource, et ceux du centre en repli (ADR 012).
  const rules = await tx
    .select({
      resourceId: openingHours.resourceId,
      weekday: openingHours.weekday,
      opensAt: openingHours.opensAt,
      closesAt: openingHours.closesAt,
    })
    .from(openingHours)
    .where(
      and(
        eq(openingHours.tenantId, tenantId),
        or(isNull(openingHours.resourceId), eq(openingHours.resourceId, resourceId)),
      ),
    )
  const periods = await tx
    .select({ resourceId: closures.resourceId, startsOn: closures.startsOn, endsOn: closures.endsOn })
    .from(closures)
    .where(and(eq(closures.tenantId, tenantId), lte(closures.startsOn, lastDate), gte(closures.endsOn, firstDate)))
  const busy = await listBusyRanges(
    tx,
    dayRangeUtc(firstDate, timeZone).startsAt,
    dayRangeUtc(lastDate, timeZone).endsAt,
    [resourceId],
  )
  return periodAvailability({ firstDate, dayCount, timeZone, resourceId, rules, closures: periods, busy })
}
