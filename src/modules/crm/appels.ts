import { maintenanceNotFound } from '../../lib/maintenance.ts'
import { currentTenantId, runForTenant } from '../../lib/tenant.ts'
import { resolveCrmAccess, type CrmAccess, type CrmAccessStore } from './acces.ts'
import { crmConnectors } from './catalogue.ts'
import type { CrmConnectorId } from './connecteurs.ts'
import { crmFlowDefinitions, type CrmFlowId } from './flux.ts'
import { presentedTokens } from './jeton.ts'
import { crmAccessStore, recordCrmExchange, type CrmExchangeEntry } from './queries.ts'

/**
 * La porte commune des routes qu'un CRM appelle (ADR 065) : `/api/dolibarr/*`
 * aujourd'hui, les flux de la seconde tranche demain.
 *
 * Une route écrit son travail ; `serveCrmCall` fait le reste, pareil pour
 * toutes :
 *
 * 1. trouve le centre du jeton présenté (`acces.ts`) — sans jeton valide, la
 *    route n'existe pas (404), comme avant l'écran ;
 * 2. refuse un flux coupé à l'écran pour ce centre ;
 * 3. sert l'appel **pour ce centre** (`runForTenant`) ;
 * 4. l'inscrit au journal du centre (`crm_exchanges`).
 *
 * Brancher un flux du lot 10 : une route qui appelle
 * `serveCrmCall(request, { connector, flow: 'third_parties', operation }, …)`,
 * puis le flux ajouté à `flows` dans le connecteur (`dolibarr.ts`). L'écran,
 * le jeton, le journal et l'activation suivent sans autre code.
 */

export type CrmCall = {
  connector: CrmConnectorId
  flow: CrmFlowId
  /** Libellé au journal : « GET /api/dolibarr/devis ». Jamais d'identifiant ni de donnée. */
  operation: string
  /** Le jeton peut-il venir de l'adresse (`?jeton=`) ? Seulement pour le module Webhook (ADR 049). */
  acceptQueryToken?: boolean
  /**
   * Code d'un flux coupé : 403 par défaut ; 400 pour le module Webhook de
   * Dolibarr, qui ne garde le message du site que pour un 400 (ADR 049, 052).
   */
  flowOffStatus?: 400 | 403
}

/** Ce que rend le travail d'une route : sa réponse et, en cas de succès, une phrase pour le journal. */
export type CrmHandled = { response: Response; summary?: string }

/** Ce dont la porte a besoin : réglages, journal, jeton du serveur. Remplaçable dans les tests. */
export type CrmGateway = {
  store: CrmAccessStore
  record(tenantId: string, entry: CrmExchangeEntry): Promise<void>
  /** Jeton du serveur de ce CRM (`legacyTokenEnv`), s'il est posé. */
  serverToken(connector: CrmConnectorId): string | undefined
  /** Centre pour lequel vaut le jeton du serveur : le centre unique. */
  serverTenantId(): string
}

export const crmGateway: CrmGateway = {
  store: crmAccessStore,
  record: recordCrmExchange,
  serverToken(connector) {
    const name = crmConnectors[connector].legacyTokenEnv
    return name ? process.env[name] || undefined : undefined
  },
  // Lu hors de tout appel : le centre unique (`lib/tenant.ts`).
  serverTenantId: () => currentTenantId(),
}

export type CrmServed<T extends CrmHandled> = {
  response: Response
  access: CrmAccess
  /** Ce qu'a rendu le travail de la route, s'il a été fait. */
  handled?: T
}

/** Message d'un flux coupé, rendu au CRM et inscrit au journal. */
export function flowOffMessage(flow: CrmFlowId): string {
  return `Flux « ${crmFlowDefinitions[flow].label} » désactivé dans les réglages du centre (Réglages > Connexion au CRM).`
}

export async function serveCrmCall<T extends CrmHandled>(
  request: Request,
  call: CrmCall,
  handle: () => Promise<T>,
  gateway: CrmGateway = crmGateway,
): Promise<CrmServed<T>> {
  const start = performance.now()
  const access = await resolveCrmAccess(
    presentedTokens(request, call.acceptQueryToken),
    call,
    gateway.store,
    { token: gateway.serverToken(call.connector), tenantId: gateway.serverTenantId() },
  )
  if (access.result === 'unknown') return { response: maintenanceNotFound(), access }

  const entry = (statusCode: number, message: string | null): CrmExchangeEntry => ({
    connector: call.connector,
    direction: 'inbound',
    flow: call.flow,
    operation: call.operation,
    statusCode,
    ok: statusCode < 400,
    message,
    credential: access.credential,
    durationMs: performance.now() - start,
  })

  if (access.result === 'flow_off') {
    const message = flowOffMessage(call.flow)
    const status = call.flowOffStatus ?? 403
    await gateway.record(access.tenantId, entry(status, message))
    return { response: Response.json({ erreur: message }, { status }), access }
  }

  let handled: T
  try {
    handled = await runForTenant(access.tenantId, handle)
  } catch (error) {
    await gateway.record(access.tenantId, entry(500, 'Erreur du site.'))
    throw error
  }
  const { status } = handled.response
  const message = status >= 400 ? await errorMessage(handled.response) : (handled.summary ?? null)
  await gateway.record(access.tenantId, entry(status, message))
  return { response: handled.response, access, handled }
}

/** Le message d'erreur que la route a rendu au CRM (`{ "erreur": "…" }`), sans consommer la réponse. */
async function errorMessage(response: Response): Promise<string | null> {
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { erreur?: unknown } | null
  return typeof body?.erreur === 'string' ? body.erreur : null
}
