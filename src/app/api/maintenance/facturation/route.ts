import { eq } from 'drizzle-orm'

import { withTenant } from '../../../../db/index.ts'
import { tenants } from '../../../../db/tenants.ts'
import { isIsoMonth, todayIsoDate } from '../../../../lib/dates.ts'
import { isMaintenanceRequest, maintenanceNotFound } from '../../../../lib/maintenance.ts'
import { currentTenantId } from '../../../../lib/tenant.ts'
import { InvoiceRunInProgressError, runInvoicing } from '../../../../modules/facturation/lot-queries.ts'

/**
 * Lot de facturation planifié (R13, ADR 029, ADR 033) : prépare les factures
 * brouillons du mois du centre, comme le bouton de `/factures/preparer`, sans
 * membre de l'équipe (`invoice_runs.created_by` nul). Le lot n'émet rien :
 * l'équipe relit, puis émet.
 *
 * Appelée le 1er de chaque mois par une tâche du serveur
 * (infra/serveur/README.md), avec le jeton `MAINTENANCE_TOKEN`. `?mois=AAAA-MM`
 * rejoue un autre mois, à la main. Rejouable : un lot ne refacture rien.
 *
 * Réponses : 200 et le bilan ; 409 si un lot tourne déjà ; 400 pour un mois
 * illisible ; 404 sans jeton.
 */
export async function POST(request: Request) {
  if (!isMaintenanceRequest(request)) return maintenanceNotFound()

  const requested = new URL(request.url).searchParams.get('mois')
  if (requested !== null && !isIsoMonth(requested)) {
    return Response.json({ error: `Mois illisible : « ${requested} » (attendu : AAAA-MM).` }, { status: 400 })
  }
  const tenantId = currentTenantId()
  const month =
    requested ??
    (await withTenant(tenantId, async (tx) => {
      const [tenant] = await tx
        .select({ timezone: tenants.timezone })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
      // Le mois du centre, pas celui du serveur (décision 4).
      return todayIsoDate(tenant.timezone).slice(0, 7)
    }))

  try {
    const { runId, report } = await runInvoicing(month, null)
    return Response.json({ runId, month, ...report })
  } catch (error) {
    if (error instanceof InvoiceRunInProgressError) {
      return Response.json({ month, error: error.message }, { status: 409 })
    }
    throw error
  }
}
