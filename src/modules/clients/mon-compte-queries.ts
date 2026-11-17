import { and, asc, eq, inArray, isNull } from 'drizzle-orm'

import type { Database } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { inClientSpace, type ClientAccount } from './comptes.ts'
import type { ProfileInput } from './mon-compte.ts'
import { clientMembers } from './schema.ts'

/**
 * « Mon compte » en base (ADR 077) : le nom et le téléphone de la personne
 * sont ceux de ses accès (`client_members`), un par entreprise. L'équipe les
 * voit sur la fiche du client. Lus et écrits sous la portée du compte : la
 * personne ne touche qu'à ses propres accès.
 */

const ownAccesses = (accounts: readonly ClientAccount[]) =>
  and(
    eq(clientMembers.tenantId, currentTenantId()),
    inArray(
      clientMembers.id,
      accounts.map((account) => account.memberId),
    ),
    inArray(
      clientMembers.clientId,
      accounts.map((account) => account.clientId),
    ),
    isNull(clientMembers.deletedAt),
  )

/** Nom et téléphone de la personne : le premier renseigné de ses accès. */
export async function loadMemberProfile(
  accounts: readonly ClientAccount[],
  database?: Database,
): Promise<{ fullName: string | null; phone: string | null }> {
  if (accounts.length === 0) return { fullName: null, phone: null }
  const rows = await inClientSpace(
    accounts,
    (tx) =>
      tx
        .select({ fullName: clientMembers.fullName, phone: clientMembers.phone })
        .from(clientMembers)
        .where(ownAccesses(accounts))
        .orderBy(asc(clientMembers.createdAt), asc(clientMembers.id)),
    database,
  )
  return {
    fullName: rows.find((row) => row.fullName)?.fullName ?? null,
    phone: rows.find((row) => row.phone)?.phone ?? null,
  }
}

/** Écrit le nom et le téléphone sur chacun des accès de la personne. Rend le nombre d'accès mis à jour. */
export async function saveMemberProfile(
  accounts: readonly ClientAccount[],
  input: ProfileInput,
  database?: Database,
): Promise<number> {
  if (accounts.length === 0) return 0
  const [result] = (await inClientSpace(
    accounts,
    (tx) =>
      tx
        .update(clientMembers)
        .set({ fullName: input.fullName, phone: input.phone })
        .where(ownAccesses(accounts)),
    database,
  )) as unknown as [{ affectedRows?: number }]
  return Number(result?.affectedRows ?? 0)
}
