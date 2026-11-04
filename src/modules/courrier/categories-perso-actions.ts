'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { isUuid } from '../../lib/uuid.ts'
import { requireClientAccount } from '../clients/session.ts'
import { createCustomCategory, deleteCustomCategory, renameCustomCategory } from './categories-perso.ts'

/**
 * Catégories personnelles du courrier, depuis l'espace client (ADR 060).
 * Chaque action revérifie le compte connecté ; l'accès réglé est pris parmi
 * ceux du compte, jamais dans le formulaire.
 */

export type CategoryFormState = { fieldErrors?: Record<string, string>; error?: string } | null

const PAGE = '/compte/courrier/categories'

function refresh() {
  revalidatePath('/compte/courrier')
  revalidatePath(PAGE)
}

/** Nouvelle catégorie. Champ `nom` ; `entreprise` quand le compte en a plusieurs. */
export async function createCategoryAction(
  _previous: CategoryFormState,
  formData: FormData,
): Promise<CategoryFormState> {
  const { accounts } = await requireClientAccount()
  const clientId = String(formData.get('entreprise') ?? accounts[0]?.clientId ?? '')
  const result = await createCustomCategory(accounts, clientId, String(formData.get('nom') ?? ''))
  if (!result.ok) return { fieldErrors: { nom: result.error } }
  refresh()
  redirect(`${PAGE}?fait=creee`)
}

/** Renommer : le champ porte l'identifiant de la catégorie, pour que le résumé d'erreurs y mène. */
export async function renameCategoryAction(
  _previous: CategoryFormState,
  formData: FormData,
): Promise<CategoryFormState> {
  const { accounts } = await requireClientAccount()
  const id = String(formData.get('id') ?? '')
  const field = `nom-${id}`
  const result = await renameCustomCategory(accounts, id, String(formData.get('nom') ?? ''))
  if (!result.ok) return { fieldErrors: { [field]: result.error } }
  refresh()
  redirect(`${PAGE}?fait=renommee`)
}

/** Supprimer, après confirmation : les plis rangés là redeviennent non classés. */
export async function deleteCategoryAction(formData: FormData): Promise<void> {
  const { accounts } = await requireClientAccount()
  const id = String(formData.get('id') ?? '')
  const result = isUuid(id) ? await deleteCustomCategory(accounts, id) : null
  refresh()
  redirect(result ? `${PAGE}?fait=supprimee&plis=${result.declassified}` : PAGE)
}
