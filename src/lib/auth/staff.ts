import { cache } from 'react'

import { and, eq, isNull } from 'drizzle-orm'
import { redirect } from 'next/navigation'

import { withTenant } from '../../db/index.ts'
import { staffMembers, type StaffMember } from '../../db/staff.ts'
import { currentTenantId } from '../tenant.ts'
import { auth } from './server.ts'

/**
 * Du compte connecté au membre de l'équipe (ADR 008).
 *
 * Neon Auth répond « qui est-ce ». Cette couche répond « est-ce quelqu'un de
 * chez nous », et c'est elle qui protège le back-office : le relais
 * `/api/auth` expose l'inscription, donc l'existence d'un compte ne prouve
 * rien.
 */
export type AuthenticatedUser = {
  id: string
  email: string
  name: string | null
}

export type StaffAccess =
  | { status: 'anonyme' }
  | { status: 'refuse'; user: AuthenticatedUser }
  | { status: 'membre'; user: AuthenticatedUser; member: StaffMember }

/**
 * `cache` mémorise le résultat pour la durée d'une requête HTTP : la coque, la
 * page et l'action qu'elle déclenche interrogent la même session une fois.
 */
export const staffAccess = cache(async (): Promise<StaffAccess> => {
  const { data: session } = await auth.getSession()
  const sessionUser = session?.user as
    | { id?: string; email?: string; name?: string | null; emailVerified?: boolean }
    | undefined

  if (!sessionUser?.id || !sessionUser.email) return { status: 'anonyme' }

  const user: AuthenticatedUser = {
    id: sessionUser.id,
    email: sessionUser.email.trim().toLowerCase(),
    name: sessionUser.name ?? null,
  }

  const member = await withTenant(currentTenantId(), async (tx) => {
    const [linked] = await tx
      .select()
      .from(staffMembers)
      .where(and(eq(staffMembers.authUserId, user.id), isNull(staffMembers.deletedAt)))
      .limit(1)
    if (linked) return linked

    // Premier accès : le membre a été inscrit par son adresse, le compte lui est
    // rattaché maintenant.
    //
    // Le rattachement se fait sur l'adresse, donc quiconque contrôle cette
    // adresse prend la place. C'est le modèle habituel de l'invitation, et il
    // suppose que l'adresse ait été vérifiée : si le service dit explicitement
    // qu'elle ne l'est pas, on ne rattache rien.
    if (sessionUser.emailVerified === false) return undefined

    const [invited] = await tx
      .select()
      .from(staffMembers)
      .where(
        and(
          eq(staffMembers.email, user.email),
          isNull(staffMembers.authUserId),
          isNull(staffMembers.deletedAt),
        ),
      )
      .limit(1)
    if (!invited) return undefined

    const [claimed] = await tx
      .update(staffMembers)
      .set({ authUserId: user.id, fullName: invited.fullName ?? user.name })
      .where(and(eq(staffMembers.id, invited.id), isNull(staffMembers.authUserId)))
      .returning()
    return claimed
  })

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
