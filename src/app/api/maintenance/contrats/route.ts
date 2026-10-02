import { eq } from 'drizzle-orm'

import { withTenant } from '../../../../db/index.ts'
import { tenants } from '../../../../db/tenants.ts'
import { todayIsoDate } from '../../../../lib/dates.ts'
import { isMaintenanceRequest, maintenanceNotFound } from '../../../../lib/maintenance.ts'
import { currentTenantId } from '../../../../lib/tenant.ts'
import { renewTacitContracts } from '../../../../modules/contrats/reconduction-queries.ts'

/**
 * Reconduction tacite des contrats (R10, ADR 023, ADR 033) : chaque nuit,
 * prolonge les contrats dont la reconduction est acquise — un préavis donné
 * ce jour-là ne mettrait plus fin au contrat à son terme — et l'inscrit au
 * journal `contract_renewals`.
 *
 * Appelée chaque nuit par une tâche du serveur (infra/serveur/README.md), avec
 * le jeton `MAINTENANCE_TOKEN`. Rend les contrats prolongés et ceux qui n'ont
 * pas pu l'être (ressource déjà occupée après le terme).
 */
export async function POST(request: Request) {
  if (!isMaintenanceRequest(request)) return maintenanceNotFound()

  const tenantId = currentTenantId()
  const report = await withTenant(tenantId, async (tx) => {
    const [tenant] = await tx.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId))
    // Le jour du centre, pas celui du serveur (décision 4).
    return renewTacitContracts(tx, todayIsoDate(tenant.timezone))
  })
  return Response.json(report)
}
