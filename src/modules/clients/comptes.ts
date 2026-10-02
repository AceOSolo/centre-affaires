import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm'

import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import type { AuthenticatedUser } from '../../lib/auth/membre.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clientMembers, clients, type ClientMember } from './schema.ts'

/**
 * Accès des personnes à l'espace client (ADR 015).
 *
 * Même séparation que pour l'équipe (ADR 008) : ce fichier ne connaît ni Next
 * ni la session, ce qui permet d'éprouver la résolution contre une vraie base.
 * `session.ts` fait la jonction.
 */

/** Une entreprise à laquelle le compte connecté a accès. */
export type ClientAccount = {
  memberId: string
  clientId: string
  clientName: string
}

/**
 * Entreprises accessibles au compte connecté, dans une transaction déjà placée
 * dans le contexte d'un centre.
 *
 * Au passage, rattache le compte aux inscriptions faites à son adresse et pas
 * encore réclamées — y compris celles ajoutées depuis sa dernière connexion :
 * une seconde société domiciliée apparaît sans que la personne ait rien à
 * faire.
 *
 * Tableau vide quand le compte n'a accès à rien.
 */
export async function resolveClientAccounts(
  tx: Transaction,
  user: AuthenticatedUser,
  options: { emailVerified?: boolean } = {},
): Promise<ClientAccount[]> {
  // Le rattachement se fait sur l'adresse : sans vérification, quiconque la
  // contrôle lirait le courrier de l'entreprise. Même règle que pour l'équipe.
  if (options.emailVerified !== false) {
    const alreadyLinked = tx
      .select({ clientId: clientMembers.clientId })
      .from(clientMembers)
      .where(and(eq(clientMembers.authUserId, user.id), isNull(clientMembers.deletedAt)))

    await tx
      .update(clientMembers)
      .set({
        authUserId: user.id,
        fullName: sql`coalesce(${clientMembers.fullName}, ${user.name})`,
      })
      .where(
        and(
          eq(clientMembers.email, user.email),
          isNull(clientMembers.authUserId),
          isNull(clientMembers.deletedAt),
          // Un compte déjà rattaché à l'entreprise par une autre adresse ne
          // l'est pas une seconde fois.
          notInArray(clientMembers.clientId, alreadyLinked),
        ),
      )
  }

  return tx
    .select({
      memberId: clientMembers.id,
      clientId: clients.id,
      clientName: clients.name,
    })
    .from(clientMembers)
    .innerJoin(
      clients,
      and(eq(clients.tenantId, clientMembers.tenantId), eq(clients.id, clientMembers.clientId)),
    )
    .where(
      and(
        eq(clientMembers.authUserId, user.id),
        isNull(clientMembers.deletedAt),
        // Une fiche archivée ferme l'accès à ses personnes.
        isNull(clients.deletedAt),
      ),
    )
    .orderBy(asc(clients.name))
}

/** Personnes inscrites sur une fiche, retirées exclues. */
export async function listClientMembers(clientId: string): Promise<ClientMember[]> {
  return withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(clientMembers)
      .where(and(eq(clientMembers.clientId, clientId), isNull(clientMembers.deletedAt)))
      .orderBy(asc(clientMembers.createdAt)),
  )
}

/** Levée quand l'adresse est déjà inscrite sur cette fiche. */
export class DuplicateClientMemberError extends Error {
  constructor(email: string) {
    super(`${email} a déjà accès à l’espace de ce client.`)
    this.name = 'DuplicateClientMemberError'
  }
}

export async function addClientMember(input: {
  clientId: string
  email: string
  fullName: string | null
}): Promise<void> {
  try {
    await withTenant(currentTenantId(), (tx) =>
      tx.insert(clientMembers).values({
        clientId: input.clientId,
        email: input.email.trim().toLowerCase(),
        fullName: input.fullName,
      }),
    )
  } catch (error) {
    // L'unicité est tenue par un index partiel : la vérifier avant laisserait
    // passer deux inscriptions simultanées.
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
      throw new DuplicateClientMemberError(input.email)
    }
    throw error
  }
}

/** Retrait de l'accès : effet immédiat, la personne reste dans l'historique. */
export async function removeClientMember(id: string, clientId: string): Promise<void> {
  await withTenant(currentTenantId(), (tx) =>
    tx
      .update(clientMembers)
      .set({ deletedAt: sql`now()` })
      .where(
        and(
          eq(clientMembers.id, id),
          eq(clientMembers.clientId, clientId),
          isNull(clientMembers.deletedAt),
        ),
      ),
  )
}

/** Adresses des personnes inscrites sur une fiche, pour les prévenir d'un courrier. */
export async function listClientMemberEmails(clientId: string): Promise<string[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ email: clientMembers.email })
      .from(clientMembers)
      .where(and(eq(clientMembers.clientId, clientId), isNull(clientMembers.deletedAt))),
  )
  return rows.map((row) => row.email)
}
