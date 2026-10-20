import { and, eq, isNull } from 'drizzle-orm'

import { tenantContext } from '../../db/contexte.ts'
import type { Transaction } from '../../db/index.ts'
import { updateReturning } from '../../db/returning.ts'
import { staffMembers, type StaffMember } from '../../db/staff.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'

/**
 * Identité d'un compte connecté, réduite à ce dont l'autorisation a besoin.
 *
 * Ce module ne connaît ni Next, ni React, ni le service d'authentification (Better Auth) :
 * c'est ce qui permet de l'éprouver contre une vraie base sans monter un
 * serveur. `staff.ts` fait la jonction avec la session.
 */
export type AuthenticatedUser = {
  id: string
  /** Toujours en minuscules : c'est la clé de rattachement. */
  email: string
  name: string | null
}

/**
 * Filtre sur le centre de la transaction (`withTenant()`). MySQL n'a pas de
 * Row Level Security : sans lui, une résolution dans un centre verrait les
 * membres des autres.
 */
export const inCurrentTenant = () =>
  eq(staffMembers.tenantId, tenantContext.getStore() ?? DEFAULT_TENANT_ID)

/**
 * Membre correspondant au compte connecté, dans une transaction déjà placée
 * dans le contexte d'un centre.
 *
 * Sortie de `staffAccess` pour être éprouvée contre une vraie base : c'est la
 * décision qui ouvre ou ferme le back-office, elle ne doit pas dépendre d'une
 * session pour être testable.
 *
 * Renvoie `undefined` quand le compte n'appartient à personne dans ce centre —
 * un compte existe, il ne donne accès à rien (ADR 008).
 */
export async function resolveStaffMember(
  tx: Transaction,
  user: AuthenticatedUser,
  options: { emailVerified?: boolean } = {},
): Promise<StaffMember | undefined> {
  const linkedToAccount = async () => {
    const [linked] = await tx
      .select()
      .from(staffMembers)
      .where(
        and(
          inCurrentTenant(),
          eq(staffMembers.authUserId, user.id),
          isNull(staffMembers.deletedAt),
        ),
      )
      .limit(1)
    return linked
  }

  const linked = await linkedToAccount()
  if (linked) return linked

  // Premier accès : le membre a été inscrit par son adresse, le compte lui est
  // rattaché maintenant.
  //
  // Le rattachement se fait sur l'adresse, donc quiconque contrôle cette
  // adresse prend la place. C'est le modèle habituel de l'invitation, et il
  // suppose que l'adresse ait été vérifiée : si le service dit explicitement
  // qu'elle ne l'est pas, on ne rattache rien.
  if (options.emailVerified === false) return undefined

  const [invited] = await tx
    .select()
    .from(staffMembers)
    .where(
      and(
        inCurrentTenant(),
        eq(staffMembers.email, user.email),
        isNull(staffMembers.authUserId),
        isNull(staffMembers.deletedAt),
      ),
    )
    .limit(1)
  if (!invited) return undefined

  const [claimed] = await updateReturning(
    tx,
    staffMembers,
    { authUserId: user.id, fullName: invited.fullName ?? user.name },
    // La condition sur `auth_user_id` rejoue le filtre de la lecture : entre
    // les deux requêtes, une autre connexion a pu rattacher le même membre.
    and(inCurrentTenant(), eq(staffMembers.id, invited.id), isNull(staffMembers.authUserId)),
  )
  if (claimed) return claimed

  // Rattachement perdu : au premier accès, la page et ses requêtes parallèles
  // résolvent le même compte en même temps, et la première a rattaché le
  // membre. Relu par le compte — en `READ COMMITTED`, la relecture voit ce
  // rattachement ; fait par un autre compte, elle ne trouve toujours rien.
  return linkedToAccount()
}
