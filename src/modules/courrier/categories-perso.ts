import { and, asc, eq, inArray, sql } from 'drizzle-orm'

import type { Database, Transaction } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid, uuidv7 } from '../../lib/uuid.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import {
  canCreateCategory,
  MAX_CUSTOM_CATEGORIES,
  validateCategoryName,
  type CustomCategory,
} from './categories-perso-regles.ts'
import { mailItemMemberStates, mailMemberCategories } from './schema.ts'

/**
 * Catégories personnelles du courrier (ADR 060) : créées, renommées et
 * supprimées par une personne de l'espace client, pour son accès à une
 * entreprise — la portée du classement (ADR 044).
 *
 * Tout passe par `inClientSpace` : la base refuse d'écrire hors des
 * entreprises du compte ; chaque lecture filtre le centre, la personne et ses
 * entreprises. L'accès vient du compte connecté, jamais du formulaire.
 */

/** Issue d'un geste : la catégorie touchée, ou l'erreur à montrer près du champ. */
export type CategoryResult = { ok: true; id: string; name: string } | { ok: false; error: string }

const ownedBy = (accounts: readonly ClientAccount[]) =>
  and(
    eq(mailMemberCategories.tenantId, currentTenantId()),
    inArray(
      mailMemberCategories.clientMemberId,
      accounts.map((account) => account.memberId),
    ),
    inArray(
      mailMemberCategories.clientId,
      accounts.map((account) => account.clientId),
    ),
  )

/** Les catégories de la personne connectée, par ordre alphabétique, avec leur nombre de plis. */
export async function listCustomCategories(
  accounts: ClientAccount[],
  database?: Database,
): Promise<(CustomCategory & { mailCount: number })[]> {
  if (accounts.length === 0) return []
  return inClientSpace(
    accounts,
    async (tx) => {
      const rows = await tx
        .select({
          id: mailMemberCategories.id,
          clientId: mailMemberCategories.clientId,
          name: mailMemberCategories.name,
          mailCount: sql<number>`(
            select count(*) from mail_item_member_states as s
              join mail_items as i on i.tenant_id = s.tenant_id and i.id = s.mail_item_id
             where s.tenant_id = mail_member_categories.tenant_id
               and s.custom_category_id = mail_member_categories.id
               and i.deleted_at is null)`,
        })
        .from(mailMemberCategories)
        .where(ownedBy(accounts))
        .orderBy(asc(mailMemberCategories.name), asc(mailMemberCategories.id))
      return rows.map((row) => ({ ...row, mailCount: Number(row.mailCount) }))
    },
    database,
  )
}

/** Les catégories de l'accès, verrouillées : deux onglets qui créent en même temps comptent juste. */
async function lockedCategories(tx: Transaction, account: ClientAccount) {
  return tx
    .select({ id: mailMemberCategories.id, name: mailMemberCategories.name })
    .from(mailMemberCategories)
    .where(
      and(
        eq(mailMemberCategories.tenantId, currentTenantId()),
        eq(mailMemberCategories.clientMemberId, account.memberId),
        eq(mailMemberCategories.clientId, account.clientId),
      ),
    )
    .for('update')
}

/**
 * Crée une catégorie pour l'accès de la personne à cette entreprise. Refuse
 * un nom vide, trop long ou déjà pris, et une vingt et unième catégorie.
 */
export async function createCustomCategory(
  accounts: ClientAccount[],
  clientId: string,
  input: string,
  database?: Database,
): Promise<CategoryResult> {
  const account = accounts.find((candidate) => candidate.clientId === clientId)
  if (!account) return { ok: false, error: 'Entreprise introuvable dans votre espace.' }
  return inClientSpace(
    accounts,
    async (tx) => {
      const existing = await lockedCategories(tx, account)
      if (!canCreateCategory(existing.length)) {
        return {
          ok: false as const,
          error: `${MAX_CUSTOM_CATEGORIES} catégories au plus : supprimez-en une avant d’en créer une autre.`,
        }
      }
      const checked = validateCategoryName(input, existing)
      if (checked.error !== undefined) return { ok: false as const, error: checked.error }
      const id = uuidv7()
      await tx.insert(mailMemberCategories).values({
        id,
        clientId: account.clientId,
        clientMemberId: account.memberId,
        name: checked.name,
      })
      return { ok: true as const, id, name: checked.name }
    },
    database,
  )
}

/** Renomme une catégorie de la personne ; ses plis y restent rangés. */
export async function renameCustomCategory(
  accounts: ClientAccount[],
  id: string,
  input: string,
  database?: Database,
): Promise<CategoryResult> {
  if (accounts.length === 0 || !isUuid(id)) return { ok: false, error: 'Catégorie introuvable.' }
  return inClientSpace(
    accounts,
    async (tx) => {
      const [found] = await tx
        .select({ clientId: mailMemberCategories.clientId, clientMemberId: mailMemberCategories.clientMemberId })
        .from(mailMemberCategories)
        .where(and(ownedBy(accounts), eq(mailMemberCategories.id, id)))
      const account = found && accounts.find((candidate) => candidate.memberId === found.clientMemberId)
      if (!account) return { ok: false as const, error: 'Catégorie introuvable.' }
      const existing = await lockedCategories(tx, account)
      const checked = validateCategoryName(input, existing, id)
      if (checked.error !== undefined) return { ok: false as const, error: checked.error }
      await tx
        .update(mailMemberCategories)
        .set({ name: checked.name })
        .where(and(ownedBy(accounts), eq(mailMemberCategories.id, id)))
      return { ok: true as const, id, name: checked.name }
    },
    database,
  )
}

/**
 * Supprime une catégorie de la personne : ses plis redeviennent « non
 * classés », dans la même transaction. Réglage personnel, comme une
 * étiquette : rien n'en reste (ADR 060). Rend le nombre de plis déclassés, ou
 * `null` si la catégorie n'est pas à elle.
 */
export async function deleteCustomCategory(
  accounts: ClientAccount[],
  id: string,
  database?: Database,
): Promise<{ name: string; declassified: number } | null> {
  if (accounts.length === 0 || !isUuid(id)) return null
  return inClientSpace(
    accounts,
    async (tx) => {
      const [found] = await tx
        .select({ id: mailMemberCategories.id, name: mailMemberCategories.name })
        .from(mailMemberCategories)
        .where(and(ownedBy(accounts), eq(mailMemberCategories.id, id)))
        .for('update')
      if (!found) return null
      const [result] = (await tx
        .update(mailItemMemberStates)
        .set({ customCategoryId: null })
        .where(
          and(
            eq(mailItemMemberStates.tenantId, currentTenantId()),
            eq(mailItemMemberStates.customCategoryId, id),
          ),
        )) as unknown as [{ affectedRows: number }]
      await tx.delete(mailMemberCategories).where(and(ownedBy(accounts), eq(mailMemberCategories.id, id)))
      return { name: found.name, declassified: Number(result?.affectedRows ?? 0) }
    },
    database,
  )
}
