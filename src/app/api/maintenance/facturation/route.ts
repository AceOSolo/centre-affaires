import { isMaintenanceRequest, maintenanceNotFound } from '../../../../lib/maintenance.ts'

/**
 * Ancien lot de facturation planifié (R13, ADR 029, ADR 033), arrêté : la
 * facturation est tenue dans Dolibarr (ADR 046). Le site n'en prépare plus
 * aucune, pour qu'un client ne soit jamais facturé deux fois.
 *
 * La route répond encore, en 410, tant que la tâche du 1er du mois n'est pas
 * retirée de la crontab du serveur (infra/serveur/README.md) : son échec dans
 * le journal le rappelle. Sans jeton, 404, comme toute route de maintenance.
 */
export async function POST(request: Request) {
  if (!isMaintenanceRequest(request)) return maintenanceNotFound()
  return Response.json(
    { error: 'Facturation tenue dans Dolibarr (ADR 046) : retirer cette tâche de la crontab.' },
    { status: 410 },
  )
}
