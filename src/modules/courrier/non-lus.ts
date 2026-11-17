import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import type { Database } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import { mailItemMemberStates, mailItems } from './schema.ts'

/**
 * Nombre de plis de la boîte aux lettres, et de plis non lus par la personne
 * connectée : la pastille de l'onglet « Courrier » et l'accueil de l'espace
 * (« 3 nouveaux courriers », ADR 077).
 *
 * « Non lu » est la règle du classement (ADR 044) : un pli que la personne
 * n'a ni ouvert ni marqué lu — sans ligne de classement, ou avec une ligne
 * sans `read_at`. Un pli retiré par l'accueil ne compte pas.
 *
 * Fonction à part, et non `mailFolderCounts` : la pastille ne doit compter
 * que ce que la boîte montre « à voir ». À la fusion de la recette du 17/11,
 * les plis « ignorés » du lot 5 (ADR 078) en sortiront peut-être.
 */
export async function countMailForAccounts(
  accounts: readonly ClientAccount[],
  database?: Database,
): Promise<{ total: number; unread: number }> {
  if (accounts.length === 0) return { total: 0, unread: 0 }
  const clientIds = accounts.map((account) => account.clientId)
  const memberIds = accounts.map((account) => account.memberId)
  return inClientSpace(
    accounts,
    async (tx) => {
      const [row] = await tx
        .select({
          total: sql<number>`count(*)`,
          // Une personne a un accès par entreprise : un classement au plus par pli.
          unread: sql<number>`coalesce(sum(${mailItemMemberStates.readAt} is null), 0)`,
        })
        .from(mailItems)
        .leftJoin(
          mailItemMemberStates,
          and(
            eq(mailItemMemberStates.tenantId, mailItems.tenantId),
            eq(mailItemMemberStates.mailItemId, mailItems.id),
            inArray(mailItemMemberStates.clientMemberId, memberIds),
          ),
        )
        .where(
          and(
            eq(mailItems.tenantId, currentTenantId()),
            inArray(mailItems.clientId, clientIds),
            isNull(mailItems.deletedAt),
          ),
        )
      return { total: Number(row?.total ?? 0), unread: Number(row?.unread ?? 0) }
    },
    database,
  )
}
