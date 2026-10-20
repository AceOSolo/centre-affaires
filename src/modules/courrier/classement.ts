import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import type { Database } from '../../db/index.ts'
import { isUuid, uuidv7 } from '../../lib/uuid.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import {
  applyClassification,
  emptyClassification,
  type ClassificationChange,
  type MailClassification,
} from './classement-regles.ts'
import { mailCategories, mailItemMemberStates, mailItems, type MailCategory } from './schema.ts'

/**
 * Classement du courrier par chaque personne de l'espace client (ADR 044) :
 * lu, traité, catégorie, étiquettes. Propre à la personne — son accès à
 * l'entreprise du pli — et jamais lu par le centre.
 *
 * Tout passe par `inClientSpace` : la base refuse d'écrire hors des
 * entreprises du compte, les requêtes filtrent elles-mêmes leurs lectures.
 */

/** Une sélection se traite d'un coup, dans la limite d'une page et demie. */
export const MAX_SELECTION = 50

/**
 * Applique un geste aux plis choisis, pour la personne connectée. Rend le
 * nombre de plis concernés : ceux de ses entreprises, non retirés ; les
 * autres identifiants sont ignorés.
 */
export async function classifyMail(
  accounts: ClientAccount[],
  mailItemIds: readonly string[],
  change: ClassificationChange,
  database?: Database,
): Promise<number> {
  const ids = [...new Set(mailItemIds.filter((id) => isUuid(id)))].slice(0, MAX_SELECTION)
  if (accounts.length === 0 || ids.length === 0) return 0
  const memberByClient = new Map(accounts.map((account) => [account.clientId, account.memberId]))
  const now = new Date()

  return inClientSpace(
    accounts,
    async (tx) => {
      const items = await tx
        .select({ id: mailItems.id, clientId: mailItems.clientId })
        .from(mailItems)
        .where(
          and(
            inArray(mailItems.id, ids),
            inArray(mailItems.clientId, [...memberByClient.keys()]),
            isNull(mailItems.deletedAt),
          ),
        )
      if (items.length === 0) return 0
      // Verrouillées : deux onglets qui étiquettent en même temps ne perdent
      // pas l'étiquette de l'autre.
      const existing = await tx
        .select()
        .from(mailItemMemberStates)
        .where(
          and(
            inArray(
              mailItemMemberStates.mailItemId,
              items.map((item) => item.id),
            ),
            inArray(mailItemMemberStates.clientMemberId, [...memberByClient.values()]),
          ),
        )
        .for('update')
      const byItem = new Map(existing.map((row) => [row.mailItemId, row]))

      for (const item of items) {
        const memberId = memberByClient.get(item.clientId) as string
        const row = byItem.get(item.id)
        const current: MailClassification = row
          ? { readAt: row.readAt, handledAt: row.handledAt, category: row.category, tags: row.tags ?? [] }
          : emptyClassification
        const next = applyClassification(current, change, now)
        const values = {
          readAt: next.readAt,
          handledAt: next.handledAt,
          category: next.category,
          tags: next.tags,
        }
        if (row) {
          await tx.update(mailItemMemberStates).set(values).where(eq(mailItemMemberStates.id, row.id))
        } else {
          // Une ligne née entre-temps (double clic) : l'index unique la
          // retrouve, le geste s'y applique tel quel.
          await tx
            .insert(mailItemMemberStates)
            .values({ id: uuidv7(), clientId: item.clientId, mailItemId: item.id, clientMemberId: memberId, ...values })
            .onDuplicateKeyUpdate({ set: values })
        }
      }
      return items.length
    },
    database,
  )
}

/**
 * « Lu » posé à la consultation d'un pli — sa fiche, ou son contenu. Ne
 * touche pas une lecture déjà datée. Silencieux : la consultation ne doit
 * jamais échouer pour un classement.
 */
export async function markMailRead(accounts: ClientAccount[], mailItemId: string): Promise<void> {
  try {
    await classifyMail(accounts, [mailItemId], { type: 'read' })
  } catch (error) {
    console.error('Lecture du courrier non notée', error)
  }
}

export type MailFolderCounts = {
  total: number
  unread: number
  toHandle: number
  handled: number
  /** Par catégorie, et `non-classe` pour les plis sans catégorie. */
  byCategory: Record<MailCategory | 'non-classe', { total: number; unread: number }>
  /** Étiquettes de la personne, par ordre alphabétique, avec leur nombre de plis. */
  tags: { tag: string; count: number }[]
}

/** Compteurs des rubriques de la boîte aux lettres, pour la personne connectée. */
export async function mailFolderCounts(accounts: ClientAccount[], database?: Database): Promise<MailFolderCounts> {
  const byCategory = Object.fromEntries(
    [...mailCategories, 'non-classe'].map((key) => [key, { total: 0, unread: 0 }]),
  ) as MailFolderCounts['byCategory']
  const counts: MailFolderCounts = { total: 0, unread: 0, toHandle: 0, handled: 0, byCategory, tags: [] }
  if (accounts.length === 0) return counts
  const clientIds = accounts.map((account) => account.clientId)
  const memberIds = accounts.map((account) => account.memberId)

  return inClientSpace(
    accounts,
    async (tx) => {
      const rows = await tx
        .select({
          category: mailItemMemberStates.category,
          total: sql<number>`count(*)`,
          unread: sql<number>`sum(${mailItemMemberStates.readAt} is null)`,
          handled: sql<number>`sum(${mailItemMemberStates.handledAt} is not null)`,
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
        .where(and(inArray(mailItems.clientId, clientIds), isNull(mailItems.deletedAt)))
        .groupBy(mailItemMemberStates.category)
      for (const row of rows) {
        const total = Number(row.total)
        const unread = Number(row.unread ?? 0)
        const handled = Number(row.handled ?? 0)
        counts.total += total
        counts.unread += unread
        counts.handled += handled
        const key = row.category ?? 'non-classe'
        counts.byCategory[key].total += total
        counts.byCategory[key].unread += unread
      }
      counts.toHandle = counts.total - counts.handled

      // Étiquettes : dépliées du tableau JSON de chaque classement.
      const [tagRows] = (await tx.execute(sql`
        select jt.tag as tag, count(*) as count
          from mail_item_member_states as s
          join mail_items as i on i.tenant_id = s.tenant_id and i.id = s.mail_item_id
          cross join json_table(s.tags, '$[*]' columns (tag varchar(30) path '$')) as jt
         where s.client_member_id in ${memberIds}
           and i.client_id in ${clientIds}
           and i.deleted_at is null
         group by jt.tag
         order by jt.tag`)) as unknown as [{ tag: string; count: number }[]]
      counts.tags = tagRows.map((row) => ({ tag: row.tag, count: Number(row.count) }))
      return counts
    },
    database,
  )
}
