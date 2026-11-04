import { AsyncLocalStorage } from 'node:async_hooks'
import { cache } from 'react'

import { eq } from 'drizzle-orm'

import { withTenant } from '../db/index.ts'
import { DEFAULT_TENANT_ID, tenants, type Tenant } from '../db/tenants.ts'
import { isUuid } from './uuid.ts'

/**
 * Centre désigné par l'appelant d'une API, le temps de son appel : le jeton
 * d'un CRM désigne son centre (ADR 065, `modules/crm/appels.ts`).
 */
const callerTenant = new AsyncLocalStorage<string>()

/**
 * Centre courant.
 *
 * Tant que l'authentification n'est pas posée, le produit est mono-centre et
 * tout passe par le centre unique. Ce module est le seul endroit à reprendre le
 * jour où le centre viendra de la session : aucune page, aucune action ne cite
 * `DEFAULT_TENANT_ID` directement.
 *
 * Une API appelée par un CRM est servie pour le centre de son jeton
 * (`runForTenant`) : c'est la première porte qui ne passe pas par le centre
 * unique.
 */
export function currentTenantId(): string {
  return callerTenant.getStore() ?? DEFAULT_TENANT_ID
}

/**
 * Exécute `run` pour un centre désigné par l'appelant : tout ce qui lit
 * `currentTenantId()` pendant l'appel — requêtes, fuseau, devise — le sert.
 */
export function runForTenant<T>(tenantId: string, run: () => T): T {
  if (!isUuid(tenantId)) throw new Error('Centre invalide : identifiant mal formé.')
  return callerTenant.run(tenantId, run)
}

/**
 * Le centre et ses réglages d'affichage — fuseau, devise.
 *
 * `cache` mémorise le résultat pour la durée d'une requête HTTP : une page qui
 * affiche un planning et une barre de navigation ne l'interroge qu'une fois.
 */
export const currentTenant = cache(async (): Promise<Tenant> => {
  const tenantId = currentTenantId()
  const [tenant] = await withTenant(tenantId, (tx) =>
    tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1),
  )
  if (!tenant) {
    throw new Error(
      "Le centre unique est absent de la base. Appliquer les migrations et les règles : `infra/migrer.ts`.",
    )
  }
  return tenant
})

/** Fuseau d'affichage du centre. La base, elle, reste en UTC (décision 4). */
export async function currentTimeZone(): Promise<string> {
  return (await currentTenant()).timezone
}
