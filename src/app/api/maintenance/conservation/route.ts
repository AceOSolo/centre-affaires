import { withTenant } from '../../../../db/index.ts'
import { isMaintenanceRequest, maintenanceNotFound } from '../../../../lib/maintenance.ts'
import { deleteObject } from '../../../../lib/stockage.ts'
import { currentTenantId } from '../../../../lib/tenant.ts'
import { purgeExpiredMail } from '../../../../modules/courrier/conservation.ts'
import {
  purgeExpiredInspectionPhotos,
  purgeExpiredInspectionPhotoViews,
} from '../../../../modules/etats-des-lieux/conservation.ts'
import { anonymizeExpiredPublicRequests } from '../../../../modules/reservations/conservation.ts'

/**
 * Purge planifiée de ce qui est arrivé au terme de sa conservation : le
 * courrier et son journal d'accès (ADR 015), les coordonnées des demandeurs de
 * la page publique (ADR 020). Les durées sont celles du centre (`tenants`).
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
  const mail = await withTenant(tenantId, (tx) => purgeExpiredMail(tx, deleteObject))
  // États des lieux (R33, ADR 039) : le journal des consultations des photos
  // d'abord, dans sa transaction — il ne dépend pas du stockage —, puis les
  // photos échues, fichier effacé avant que la base ne marque la ligne.
  const inspectionPhotoViews = await withTenant(tenantId, purgeExpiredInspectionPhotoViews)
  const inspectionPhotos = await withTenant(tenantId, (tx) =>
    purgeExpiredInspectionPhotos(tx, deleteObject),
  )
  return Response.json({ ...mail, publicRequests, inspectionPhotos, inspectionPhotoViews })
}
