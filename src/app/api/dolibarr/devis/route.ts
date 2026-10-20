import { hasBearerToken, maintenanceNotFound } from '../../../../lib/maintenance.ts'
import { listProposalsForDolibarr } from '../../../../modules/facturation/propositions-queries.ts'
import { toDolibarrProposal } from '../../../../modules/facturation/propositions.ts'
import { proposalStatuses, type ProposalStatus } from '../../../../modules/facturation/schema-devis.ts'

/**
 * Devis à reprendre par Dolibarr (ADR 043, `docs/integrations/dolibarr.md`).
 *
 *   GET /api/dolibarr/devis                     devis prêts, les plus anciens d'abord
 *   GET /api/dolibarr/devis?statut=cancelled&depuis=2026-10-20T00:00:00Z
 *                                               devis annulés depuis cette date
 *
 * Jeton `DOLIBARR_API_TOKEN` en `Authorization: Bearer …`. Sans jeton valide,
 * la route n'existe pas (404), comme les routes de maintenance.
 */
export async function GET(request: Request) {
  if (!hasBearerToken(request, process.env.DOLIBARR_API_TOKEN)) return maintenanceNotFound()

  const url = new URL(request.url)
  const status = (url.searchParams.get('statut') ?? 'ready') as ProposalStatus
  if (!proposalStatuses.includes(status)) {
    return Response.json({ erreur: `Statut inconnu. Valeurs admises : ${proposalStatuses.join(', ')}.` }, { status: 400 })
  }
  const sinceParam = url.searchParams.get('depuis')
  const since = sinceParam ? new Date(sinceParam) : undefined
  if (since && Number.isNaN(since.getTime())) {
    return Response.json({ erreur: 'Date « depuis » illisible : attendu un instant ISO 8601.' }, { status: 400 })
  }
  const limit = Number(url.searchParams.get('limite') ?? 100)
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return Response.json({ erreur: 'La limite est un entier de 1 à 500.' }, { status: 400 })
  }

  const rows = await listProposalsForDolibarr({ status, since, limit })
  return Response.json({ devis: rows.map(toDolibarrProposal) })
}
