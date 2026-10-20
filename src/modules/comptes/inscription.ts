import { and, eq, or } from 'drizzle-orm'

import { tenantContext } from '../../db/contexte.ts'
import type { Transaction } from '../../db/index.ts'
import { insertReturning } from '../../db/returning.ts'
import { staffMembers } from '../../db/staff.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { AuthenticatedUser } from '../../lib/auth/membre.ts'
import { authUsers } from '../../lib/auth/schema.ts'
import { resolveClientAccounts, type ClientAccount } from '../clients/comptes.ts'
import { clientMembers, clients } from '../clients/schema.ts'

/**
 * Inscription libre sur le site (ADR 045) : une personne qui crée son compte
 * sans avoir été inscrite par le centre reçoit sa propre fiche client, un
 * prospect « inscrit en ligne », et entre dans l'espace client de cette fiche.
 * Elle n'y voit que ce qui lui appartient : la portée client (ADR 019) ne
 * change pas.
 *
 * Appelée par `clientAccess` quand le compte n'a accès à aucune entreprise,
 * **après** le rattachement des inscriptions faites à son adresse : une
 * personne invitée par le centre retrouve son entreprise, pas une fiche vide.
 */

const currentTenant = () => tenantContext.getStore() ?? DEFAULT_TENANT_ID

/** Raison sociale par défaut : la personne qui loue en son nom propre. */
export function signupClientName(input: { companyName: string | null; name: string | null; email: string }): string {
  return (input.companyName?.trim() || input.name?.trim() || input.email).slice(0, 255)
}

/**
 * Crée la fiche et l'accès du compte, une seule fois par compte et par centre.
 * Rend `true` quand elle a créé quelque chose.
 *
 * Rien n'est créé quand le compte a déjà eu un lien avec ce centre, même
 * retiré :
 *
 * - un accès à une entreprise, en cours ou retiré — retiré par l'équipe, il ne
 *   doit pas renaître sous une fiche neuve à la connexion suivante ;
 * - une place dans l'équipe, en cours ou passée — sauf `forStaff` : un membre
 *   de l'équipe qui demande lui-même son espace client depuis le back-office
 *   (`espace-equipe-actions.ts`). Jamais d'office : un membre qui fait une
 *   demande de réservation connecté sur le site ne doit pas se retrouver avec
 *   une fiche qu'il n'a pas demandée.
 *
 * Le compte est verrouillé le temps de la vérification : deux requêtes
 * simultanées de la première connexion ne créent pas deux fiches.
 */
export async function ensureSignupClient(
  tx: Transaction,
  user: AuthenticatedUser,
  options: { forStaff?: boolean } = {},
): Promise<boolean> {
  const [account] = await tx
    .select({ id: authUsers.id, companyName: authUsers.companyName })
    .from(authUsers)
    .where(eq(authUsers.id, user.id))
    .for('update')
  if (!account) return false

  const [member] = await tx
    .select({ id: clientMembers.id })
    .from(clientMembers)
    .where(
      and(
        eq(clientMembers.tenantId, currentTenant()),
        or(eq(clientMembers.authUserId, user.id), eq(clientMembers.email, user.email)),
      ),
    )
    .limit(1)
  if (member) return false

  const [staff] = await tx
    .select({ id: staffMembers.id })
    .from(staffMembers)
    .where(
      and(
        eq(staffMembers.tenantId, currentTenant()),
        or(eq(staffMembers.authUserId, user.id), eq(staffMembers.email, user.email)),
      ),
    )
    .limit(1)
  if (staff && !options.forStaff) return false

  const client = await insertReturning(tx, clients, {
    name: signupClientName({ companyName: account.companyName, name: user.name, email: user.email }),
    email: user.email,
    status: 'prospect',
    // Créée depuis le back-office par le membre lui-même : pas une inscription
    // en ligne à examiner dans l'écran Comptes.
    origin: options.forStaff ? 'back_office' : 'inscription',
  })
  await tx.insert(clientMembers).values({
    clientId: client.id,
    email: user.email,
    authUserId: user.id,
    fullName: user.name || null,
  })
  return true
}

/**
 * Entreprises du compte connecté, sa fiche d'inscription libre créée au
 * besoin : le cœur de `clientAccess` (`clients/session.ts`), ici pour être
 * éprouvé contre une vraie base.
 *
 * Pas de fiche avant que l'adresse soit confirmée, pour qu'une adresse
 * inventée ne remplisse pas la liste des clients.
 *
 * La résolution est rejouée même quand `ensureSignupClient` n'a rien créé :
 * au premier accès, la page et ses requêtes parallèles arrivent ensemble ;
 * celle qui attendait le verrou du compte trouve la fiche que l'autre vient
 * de créer, et doit la rendre plutôt que la liste vide lue avant.
 */
export async function resolveOrSignupClientAccounts(
  tx: Transaction,
  user: AuthenticatedUser,
  options: { emailVerified?: boolean } = {},
): Promise<ClientAccount[]> {
  const found = await resolveClientAccounts(tx, user, options)
  if (found.length > 0 || options.emailVerified === false) return found
  await ensureSignupClient(tx, user)
  return resolveClientAccounts(tx, user, options)
}
