import { serveCrmCall } from '../../../../modules/crm/appels.ts'
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
 * Jeton en `Authorization: Bearer …` : celui réglé à l'écran « Connexion au
 * CRM », qui désigne le centre, ou `DOLIBARR_API_TOKEN` tant qu'aucun n'y est
 * réglé (ADR 065). Sans jeton valide, la route n'existe pas (404) ; flux
 * « Devis » coupé à l'écran : 403.
 */
export async function GET(request: Request) {
  const { response } = await serveCrmCall(
    request,
    { connector: 'dolibarr', flow: 'quotes', operation: 'GET /api/dolibarr/devis' },
    async () => {
      const url = new URL(request.url)
      const status = (url.searchParams.get('statut') ?? 'ready') as ProposalStatus
      if (!proposalStatuses.includes(status)) {
        return {
          response: Response.json(
            { erreur: `Statut inconnu. Valeurs admises : ${proposalStatuses.join(', ')}.` },
            { status: 400 },
          ),
        }
      }
      const sinceParam = url.searchParams.get('depuis')
      const since = sinceParam ? new Date(sinceParam) : undefined
      if (since && Number.isNaN(since.getTime())) {
        return {
          response: Response.json(
            { erreur: 'Date « depuis » illisible : attendu un instant ISO 8601.' },
            { status: 400 },
          ),
        }
      }
      const limit = Number(url.searchParams.get('limite') ?? 100)
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return { response: Response.json({ erreur: 'La limite est un entier de 1 à 500.' }, { status: 400 }) }
      }

      const rows = await listProposalsForDolibarr({ status, since, limit })
      return {
        response: Response.json({ devis: rows.map(toDolibarrProposal) }),
        summary: `${rows.length} devis au statut « ${status} ».`,
      }
    },
  )
  return response
}
