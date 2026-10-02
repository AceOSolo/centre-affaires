import { cache } from 'react'

import { redirect } from 'next/navigation'

import { withTenant } from '../../db/index.ts'
import type { StaffMember } from '../../db/staff.ts'
import { resolveStaffMember, type AuthenticatedUser } from './membre.ts'
import { currentTenantId } from '../tenant.ts'
import { sessionUser } from './session.ts'

/**
 * Du compte connecté au membre de l'équipe (ADR 008).
 *
 * Neon Auth répond « qui est-ce ». Cette couche répond « est-ce quelqu'un de
 * chez nous », et c'est elle qui protège le back-office : le relais
 * `/api/auth` expose l'inscription, donc l'existence d'un compte ne prouve
 * rien.
 */
export type StaffAccess =
  | { status: 'anonyme' }
  | { status: 'refuse'; user: AuthenticatedUser }
  | { status: 'membre'; user: AuthenticatedUser; member: StaffMember }

/**
 * `cache` mémorise le résultat pour la durée d'une requête HTTP : la coque, la
 * page et l'action qu'elle déclenche interrogent la même session une fois.
 */
export const staffAccess = cache(async (): Promise<StaffAccess> => {
  const session = await sessionUser()
  if (!session) return { status: 'anonyme' }
  const { user, emailVerified } = session

  const member = await withTenant(currentTenantId(), (tx) =>
    resolveStaffMember(tx, user, { emailVerified }),
  )

  return member ? { status: 'membre', user, member } : { status: 'refuse', user }
})


/**
 * Porte d'entrée du back-office : à appeler dans chaque page et **dans chaque
 * action serveur** qui écrit.
 *
 * La protection par `proxy.ts` ne suffit pas : une action serveur s'invoque par
 * son identifiant, depuis n'importe quel chemin — y compris une page publique
 * que le filtre laisse passer. Le contrôle doit donc vivre dans l'action
 * elle-même.
 */
export async function requireStaff(): Promise<{
  user: AuthenticatedUser
  member: StaffMember
}> {
  const access = await staffAccess()
  if (access.status === 'membre') return access
  redirect(access.status === 'refuse' ? '/auth/acces-refuse' : '/auth/connexion')
}

/** Réservé aux actions d'administration de l'équipe. */
export async function requireAdmin() {
  const staff = await requireStaff()
  if (staff.member.role !== 'admin') redirect('/auth/acces-refuse')
  return staff
}

export { resolveStaffMember, type AuthenticatedUser }
