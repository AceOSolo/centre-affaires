import { isMaintenanceRequest, maintenanceNotFound } from '../../../../lib/maintenance.ts'
import { pushReadyProposals } from '../../../../modules/facturation/devis-dolibarr-envoi.ts'

/**
 * Reprise de l'envoi des devis à Dolibarr (ADR 073) : renvoie les devis
 * « prêts » que le site n'a pas pu créer dans le CRM (coupure, clé refusée le
 * temps d'un réglage). Sans effet tant que la direction n'a pas demandé
 * l'envoi des devis (Réglages > Connexion au CRM).
 *
 * Appelée toutes les quelques minutes par une tâche du serveur
 * (infra/serveur/README.md) avec le jeton `MAINTENANCE_TOKEN`. Rend le nombre
 * de devis envoyés et en échec, et pourquoi rien n'est parti le cas échéant ;
 * le détail de chaque échec est au journal des échanges du centre.
 */
export async function POST(request: Request) {
  if (!isMaintenanceRequest(request)) return maintenanceNotFound()
  return Response.json(await pushReadyProposals())
}
