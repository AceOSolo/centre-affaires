import { resourceTypes, type ResourceType } from '../ressources/schema.ts'
import type { OccupancyResource, OccupancySummary, ResourceOccupancy, TypeOccupancy } from './occupation.ts'
import { zeroAmounts, type RevenueAmounts } from './revenus.ts'

/**
 * Lignes des tableaux « par type » et « par ressource » : l'occupation et le
 * revenu côte à côte (R31). Une ressource y figure si elle fait partie du parc
 * observé ou si elle a produit du revenu sur la période — une salle retirée du
 * parc mais facturée ce mois-ci reste visible, sans taux.
 */

export type ResourceIndicatorRow<R extends OccupancyResource> = {
  resource: R
  /** Nul : hors du parc observé (retirée ou archivée, inoccupée). */
  occupancy: ResourceOccupancy<R> | null
  revenue: RevenueAmounts
}

export function resourceIndicatorRows<R extends OccupancyResource>(
  resources: readonly R[],
  occupancy: OccupancySummary<R>,
  byResource: ReadonlyMap<string, RevenueAmounts>,
): ResourceIndicatorRow<R>[] {
  const occupied = new Map(occupancy.resources.map((row) => [row.resource.id, row]))
  return resources
    .filter((resource) => occupied.has(resource.id) || byResource.has(resource.id))
    .map((resource) => ({
      resource,
      occupancy: occupied.get(resource.id) ?? null,
      revenue: byResource.get(resource.id) ?? zeroAmounts(),
    }))
}

export type TypeIndicatorRow = {
  resourceType: ResourceType
  occupancy: TypeOccupancy | null
  revenue: RevenueAmounts
}

/** Un type par ligne, dans l'ordre du catalogue des types (R01). */
export function typeIndicatorRows(
  types: readonly TypeOccupancy[],
  byType: ReadonlyMap<ResourceType, RevenueAmounts>,
): TypeIndicatorRow[] {
  const occupied = new Map(types.map((type) => [type.resourceType, type]))
  return resourceTypes
    .filter((resourceType) => occupied.has(resourceType) || byType.has(resourceType))
    .map((resourceType) => ({
      resourceType,
      occupancy: occupied.get(resourceType) ?? null,
      revenue: byType.get(resourceType) ?? zeroAmounts(),
    }))
}

/** Somme des revenus, pour le pied de tableau. */
export function totalRevenue(rows: readonly { revenue: RevenueAmounts }[]): RevenueAmounts {
  const total = zeroAmounts()
  for (const { revenue } of rows) {
    total.invoicedCents += revenue.invoicedCents
    total.creditedCents += revenue.creditedCents
    total.netCents += revenue.netCents
  }
  return total
}
