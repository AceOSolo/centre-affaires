import { isUuid } from '../../../../../../lib/uuid.ts'
import { readCrmId } from '../../../../../../modules/clients/tiers-crm.ts'
import { serveCrmCall } from '../../../../../../modules/crm/appels.ts'
import { markConsumptionSent } from '../../../../../../modules/crm/consommations-queries.ts'

/**
 * Dolibarr a repris la consommation (ADR 066) — une ligne de facture, une
 * facture, à lui de dire :
 *
 *   POST /api/dolibarr/consommations/{id}/transmis
 *   { "dolibarrId": "1834", "dolibarrRef": "FA2611-0042" }
 *
 * Rejouable : le même appel une seconde fois répond 200 sans rien changer.
 * 409 si la consommation est annulée (ne pas la facturer) ou déjà reprise sous
 * un autre identifiant. Jeton et flux : `serveCrmCall` (ADR 065).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { response } = await serveCrmCall(
    request,
    { connector: 'dolibarr', flow: 'consumptions', operation: 'POST /api/dolibarr/consommations/{id}/transmis' },
    async () => {
      const { id } = await params
      if (!isUuid(id)) return { response: Response.json({ erreur: 'Consommation introuvable.' }, { status: 404 }) }

      const body = (await request.json().catch(() => null)) as { dolibarrId?: unknown; dolibarrRef?: unknown } | null
      const crmId = readCrmId(body?.dolibarrId)
      const crmRef = typeof body?.dolibarrRef === 'string' ? body.dolibarrRef.trim() : ''
      if (!crmId || crmRef.length > 64) {
        return {
          response: Response.json(
            { erreur: '« dolibarrId » est obligatoire (64 caractères au plus), « dolibarrRef » facultatif.' },
            { status: 400 },
          ),
        }
      }

      const outcome = await markConsumptionSent(id, { id: crmId, ref: crmRef || null })
      if (outcome.result === 'introuvable') {
        return { response: Response.json({ erreur: 'Consommation introuvable.' }, { status: 404 }) }
      }
      if (outcome.result === 'refuse') return { response: Response.json({ erreur: outcome.message }, { status: 409 }) }
      return { response: Response.json({ ok: true }), summary: 'Consommation reprise par le CRM.' }
    },
  )
  return response
}
