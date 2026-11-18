import { crmGateway, serveCrmCall, type CrmGateway } from '../../../../modules/crm/appels.ts'
import { readCrmInvoice } from '../../../../modules/crm/factures.ts'
import { receiveCrmInvoice } from '../../../../modules/crm/factures-queries.ts'

/**
 * Factures émises par Dolibarr (ADR 081, `docs/integrations/dolibarr.md`),
 * sans Next : les tests appellent cette fonction telle que la route l'appelle.
 *
 * Jeton, centre, flux « Factures » et journal des échanges : `serveCrmCall`
 * (ADR 065). Sans jeton valide, 404 ; flux coupé à l'écran, 403.
 */
export async function receiveFacture(
  request: Request,
  gateway: CrmGateway = crmGateway,
): Promise<{ response: Response; changed: boolean }> {
  const served = await serveCrmCall(
    request,
    { connector: 'dolibarr', flow: 'invoices', operation: 'POST /api/dolibarr/factures' },
    async () => {
      const read = readCrmInvoice(await request.json().catch(() => null))
      if (!read.ok) return { response: Response.json({ erreur: read.message }, { status: 400 }), changed: false }
      const outcome = await receiveCrmInvoice('dolibarr', read.value)
      if (outcome.result === 'refuse') {
        return { response: Response.json({ erreur: outcome.message }, { status: outcome.status }), changed: false }
      }
      return {
        response: Response.json({
          ok: true,
          resultat: outcome.result,
          factureId: outcome.invoiceId,
          message: outcome.message,
        }),
        // L'identifiant Dolibarr seulement : ni numéro, ni montant, ni tiers au journal.
        summary: `Facture ${read.value.crmId} : ${outcome.message}`,
        changed: outcome.result !== 'inchange' && outcome.result !== 'ignore',
      }
    },
    gateway,
  )
  return { response: served.response, changed: served.handled?.changed ?? false }
}
