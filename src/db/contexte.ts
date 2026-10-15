/**
 * Centre du contexte courant, posé par `withTenant()` pour la durée de sa
 * transaction.
 *
 * MySQL n'a pas de Row Level Security ni de valeur par défaut qui lise une
 * variable de session : la valeur par défaut de `tenant_id` est donc calculée
 * côté application, à partir de ce contexte (voir `tenantId()` dans
 * `tenants.ts`). Même effet que l'ancienne fonction `tenant_id_default()`.
 *
 * `AsyncLocalStorage` vient de `node:async_hooks`, obtenu par
 * `process.getBuiltinModule` et non par un `import` : les fichiers de schéma
 * (donc ce module) sont aussi importés, pour leurs listes de valeurs, par des
 * composants client, et le bundler du navigateur refuse un import `node:`.
 * Côté navigateur il n'y a pas de contexte de centre : `getStore()` rend
 * `undefined`, et la valeur par défaut de la colonne n'y sert jamais.
 */
type Storage = {
  run<T>(tenantId: string, run: () => T): T
  getStore(): string | undefined
}

function create(): Storage {
  const builtin =
    typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function'
      ? process.getBuiltinModule('node:async_hooks')
      : undefined
  if (!builtin) {
    return { run: (_tenantId, run) => run(), getStore: () => undefined }
  }
  const als = new builtin.AsyncLocalStorage<string>()
  return { run: (tenantId, run) => als.run(tenantId, run), getStore: () => als.getStore() }
}

export const tenantContext: Storage = create()
