import { revalidatePath } from 'next/cache'

import { hasBearerToken, maintenanceNotFound } from '../../../../../../lib/maintenance.ts'
import { isUuid } from '../../../../../../lib/uuid.ts'
import { recordProposalOutcome } from '../../../../../../modules/facturation/propositions-queries.ts'

/**
 * Issue d'un devis transmis, rapportée par Dolibarr (ADR 043) :
 *
 *   POST /api/dolibarr/devis/{id}/issue
 *   { "issue": "signe" }     ou     { "issue": "refuse" }
 *
 * Rejouable. 409 si le devis n'a pas été transmis, ou a déjà l'autre issue.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!hasBearerToken(request, process.env.DOLIBARR_API_TOKEN)) return maintenanceNotFound()
  const { id } = await params
  if (!isUuid(id)) return Response.json({ erreur: 'Devis introuvable.' }, { status: 404 })

  const body = (await request.json().catch(() => null)) as { issue?: unknown } | null
  const outcome = body?.issue === 'signe' ? 'accepted' : body?.issue === 'refuse' ? 'refused' : undefined
  if (!outcome) return Response.json({ erreur: '« issue » vaut « signe » ou « refuse ».' }, { status: 400 })

  const result = await recordProposalOutcome(id, outcome)
  if (result.result === 'introuvable') return Response.json({ erreur: 'Devis introuvable.' }, { status: 404 })
  if (result.result === 'refuse') return Response.json({ erreur: result.message }, { status: 409 })
  revalidatePath('/devis')
  return Response.json({ ok: true })
}
