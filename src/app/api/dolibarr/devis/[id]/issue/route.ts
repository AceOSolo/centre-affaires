import { revalidatePath } from 'next/cache'

import { isUuid } from '../../../../../../lib/uuid.ts'
import { serveCrmCall } from '../../../../../../modules/crm/appels.ts'
import { recordProposalOutcome } from '../../../../../../modules/facturation/propositions-queries.ts'

/**
 * Issue d'un devis transmis, rapportée par Dolibarr (ADR 043) :
 *
 *   POST /api/dolibarr/devis/{id}/issue
 *   { "issue": "signe" }     ou     { "issue": "refuse" }
 *
 * Rejouable. 409 si le devis n'a pas été transmis, ou a déjà l'autre issue.
 * Jeton et flux : `serveCrmCall` (ADR 065).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { response, handled } = await serveCrmCall(
    request,
    { connector: 'dolibarr', flow: 'quotes', operation: 'POST /api/dolibarr/devis/{id}/issue' },
    async () => {
      const { id } = await params
      if (!isUuid(id)) return { response: Response.json({ erreur: 'Devis introuvable.' }, { status: 404 }) }

      const body = (await request.json().catch(() => null)) as { issue?: unknown } | null
      const outcome = body?.issue === 'signe' ? 'accepted' : body?.issue === 'refuse' ? 'refused' : undefined
      if (!outcome) {
        return { response: Response.json({ erreur: '« issue » vaut « signe » ou « refuse ».' }, { status: 400 }) }
      }

      const result = await recordProposalOutcome(id, outcome)
      if (result.result === 'introuvable') {
        return { response: Response.json({ erreur: 'Devis introuvable.' }, { status: 404 }) }
      }
      if (result.result === 'refuse') return { response: Response.json({ erreur: result.message }, { status: 409 }) }
      return {
        response: Response.json({ ok: true }),
        summary: outcome === 'accepted' ? 'Devis signé dans le CRM.' : 'Devis refusé dans le CRM.',
        revalidate: true,
      }
    },
  )
  if (handled?.revalidate) revalidatePath('/devis')
  return response
}
