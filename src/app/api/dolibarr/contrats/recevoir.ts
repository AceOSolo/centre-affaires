import { readCrmContract } from '../../../../modules/contrats/contrats-crm.ts'
import { listContractsForCrm, receiveCrmContract } from '../../../../modules/contrats/contrats-crm-queries.ts'
import { crmGateway, serveCrmCall, type CrmGateway } from '../../../../modules/crm/appels.ts'
import { readListParams } from '../../../../modules/crm/parametres-api.ts'

/**
 * Contrats du CRM (ADR 066, `docs/integrations/dolibarr.md`), sans Next : les
 * tests appellent ces fonctions telles que la route les appelle.
 *
 * Jeton, centre, flux « Contrats » et journal des échanges : `serveCrmCall`
 * (ADR 065). Sans jeton valide, 404 ; flux coupé à l'écran, 403.
 */

export async function receiveContrat(
  request: Request,
  gateway: CrmGateway = crmGateway,
): Promise<{ response: Response; changed: boolean }> {
  const served = await serveCrmCall(
    request,
    { connector: 'dolibarr', flow: 'contracts', operation: 'POST /api/dolibarr/contrats' },
    async () => {
      const read = readCrmContract(await request.json().catch(() => null))
      if (!read.ok) return { response: Response.json({ erreur: read.message }, { status: 400 }), changed: false }
      const outcome = await receiveCrmContract('dolibarr', read.value)
      if (outcome.result === 'refuse') {
        return { response: Response.json({ erreur: outcome.message }, { status: outcome.status }), changed: false }
      }
      return {
        response: Response.json({
          ok: true,
          resultat: outcome.result,
          contratId: outcome.contractId,
          reference: outcome.reference,
          message: outcome.message,
        }),
        summary: `Contrat ${read.value.crmId} : ${outcome.message}`,
        changed: outcome.result !== 'inchange' && outcome.result !== 'ignore',
      }
    },
    gateway,
  )
  return { response: served.response, changed: served.handled?.changed ?? false }
}

export async function listContrats(request: Request, gateway: CrmGateway = crmGateway): Promise<Response> {
  const { response } = await serveCrmCall(
    request,
    { connector: 'dolibarr', flow: 'contracts', operation: 'GET /api/dolibarr/contrats' },
    async () => {
      const read = readListParams(new URL(request.url).searchParams, { linked: true, after: true }, 500)
      if (!read.ok) return { response: Response.json({ erreur: read.message }, { status: 400 }) }
      const contrats = await listContractsForCrm('dolibarr', read.params)
      return { response: Response.json({ contrats }), summary: `${contrats.length} contrat(s) du site.` }
    },
    gateway,
  )
  return response
}
