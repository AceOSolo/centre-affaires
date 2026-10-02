import { isMaintenanceRequest, maintenanceNotFound } from '../../../../lib/maintenance.ts'
import { deleteObject } from '../../../../lib/stockage.ts'
import { currentTenantId } from '../../../../lib/tenant.ts'
import { runNightlyConservation } from '../../../../modules/rgpd/tache-de-nuit.ts'

/**
 * Purge planifiée de ce qui est arrivé au terme de sa conservation : le
 * courrier et son journal d'accès (ADR 015), les coordonnées des demandeurs de
 * la page publique (ADR 020), les entreprises et les personnes retirées à
 * anonymiser (R29, ADR 040), le journal des messages envoyés (ADR 038), les
 * photos d'états des lieux et le journal de leurs consultations (R33,
 * ADR 039). Les durées sont celles du centre (`tenants`).
 *
 * Chaque purge et chaque anonymisation a sa propre transaction et son propre
 * filet (`runNightlyConservation`) : l'échec de l'une (le stockage
 * injoignable, par exemple) ne retient pas les autres, qui passent avant le
 * stockage. Le bilan dit ce qui a été fait ; s'il manque une étape (`failed`),
 * la réponse est un 500 pour que la tâche du serveur le signale.
 *
 * Appelée chaque nuit par une tâche du serveur (infra/serveur/README.md), avec
 * le jeton `MAINTENANCE_TOKEN`. Sans jeton configuré, la route n'existe pas :
 * elle ne doit jamais être joignable sans secret.
 */
export async function POST(request: Request) {
  if (!isMaintenanceRequest(request)) return maintenanceNotFound()

  const report = await runNightlyConservation(currentTenantId(), deleteObject)
  return Response.json(report, { status: report.failed.length > 0 ? 500 : 200 })
}
