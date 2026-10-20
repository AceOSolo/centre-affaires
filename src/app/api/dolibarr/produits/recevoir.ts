import { todayIsoDate } from '../../../../lib/dates.ts'
import { hasBearerOrQueryToken, maintenanceNotFound } from '../../../../lib/maintenance.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { readDolibarrProductEvent } from '../../../../modules/facturation/produits-dolibarr.ts'
import {
  applyDolibarrService,
  applyDolibarrTariff,
} from '../../../../modules/facturation/produits-dolibarr-queries.ts'

/**
 * Réception d'un envoi du module Webhook de Dolibarr (ADR 049,
 * `docs/integrations/dolibarr-produits.md`), sans Next : les tests l'éprouvent
 * telle que la route l'appelle, et la route n'y ajoute que le rafraîchissement
 * des pages.
 *
 * Réponses : 200 quand le produit est pris en compte ou n'a rien à faire sur le
 * site ; 400 quand l'envoi est illisible (référence, prix, TVA) ou que le site
 * n'a pas où le poser (grille par défaut, ressource) — 400 et pas 422 ou 409,
 * parce que Dolibarr (version 23 et suivantes) ne garde le message du site que
 * pour un 400 ; 404 sans jeton valide ; 500 sur une panne du site.
 *
 * Chaque appel laisse une ligne dans le journal du serveur
 * (`docker compose logs app`) : avant Dolibarr 23, c'est le seul endroit où
 * lire pourquoi un produit a été refusé.
 */

export type Reception = {
  response: Response
  /** Vrai si un service ou un prix a changé : les pages qui les affichent sont à rafraîchir. */
  changed: boolean
}

export async function receiveDolibarrProduct(request: Request): Promise<Reception> {
  const start = performance.now()
  const log = (body: unknown, status: number, outcome: string) =>
    webhookLogLine({ body, status, outcome, durationMs: performance.now() - start })

  if (!hasBearerOrQueryToken(request, process.env.DOLIBARR_API_TOKEN)) {
    // Le corps n'est pas lu : rien de ce qu'envoie un inconnu n'entre au journal.
    console.warn(log(undefined, 404, 'jeton absent ou faux'))
    return { response: maintenanceNotFound(), changed: false }
  }

  const body: unknown = await request.json().catch(() => null)
  const refuse = (message: string): Reception => {
    console.warn(log(body, 400, message))
    return { response: Response.json({ erreur: message }, { status: 400 }), changed: false }
  }

  try {
    const decision = readDolibarrProductEvent(body)
    if (decision.kind === 'invalid') return refuse(decision.message)
    if (decision.kind === 'ignore') {
      console.info(log(body, 200, 'ignore'))
      return { response: Response.json({ ok: true, resultat: 'ignore', message: decision.reason }), changed: false }
    }

    const outcome =
      decision.kind === 'service'
        ? await applyDolibarrService(decision)
        : await applyDolibarrTariff(decision, todayIsoDate(await currentTimeZone()))
    if (outcome.result === 'refuse') return refuse(outcome.message)

    console.info(log(body, 200, outcome.result))
    return {
      response: Response.json({ ok: true, resultat: outcome.result, message: outcome.message }),
      changed: outcome.result !== 'inchange',
    }
  } catch (error) {
    console.error(log(body, 500, 'erreur du site'), error)
    return {
      response: Response.json(
        { erreur: 'Erreur du site. Enregistrer à nouveau le produit plus tard ; si elle persiste, prévenir le centre.' },
        { status: 500 },
      ),
      changed: false,
    }
  }
}

/** Texte d'un champ reçu, sur une ligne, coupé : il vient de l'extérieur. */
function forLog(value: unknown, max: number): string {
  const raw = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
  // Un retour à la ligne glissé dans une référence inventerait une ligne de journal.
  const flat = raw.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * La ligne de journal d'un appel : déclencheur, référence, code et issue de la
 * réponse, durée. Jamais le jeton — il est dans l'adresse, que la ligne ne
 * cite pas — ni le corps de l'envoi.
 */
export function webhookLogLine(call: { body: unknown; status: number; outcome: string; durationMs: number }): string {
  const envelope = (typeof call.body === 'object' && call.body !== null ? call.body : {}) as {
    triggercode?: unknown
    object?: unknown
  }
  const product = (typeof envelope.object === 'object' && envelope.object !== null ? envelope.object : {}) as {
    ref?: unknown
  }
  const trigger = forLog(envelope.triggercode, 40)
  const ref = forLog(product.ref, 100)
  const subject = [trigger, ref && `« ${ref} »`].filter(Boolean).join(' ')
  return (
    `Webhook Dolibarr, produits : ${subject ? `${subject} ` : ''}→ ${call.status} ` +
    `${forLog(call.outcome, 300)} (${Math.round(call.durationMs)} ms)`
  )
}
