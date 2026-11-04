import { revalidatePath } from 'next/cache'

import { isUuid } from '../../../../../../lib/uuid.ts'
import { serveCrmCall } from '../../../../../../modules/crm/appels.ts'
import { markProposalSent } from '../../../../../../modules/facturation/propositions-queries.ts'

/**
 * Dolibarr a repris le devis (ADR 043) :
 *
 *   POST /api/dolibarr/devis/{id}/transmis
 *   { "dolibarrId": "412", "dolibarrRef": "PR2611-0007" }
 *
 * Rejouable : le même appel une seconde fois répond 200 sans rien changer.
 * 409 si le devis n'est plus « prêt » (annulé, ou repris sous un autre
 * identifiant). Jeton et flux : `serveCrmCall` (ADR 065).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { response, handled } = await serveCrmCall(
    request,
    { connector: 'dolibarr', flow: 'quotes', operation: 'POST /api/dolibarr/devis/{id}/transmis' },
    async () => {
      const { id } = await params
      if (!isUuid(id)) return { response: Response.json({ erreur: 'Devis introuvable.' }, { status: 404 }) }

      const body = (await request.json().catch(() => null)) as { dolibarrId?: unknown; dolibarrRef?: unknown } | null
      const dolibarrId =
        typeof body?.dolibarrId === 'string' || typeof body?.dolibarrId === 'number' ? String(body.dolibarrId).trim() : ''
      const dolibarrRef = typeof body?.dolibarrRef === 'string' ? body.dolibarrRef.trim() : ''
      if (!dolibarrId || dolibarrId.length > 64 || dolibarrRef.length > 64) {
        return {
          response: Response.json(
            { erreur: '« dolibarrId » est obligatoire (64 caractères au plus), « dolibarrRef » facultatif.' },
            { status: 400 },
          ),
        }
      }

      const outcome = await markProposalSent(id, { id: dolibarrId, ref: dolibarrRef || null })
      if (outcome.result === 'introuvable') {
        return { response: Response.json({ erreur: 'Devis introuvable.' }, { status: 404 }) }
      }
      if (outcome.result === 'refuse') return { response: Response.json({ erreur: outcome.message }, { status: 409 }) }
      return { response: Response.json({ ok: true }), summary: 'Devis repris par le CRM.', revalidate: true }
    },
  )
  if (handled?.revalidate) revalidatePath('/devis')
  return response
}
