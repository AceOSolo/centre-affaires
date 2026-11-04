import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { CrmInboundSettings } from './acces.ts'
import type { CrmGateway } from './appels.ts'
import type { CrmExchangeEntry } from './queries.ts'

/**
 * Une porte des routes du CRM sans base, pour les tests qui éprouvent ce qui
 * se décide avant elle (`appels.test.ts`, webhook des produits) : réglages en
 * mémoire, journal en tableau. La version en base est éprouvée par
 * `crm.db.test.ts` et `api/dolibarr/acces.db.test.ts`.
 */
export function passerelleDeTest(options: {
  /** Valeur de `DOLIBARR_API_TOKEN`, lue à chaque appel si c'est une fonction. */
  serveur?: string | (() => string | undefined)
  reglages?: CrmInboundSettings[]
} = {}): CrmGateway & { journal: { tenantId: string; entry: CrmExchangeEntry }[] } {
  const reglages = options.reglages ?? []
  const journal: { tenantId: string; entry: CrmExchangeEntry }[] = []
  return {
    journal,
    store: {
      byTokenHash: async (hash) => reglages.find((r) => r.tokenHash === hash),
      forTenant: async (tenantId) => reglages.find((r) => r.tenantId === tenantId),
    },
    record: async (tenantId, entry) => {
      journal.push({ tenantId, entry })
    },
    serverToken: () => (typeof options.serveur === 'function' ? options.serveur() : options.serveur),
    serverTenantId: () => DEFAULT_TENANT_ID,
  }
}
