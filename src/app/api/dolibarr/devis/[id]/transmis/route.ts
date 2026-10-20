import { revalidatePath } from 'next/cache'

import { hasBearerToken, maintenanceNotFound } from '../../../../../../lib/maintenance.ts'
import { isUuid } from '../../../../../../lib/uuid.ts'
import { markProposalSent } from '../../../../../../modules/facturation/propositions-queries.ts'

/**
 * Dolibarr a repris le devis (ADR 043) :
 *
 *   POST /api/dolibarr/devis/{id}/transmis
 *   { "dolibarrId": "412", "dolibarrRef": "PR2611-0007" }
 *
 * Rejouable : le même appel une seconde fois répond 200 sans rien changer.
 * 409 si le devis n'est plus « prêt » (annulé, ou repris sous un autre
 * identifiant).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!hasBearerToken(request, process.env.DOLIBARR_API_TOKEN)) return maintenanceNotFound()
  const { id } = await params
  if (!isUuid(id)) return Response.json({ erreur: 'Devis introuvable.' }, { status: 404 })

  const body = (await request.json().catch(() => null)) as { dolibarrId?: unknown; dolibarrRef?: unknown } | null
  const dolibarrId = typeof body?.dolibarrId === 'string' || typeof body?.dolibarrId === 'number' ? String(body.dolibarrId).trim() : ''
  const dolibarrRef = typeof body?.dolibarrRef === 'string' ? body.dolibarrRef.trim() : ''
  if (!dolibarrId || dolibarrId.length > 64 || dolibarrRef.length > 64) {
    return Response.json({ erreur: '« dolibarrId » est obligatoire (64 caractères au plus), « dolibarrRef » facultatif.' }, { status: 400 })
  }

  const outcome = await markProposalSent(id, { id: dolibarrId, ref: dolibarrRef || null })
  if (outcome.result === 'introuvable') return Response.json({ erreur: 'Devis introuvable.' }, { status: 404 })
  if (outcome.result === 'refuse') return Response.json({ erreur: outcome.message }, { status: 409 })
  revalidatePath('/devis')
  return Response.json({ ok: true })
}
