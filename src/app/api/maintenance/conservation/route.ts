import { withTenant } from '../../../../db/index.ts'
import { isMaintenanceRequest, maintenanceNotFound } from '../../../../lib/maintenance.ts'
import { deleteObject } from '../../../../lib/stockage.ts'
import { currentTenantId } from '../../../../lib/tenant.ts'
import { purgeExpiredMail } from '../../../../modules/courrier/conservation.ts'
import {
  purgeExpiredInspectionPhotos,
  purgeExpiredInspectionPhotoViews,
} from '../../../../modules/etats-des-lieux/conservation.ts'
import { purgeExpiredNotificationDeliveries } from '../../../../modules/notifications/queries.ts'
import { anonymizeExpiredPublicRequests } from '../../../../modules/reservations/conservation.ts'
import {
  anonymizeExpiredClients,
  anonymizeRemovedMembers,
} from '../../../../modules/rgpd/anonymisation.ts'
import { anonymizationLogLine } from '../../../../modules/rgpd/bilan.ts'

/**
 * Purge planifiée de ce qui est arrivé au terme de sa conservation : le
 * courrier et son journal d'accès (ADR 015), les coordonnées des demandeurs de
 * la page publique (ADR 020), les entreprises et les personnes retirées à
 * anonymiser (R29, ADR 040), le journal des messages envoyés (ADR 038), les
 * photos d'états des lieux et le journal de leurs consultations (R33,
 * ADR 039). Les durées sont celles du centre (`tenants`).
 *
 * Chaque purge et chaque anonymisation a sa propre transaction : l'échec de
 * l'une (le stockage injoignable, par exemple) ne retient pas les autres.
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
  // L'anonymisation RGPD (ADR 040), chacune dans sa transaction et avant le
  // stockage, pour la même raison. La base choisit qui et quoi, exclusions
  // comprises ; le journal ne reçoit que des nombres.
  const anonymizedClients = await withTenant(tenantId, anonymizeExpiredClients)
  const anonymizedMembers = await withTenant(tenantId, anonymizeRemovedMembers)
  console.info(anonymizationLogLine(anonymizedClients, anonymizedMembers))
  // Le journal des messages envoyés (ADR 038) aussi, avant le courrier et
  // pour la même raison.
  const notificationDeliveries = await withTenant(tenantId, purgeExpiredNotificationDeliveries)
  const mail = await withTenant(tenantId, (tx) => purgeExpiredMail(tx, deleteObject))
  // États des lieux (R33, ADR 039) : le journal des consultations des photos
  // d'abord, dans sa transaction — il ne dépend pas du stockage —, puis les
  // photos échues, fichier effacé avant que la base ne marque la ligne.
  const inspectionPhotoViews = await withTenant(tenantId, purgeExpiredInspectionPhotoViews)
  const inspectionPhotos = await withTenant(tenantId, (tx) =>
    purgeExpiredInspectionPhotos(tx, deleteObject),
  )
  return Response.json({
    ...mail,
    publicRequests,
    anonymizedClients,
    anonymizedMembers,
    notificationDeliveries,
    inspectionPhotos,
    inspectionPhotoViews,
  })
}
