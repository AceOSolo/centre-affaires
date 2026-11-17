import { and, eq } from 'drizzle-orm'

import { withTenant, type Database, type Transaction } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import {
  centreCategories,
  centreCategoriesSave,
  personCategoriesSave,
  personCategoryList,
  validateCategoryInputs,
  type CategoryEntry,
  type CategoryInput,
  type CentreCategorySetting,
  type OwnCategory,
  type ProposedCategory,
} from './categories-reglages-regles.ts'
import { mailCategories } from './categories.ts'
import { mailCategoryDefaults, mailMemberCategoryPrefs } from './schema-client.ts'
import { mailMemberCategories } from './schema.ts'

/**
 * Catégories du courrier telles qu'on les règle (ADR 078) : la liste proposée
 * par le centre (Réglages), et la vue de chaque personne de l'espace client —
 * ses noms, ses masquages, son ordre, pour les catégories proposées comme pour
 * les siennes (ADR 060).
 *
 * Côté client, tout passe par `inClientSpace` : la base refuse d'écrire hors
 * des entreprises du compte, chaque lecture filtre le centre, la personne et
 * ses entreprises. Côté centre, `withTenant`, après
 * `requirePermission('centre.configurer')` dans l'action ou la page.
 */

/** Réglages du centre, lus dans la transaction en cours. */
async function readCentreSettings(tx: Transaction): Promise<CentreCategorySetting[]> {
  return tx
    .select({
      category: mailCategoryDefaults.category,
      name: mailCategoryDefaults.name,
      hidden: mailCategoryDefaults.hidden,
      position: mailCategoryDefaults.position,
    })
    .from(mailCategoryDefaults)
    .where(eq(mailCategoryDefaults.tenantId, currentTenantId()))
}

/** Les catégories proposées par le centre, dans son ordre, pour l'écran de Réglages. */
export async function listCentreCategories(database?: Database): Promise<ProposedCategory[]> {
  return withTenant(currentTenantId(), async (tx) => centreCategories(await readCentreSettings(tx)), database)
}

export type CategoriesSaveResult = { ok: true } | { ok: false; error?: string; fieldErrors?: Record<string, string> }

/**
 * Enregistre la liste du centre, dans l'ordre affiché : noms, masquages,
 * rangs. Les dix catégories de départ, ni plus ni moins.
 */
export async function saveCentreCategories(
  inputs: readonly CategoryInput[],
  database?: Database,
): Promise<CategoriesSaveResult> {
  const keys = new Set(inputs.map((input) => input.key))
  if (keys.size !== mailCategories.length || !mailCategories.every((category) => keys.has(category))) {
    return { ok: false, error: 'La liste des catégories est incomplète : rechargez la page.' }
  }
  const checked = validateCategoryInputs(inputs)
  if (checked.fieldErrors) return { ok: false, fieldErrors: checked.fieldErrors }
  const settings = centreCategoriesSave(checked.entries)
  await withTenant(
    currentTenantId(),
    async (tx) => {
      for (const setting of settings) {
        const values = { name: setting.name, hidden: setting.hidden, position: setting.position }
        await tx
          .insert(mailCategoryDefaults)
          .values({ id: uuidv7(), category: setting.category, ...values })
          .onDuplicateKeyUpdate({ set: values })
      }
    },
    database,
  )
  return { ok: true }
}

/* -------------------------------------------------------------------------- */
/* Espace client                                                              */
/* -------------------------------------------------------------------------- */

/** Catégories personnelles de l'accès, avec rang et masquage ; verrouillées si demandé. */
async function readOwn(tx: Transaction, account: ClientAccount, lock = false): Promise<OwnCategory[]> {
  const query = tx
    .select({
      id: mailMemberCategories.id,
      name: mailMemberCategories.name,
      hidden: mailMemberCategories.hidden,
      position: mailMemberCategories.position,
    })
    .from(mailMemberCategories)
    .where(
      and(
        eq(mailMemberCategories.tenantId, currentTenantId()),
        eq(mailMemberCategories.clientMemberId, account.memberId),
        eq(mailMemberCategories.clientId, account.clientId),
      ),
    )
  return lock ? query.for('update') : query
}

/** La liste d'un accès, lue dans la transaction en cours. */
export async function readCategoryList(
  tx: Transaction,
  account: ClientAccount,
  centre?: ProposedCategory[],
): Promise<CategoryEntry[]> {
  const proposed = centre ?? centreCategories(await readCentreSettings(tx))
  const prefs = await tx
    .select({
      category: mailMemberCategoryPrefs.category,
      name: mailMemberCategoryPrefs.name,
      hidden: mailMemberCategoryPrefs.hidden,
      position: mailMemberCategoryPrefs.position,
    })
    .from(mailMemberCategoryPrefs)
    .where(
      and(
        eq(mailMemberCategoryPrefs.tenantId, currentTenantId()),
        eq(mailMemberCategoryPrefs.clientMemberId, account.memberId),
        eq(mailMemberCategoryPrefs.clientId, account.clientId),
      ),
    )
  return personCategoryList(proposed, prefs, await readOwn(tx, account))
}

/**
 * La liste de chaque accès du compte, par entreprise : les catégories
 * proposées avec les réglages de la personne, puis les siennes, dans son
 * ordre.
 */
export async function loadCategoryLists(
  accounts: ClientAccount[],
  database?: Database,
): Promise<Map<string, CategoryEntry[]>> {
  if (accounts.length === 0) return new Map()
  return inClientSpace(
    accounts,
    async (tx) => {
      const centre = centreCategories(await readCentreSettings(tx))
      const lists = new Map<string, CategoryEntry[]>()
      for (const account of accounts) lists.set(account.clientId, await readCategoryList(tx, account, centre))
      return lists
    },
    database,
  )
}

/**
 * Enregistre la liste d'une personne pour une de ses entreprises, dans
 * l'ordre affiché. La liste envoyée doit être celle de la base : une
 * catégorie créée ou supprimée dans un autre onglet fait recharger la page,
 * plutôt que d'enregistrer un ordre qui l'oublie.
 */
export async function savePersonCategories(
  accounts: ClientAccount[],
  clientId: string,
  inputs: readonly CategoryInput[],
  database?: Database,
): Promise<CategoriesSaveResult> {
  const account = accounts.find((candidate) => candidate.clientId === clientId)
  if (!account) return { ok: false, error: 'Entreprise introuvable dans votre espace.' }
  const checked = validateCategoryInputs(inputs)
  if (checked.fieldErrors) return { ok: false, fieldErrors: checked.fieldErrors }

  return inClientSpace(
    accounts,
    async (tx) => {
      const own = await readOwn(tx, account, true)
      const centre = centreCategories(await readCentreSettings(tx))
      const expected = new Set([...centre.map((entry) => entry.category as string), ...own.map((entry) => entry.id)])
      const sent = new Set(checked.entries.map((entry) => entry.key))
      if (sent.size !== expected.size || [...expected].some((key) => !sent.has(key))) {
        return {
          ok: false as const,
          error: 'Vos catégories ont changé entre-temps, dans un autre onglet : rechargez la page.',
        }
      }
      const save = personCategoriesSave(centre, own, checked.entries)

      for (const pref of save.prefs) {
        const scope = and(
          eq(mailMemberCategoryPrefs.tenantId, currentTenantId()),
          eq(mailMemberCategoryPrefs.clientMemberId, account.memberId),
          eq(mailMemberCategoryPrefs.clientId, account.clientId),
          eq(mailMemberCategoryPrefs.category, pref.category),
        )
        // Rien qui diffère du centre : pas de ligne. Un réglage, comme une
        // étiquette : il s'efface vraiment (ADR 060).
        if (pref.name === null && pref.hidden === null && pref.position === null) {
          await tx.delete(mailMemberCategoryPrefs).where(scope)
          continue
        }
        const values = { name: pref.name, hidden: pref.hidden, position: pref.position }
        await tx
          .insert(mailMemberCategoryPrefs)
          .values({
            id: uuidv7(),
            clientId: account.clientId,
            clientMemberId: account.memberId,
            category: pref.category,
            ...values,
          })
          .onDuplicateKeyUpdate({ set: values })
      }

      const before = new Map(own.map((category) => [category.id, category]))
      const renamed = save.own.filter((category) => before.get(category.id)?.name !== category.name)
      const ownScope = (id: string) =>
        and(
          eq(mailMemberCategories.tenantId, currentTenantId()),
          eq(mailMemberCategories.clientMemberId, account.memberId),
          eq(mailMemberCategories.clientId, account.clientId),
          eq(mailMemberCategories.id, id),
        )
      // Deux catégories qui échangent leurs noms : un nom provisoire d'abord,
      // pour ne pas heurter l'unicité du nom en cours de route.
      if (renamed.length > 1) {
        for (const category of renamed) {
          await tx.update(mailMemberCategories).set({ name: `~${category.id.slice(-12)}` }).where(ownScope(category.id))
        }
      }
      for (const category of save.own) {
        await tx
          .update(mailMemberCategories)
          .set({ name: category.name, hidden: category.hidden, position: category.position })
          .where(ownScope(category.id))
      }
      return { ok: true as const }
    },
    database,
  )
}

/** Noms des catégories proposées tels qu'un accès les voit : réservés à la création d'une catégorie. */
export async function proposedNamesFor(tx: Transaction, account: ClientAccount): Promise<string[]> {
  const list = await readCategoryList(tx, account)
  return list.filter((entry) => entry.kind === 'proposee').map((entry) => entry.name)
}
