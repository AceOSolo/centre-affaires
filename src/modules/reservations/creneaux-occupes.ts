import { and, asc, eq, gt, inArray, lt, ne } from 'drizzle-orm'

import { tenantContext } from '../../db/contexte.ts'
import type { Transaction } from '../../db/index.ts'
import type { BusyRange } from './disponibilites.ts'
import { bookings } from './schema.ts'

/**
 * Créneaux occupés du centre courant, sans rien de ce qui les occupe : ni
 * objet, ni client, ni demandeur. Ce que la page publique montre déjà, lisible
 * depuis une transaction en portée client (ADR 019), qui ne doit voir que ses
 * propres réservations ailleurs.
 *
 * Remplace la fonction SQL `booking_busy_ranges()` de PostgreSQL : MySQL n'a
 * plus de politique de lecture à contourner, la requête ne sélectionne
 * simplement que `resource_id`, `starts_at` et `ends_at`. C'est la **seule**
 * lecture de `bookings` sous portée client qui n'est pas filtrée sur les
 * entreprises du compte, volontairement, et elle ne rend que des heures.
 *
 * Bornes `[)`, annulées exclues : le prédicat du garde anti-chevauchement.
 */
export async function listBusyRanges(
  tx: Transaction,
  from: Date,
  to: Date,
  resourceIds?: readonly string[],
): Promise<BusyRange[]> {
  if (resourceIds && resourceIds.length === 0) return []
  const tenantId = tenantContext.getStore()
  const rows = await tx
    .select({
      resourceId: bookings.resourceId,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
    })
    .from(bookings)
    .where(
      and(
        tenantId ? eq(bookings.tenantId, tenantId) : undefined,
        ne(bookings.status, 'cancelled'),
        lt(bookings.startsAt, to),
        gt(bookings.endsAt, from),
        resourceIds ? inArray(bookings.resourceId, [...resourceIds]) : undefined,
      ),
    )
    .orderBy(asc(bookings.resourceId), asc(bookings.startsAt))
  return rows
}
