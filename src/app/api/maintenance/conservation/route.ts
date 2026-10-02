import { withTenant } from '../../../../db/index.ts'
import { isMaintenanceRequest, maintenanceNotFound } from '../../../../lib/maintenance.ts'
import { deleteObject } from '../../../../lib/stockage.ts'
import { currentTenantId } from '../../../../lib/tenant.ts'
import { purgeExpiredMail } from '../../../../modules/courrier/conservation.ts'
import { purgeExpiredNotificationDeliveries } from '../../../../modules/notifications/queries.ts'
import { anonymizeExpiredPublicRequests } from '../../../../modules/reservations/conservation.ts'

/**
 * Purge planifiée de ce qui est arrivé au terme de sa conservation : le
 * courrier et son journal d'accès (ADR 015), les coordonnées des demandeurs de
 * la page publique (ADR 020), le journal des messages envoyés (ADR 038). Les
 * durées sont celles du centre (`tenants`).
 *
 * Appelée chaque nuit par une tâche du serveur (infra/serveur/README.md), avec
 * le jeton `MAINTENANCE_TOKEN`. Sans jeton configuré, la route n'existe pas :
 * elle ne doit jamais être joignable sans secret.
 */
export async function POST(request: Request) {
  if (!isMaintenanceRequest(request)) return maintenanceNotFound()

  const tenantId = currentTenantId()
  // Les coordonnées des demandes publiques échues d'abord (B4, ADR 020), dans
  // leur propre transaction : une panne du stockage, qui interrompt la purge
  // du courrier, ne retient pas leur effacement.
  const publicRequests = await withTenant(tenantId, anonymizeExpiredPublicRequests)
  // Le journal des messages envoyés (ADR 038) aussi, avant le courrier et
  // pour la même raison.
  const notificationDeliveries = await withTenant(tenantId, purgeExpiredNotificationDeliveries)
  const mail = await withTenant(tenantId, (tx) => purgeExpiredMail(tx, deleteObject))
  return Response.json({ ...mail, publicRequests, notificationDeliveries })
}
