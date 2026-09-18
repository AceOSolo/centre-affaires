import { cache } from 'react'

import { eq } from 'drizzle-orm'

import { withTenant } from '../db/index.ts'
import { DEFAULT_TENANT_ID, tenants, type Tenant } from '../db/tenants.ts'

/**
 * Centre courant.
 *
 * Tant que l'authentification n'est pas posée, le produit est mono-centre et
 * tout passe par le centre unique. Ce module est le seul endroit à reprendre le
 * jour où le centre viendra de la session : aucune page, aucune action ne cite
 * `DEFAULT_TENANT_ID` directement.
 */
export function currentTenantId(): string {
  return DEFAULT_TENANT_ID
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
      "Le centre unique est absent de la base. Appliquer les migrations : `npx drizzle-kit migrate`.",
    )
  }
  return tenant
})

/** Fuseau d'affichage du centre. La base, elle, reste en UTC (décision 4). */
export async function currentTimeZone(): Promise<string> {
  return (await currentTenant()).timezone
}
