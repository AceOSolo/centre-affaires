import { readThirdParty } from '../../../../modules/clients/tiers-crm.ts'
import { listThirdPartiesForCrm, receiveThirdParty } from '../../../../modules/clients/tiers-crm-queries.ts'
import { crmGateway, serveCrmCall, type CrmGateway } from '../../../../modules/crm/appels.ts'
import { readListParams } from '../../../../modules/crm/parametres-api.ts'

/**
 * Tiers du CRM (ADR 066, `docs/integrations/dolibarr.md`), sans Next : les
 * tests appellent ces fonctions telles que la route les appelle ; la route
 * n'y ajoute que le rafraîchissement des pages.
 *
 * Jeton, centre, flux « Tiers » et journal des échanges : `serveCrmCall`
 * (ADR 065). Sans jeton valide, 404 ; flux coupé à l'écran, 403.
 */

export async function receiveTiers(
  request: Request,
  gateway: CrmGateway = crmGateway,
): Promise<{ response: Response; changed: boolean }> {
  const served = await serveCrmCall(
    request,
    { connector: 'dolibarr', flow: 'third_parties', operation: 'POST /api/dolibarr/tiers' },
    async () => {
      const read = readThirdParty(await request.json().catch(() => null))
      if (!read.ok) return { response: Response.json({ erreur: read.message }, { status: 400 }), changed: false }
      const outcome = await receiveThirdParty('dolibarr', read.value)
      if (outcome.result === 'refuse') {
        return { response: Response.json({ erreur: outcome.message }, { status: outcome.status }), changed: false }
      }
      return {
        response: Response.json({
          ok: true,
          resultat: outcome.result,
          clientId: outcome.clientId,
          message: outcome.message,
          avertissements: outcome.warnings,
        }),
        summary: `Tiers ${read.value.crmId} : ${outcome.message}`,
        changed: outcome.result !== 'inchange' && outcome.result !== 'ignore',
      }
    },
    gateway,
  )
  return { response: served.response, changed: served.handled?.changed ?? false }
}

export async function listTiers(request: Request, gateway: CrmGateway = crmGateway): Promise<Response> {
  const { response } = await serveCrmCall(
    request,
    { connector: 'dolibarr', flow: 'third_parties', operation: 'GET /api/dolibarr/tiers' },
    async () => {
      const read = readListParams(new URL(request.url).searchParams, { linked: true, after: true }, 500)
      if (!read.ok) return { response: Response.json({ erreur: read.message }, { status: 400 }) }
      const tiers = await listThirdPartiesForCrm('dolibarr', read.params)
      return { response: Response.json({ tiers }), summary: `${tiers.length} fiche(s) du site.` }
    },
    gateway,
  )
  return response
}
