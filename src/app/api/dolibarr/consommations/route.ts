import { currentTimeZone } from '../../../../lib/tenant.ts'
import { serveCrmCall } from '../../../../modules/crm/appels.ts'
import { toDolibarrConsumption } from '../../../../modules/crm/consommations.ts'
import { listConsumptionsForCrm, syncConsumptions } from '../../../../modules/crm/consommations-queries.ts'
import { readListParams } from '../../../../modules/crm/parametres-api.ts'
import { consumptionStatuses, type ConsumptionStatus } from '../../../../modules/crm/schema-consommations.ts'

/**
 * Consommations facturables à reprendre par Dolibarr (ADR 066,
 * `docs/integrations/dolibarr.md`). Le site ne facture rien : Dolibarr vient
 * les chercher, les facture, puis en accuse réception (`…/{id}/transmis`).
 *
 *   GET /api/dolibarr/consommations                    prêtes, les plus anciennes d'abord
 *   GET /api/dolibarr/consommations?statut=cancelled&depuis=2026-11-01T00:00:00Z
 *                                                      annulées depuis cette date
 *
 * Chaque appel met d'abord le registre à jour (`syncConsumptions`) : ce qui est
 * devenu prêt y entre, ce dont la source a changé est annulé. Rejouable.
 *
 * Jeton en `Authorization: Bearer …` (ADR 065). Sans jeton valide, 404 ; flux
 * « Consommations facturables » coupé à l'écran, 403.
 */
export async function GET(request: Request) {
  const { response } = await serveCrmCall(
    request,
    { connector: 'dolibarr', flow: 'consumptions', operation: 'GET /api/dolibarr/consommations' },
    async () => {
      const url = new URL(request.url)
      const status = (url.searchParams.get('statut') ?? 'ready') as ConsumptionStatus
      if (!consumptionStatuses.includes(status)) {
        return {
          response: Response.json(
            { erreur: `Statut inconnu. Valeurs admises : ${consumptionStatuses.join(', ')}.` },
            { status: 400 },
          ),
        }
      }
      const read = readListParams(url.searchParams, { since: true })
      if (!read.ok) return { response: Response.json({ erreur: read.message }, { status: 400 }) }

      const sync = await syncConsumptions()
      const [rows, timeZone] = await Promise.all([
        listConsumptionsForCrm('dolibarr', { status, since: read.params.since, limit: read.params.limit }),
        currentTimeZone(),
      ])
      const notes = [
        sync.created ? `${sync.created} prise(s)` : null,
        sync.cancelled ? `${sync.cancelled} annulée(s)` : null,
        sync.waitingPostage ? `${sync.waitingPostage} réexpédition(s) sans frais relevés` : null,
        sync.started ? null : 'aucune date de départ réglée',
      ].filter(Boolean)
      return {
        response: Response.json({
          consommations: rows.map((row) => toDolibarrConsumption(row, timeZone)),
          depuisLe: sync.from,
          enAttente: { reexpeditionsSansFrais: sync.waitingPostage },
        }),
        summary: `${rows.length} consommation(s) au statut « ${status} »${notes.length ? ` (${notes.join(', ')})` : ''}.`,
      }
    },
  )
  return response
}
