import type { CrmConnectorId } from './connecteurs.ts'
import { defaultEnabledFlows, type CrmFlowId } from './flux.ts'
import { crmTokenHash, sameHash, sameSecret } from './jeton.ts'

/**
 * Qui appelle l'API du site, et pour quel centre (ADR 065).
 *
 * Deux jetons ouvrent les routes d'un CRM :
 *
 * - **le jeton réglé à l'écran** « Connexion au CRM » : il désigne son centre.
 *   C'est lui qui prépare le multi-centres — chaque centre remet le sien à son
 *   CRM, et l'appel est servi pour ce centre seulement ;
 * - **le jeton du serveur** (`DOLIBARR_API_TOKEN`), celui d'avant l'écran : il
 *   vaut pour le centre unique, **tant qu'aucun jeton n'y est réglé à
 *   l'écran**. La production en dépend ; générer un jeton à l'écran le remplace.
 *
 * Puis le flux doit être activé pour ce centre. Sans réglage, les flux qui
 * tournaient avant l'écran le restent (`defaultEnabledFlows`).
 *
 * Module sans base : la lecture des réglages arrive par `store`, ce qui laisse
 * éprouver la règle seule (`acces.test.ts`) ; `queries.ts` en donne la version
 * en base.
 */

/** Ce que l'accès lit du réglage d'un centre. Jamais la clé d'appel du CRM. */
export type CrmInboundSettings = {
  tenantId: string
  connector: CrmConnectorId
  /** Empreinte du jeton réglé à l'écran, nulle s'il n'y en a pas. */
  tokenHash: string | null
  enabledFlows: readonly CrmFlowId[]
}

export type CrmAccessStore = {
  /** Réglage dont le jeton d'écran a cette empreinte, quel que soit le centre. */
  byTokenHash(hash: string): Promise<CrmInboundSettings | undefined>
  /** Réglage d'un centre, s'il en a un. */
  forTenant(tenantId: string): Promise<CrmInboundSettings | undefined>
}

/** Jeton qui a ouvert l'appel : celui de l'écran ou celui du serveur. */
export type CrmCredential = 'screen' | 'server'

export type CrmAccess =
  /** Jeton absent, faux, remplacé, ou d'un autre CRM : la route n'existe pas. */
  | { result: 'unknown' }
  /** Jeton valide, flux coupé à l'écran pour ce centre. */
  | { result: 'flow_off'; tenantId: string; credential: CrmCredential }
  | { result: 'ok'; tenantId: string; credential: CrmCredential }

export async function resolveCrmAccess(
  tokens: readonly string[],
  call: { connector: CrmConnectorId; flow: CrmFlowId },
  store: CrmAccessStore,
  server: {
    /** Valeur de la variable du serveur (`legacyTokenEnv` du connecteur), si elle est posée. */
    token: string | undefined
    /** Centre pour lequel elle vaut : le centre unique. */
    tenantId: string
  },
): Promise<CrmAccess> {
  for (const token of tokens) {
    const found = (await fromScreen(token, call.connector, store)) ?? (await fromServer(token, call.connector, store, server))
    if (!found) continue
    const { settings, tenantId, credential } = found
    const flows = settings?.enabledFlows ?? defaultEnabledFlows
    return flows.includes(call.flow)
      ? { result: 'ok', tenantId, credential }
      : { result: 'flow_off', tenantId, credential }
  }
  return { result: 'unknown' }
}

type Found = { settings: CrmInboundSettings | undefined; tenantId: string; credential: CrmCredential }

async function fromScreen(token: string, connector: CrmConnectorId, store: CrmAccessStore): Promise<Found | undefined> {
  const hash = crmTokenHash(token)
  const settings = await store.byTokenHash(hash)
  // L'empreinte est relue et comparée à temps constant : la recherche par
  // index ne fait pas foi à elle seule.
  if (!settings?.tokenHash || !sameHash(hash, settings.tokenHash)) return undefined
  // Un jeton réglé pour un autre CRM n'ouvre pas les routes de celui-ci.
  if (settings.connector !== connector) return undefined
  return { settings, tenantId: settings.tenantId, credential: 'screen' }
}

async function fromServer(
  token: string,
  connector: CrmConnectorId,
  store: CrmAccessStore,
  server: { token: string | undefined; tenantId: string },
): Promise<Found | undefined> {
  if (!server.token || !sameSecret(token, server.token)) return undefined
  const settings = await store.forTenant(server.tenantId)
  // Un jeton réglé à l'écran remplace celui du serveur : l'ancien cesse
  // aussitôt, comme un jeton renouvelé.
  if (settings?.tokenHash) return undefined
  if (settings && settings.connector !== connector) return undefined
  return { settings, tenantId: server.tenantId, credential: 'server' }
}
