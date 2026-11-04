import type { CrmConnector, CrmConnectorId } from './connecteurs.ts'
import { dolibarrConnector } from './dolibarr.ts'

/**
 * Les CRM branchables (ADR 065). Brancher un autre CRM : un fichier comme
 * `dolibarr.ts`, une ligne ici, sa valeur dans `crmConnectorIds`
 * (`connecteurs.ts`, qui change l'énumération en base : une migration), et
 * ses routes `/api/<crm>/*` servies par `serveCrmCall` (`appels.ts`).
 *
 * Le `Record` fait vérifier par le compilateur qu'aucun identifiant n'est
 * oublié.
 */
export const crmConnectors: Record<CrmConnectorId, CrmConnector> = {
  dolibarr: dolibarrConnector,
}
