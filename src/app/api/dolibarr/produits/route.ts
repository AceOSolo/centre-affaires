import { revalidatePath } from 'next/cache'

import { todayIsoDate } from '../../../../lib/dates.ts'
import { hasBearerOrQueryToken, maintenanceNotFound } from '../../../../lib/maintenance.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { readDolibarrProductEvent } from '../../../../modules/facturation/produits-dolibarr.ts'
import {
  applyDolibarrService,
  applyDolibarrTariff,
} from '../../../../modules/facturation/produits-dolibarr-queries.ts'

/**
 * Produits envoyés par le module Webhook de Dolibarr (ADR 049,
 * `docs/integrations/dolibarr.md`) :
 *
 *   POST /api/dolibarr/produits?jeton=<DOLIBARR_API_TOKEN>
 *   { "triggercode": "PRODUCT_MODIFY", "object": { "ref": "courrier.ouverture", … } }
 *
 * Le jeton passe dans l'adresse, le module ne sachant poser aucun en-tête ;
 * `Authorization: Bearer …` est accepté aussi. Sans jeton valide, la route
 * n'existe pas (404).
 *
 * 200 quand le produit est pris en compte ou n'a rien à faire sur le site,
 * 422 quand l'envoi est illisible (référence, prix, TVA), 409 quand le site
 * n'a pas où le poser (grille par défaut, ressource). Le message dit quoi
 * corriger ; Dolibarr le garde dans l'historique de ses webhooks.
 */
export async function POST(request: Request) {
  if (!hasBearerOrQueryToken(request, process.env.DOLIBARR_API_TOKEN)) return maintenanceNotFound()

  const body: unknown = await request.json().catch(() => null)
  const decision = readDolibarrProductEvent(body)
  if (decision.kind === 'invalid') return Response.json({ erreur: decision.message }, { status: 422 })
  if (decision.kind === 'ignore') return Response.json({ ok: true, resultat: 'ignore', message: decision.reason })

  const outcome =
    decision.kind === 'service'
      ? await applyDolibarrService(decision)
      : await applyDolibarrTariff(decision, todayIsoDate(await currentTimeZone()))
  if (outcome.result === 'refuse') return Response.json({ erreur: outcome.message }, { status: 409 })

  // Les prix et les services se lisent partout : back-office, réservation en
  // ligne, demandes de devis.
  if (outcome.result !== 'inchange') revalidatePath('/', 'layout')
  return Response.json({ ok: true, resultat: outcome.result, message: outcome.message })
}
