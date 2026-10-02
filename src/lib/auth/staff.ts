import { cache } from 'react'

import { redirect } from 'next/navigation'

import { withTenant } from '../../db/index.ts'
import type { StaffMember } from '../../db/staff.ts'
import { resolveStaffMember, type AuthenticatedUser } from './membre.ts'
import { can, type Permission } from './permissions.ts'
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
 * Porte d'entrée du back-office : un membre de l'équipe, quel que soit son
 * rôle. La coque l'appelle ; les pages, les routes et **chaque action
 * serveur** appellent `requirePermission()`, qui la contient.
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

/**
 * Garde unique du back-office (R27, ADR 019) : un membre de l'équipe **dont le
 * rôle permet ce droit** (`permissions.ts`). À appeler en tête de chaque page,
 * route et action serveur, à la place de `requireStaff()`.
 *
 * Sans session ou sans membre, même issue que `requireStaff()`. Un membre dont
 * le rôle ne suffit pas est renvoyé vers `/acces-reserve`, dans la coque du
 * back-office, qui lui dit à qui s'adresser.
 */
export async function requirePermission(permission: Permission): Promise<{
  user: AuthenticatedUser
  member: StaffMember
}> {
  const staff = await requireStaff()
  if (!can(staff.member.role, permission)) redirect(`/acces-reserve?droit=${permission}`)
  return staff
}

/**
 * @deprecated Remplacée par `requirePermission('equipe.gerer')` ou le droit
 * précis de l'action (ADR 019). Gardée le temps que tout appel ait migré.
 */
export async function requireAdmin() {
  return requirePermission('equipe.gerer')
}

export { resolveStaffMember, type AuthenticatedUser }
