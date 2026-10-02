import { cache } from 'react'

import { redirect } from 'next/navigation'

import { withTenant } from '../../db/index.ts'
import type { AuthenticatedUser } from '../../lib/auth/membre.ts'
import { sessionUser } from '../../lib/auth/session.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { resolveClientAccounts, type ClientAccount } from './comptes.ts'

/**
 * Du compte connecté aux entreprises dont il relève (ADR 015).
 *
 * Pendant de `lib/auth/staff.ts` pour l'espace client.
 */
export type ClientAccess =
  | { status: 'anonyme' }
  | { status: 'refuse'; user: AuthenticatedUser }
  | { status: 'client'; user: AuthenticatedUser; accounts: ClientAccount[] }

export const clientAccess = cache(async (): Promise<ClientAccess> => {
  const session = await sessionUser()
  if (!session) return { status: 'anonyme' }
  const { user, emailVerified } = session

  const accounts = await withTenant(currentTenantId(), (tx) =>
    resolveClientAccounts(tx, user, { emailVerified }),
  )
  return accounts.length > 0 ? { status: 'client', user, accounts } : { status: 'refuse', user }
})

/**
 * Porte d'entrée de l'espace client : à appeler dans chaque page, chaque route
 * et **chaque action serveur** — même raison que `requireStaff()`, une action
 * s'invoque depuis n'importe quel chemin (ADR 008).
 */
export async function requireClientAccount(): Promise<{
  user: AuthenticatedUser
  accounts: ClientAccount[]
}> {
  const access = await clientAccess()
  if (access.status === 'client') return access
  redirect(access.status === 'refuse' ? '/auth/acces-refuse' : '/auth/connexion?redirect=/compte')
}
