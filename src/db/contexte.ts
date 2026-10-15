import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Centre du contexte courant, posé par `withTenant()` pour la durée de sa
 * transaction.
 *
 * MySQL n'a pas de Row Level Security ni de valeur par défaut qui lise une
 * variable de session : la valeur par défaut de `tenant_id` est donc calculée
 * côté application, à partir de ce contexte (voir `tenantId()` dans
 * `tenants.ts`). Même effet que l'ancienne fonction `tenant_id_default()`.
 */
export const tenantContext = new AsyncLocalStorage<string>()
