'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { isUuid } from '../../lib/uuid.ts'
import { requireClientAccount } from '../clients/session.ts'
import { createCustomCategory, deleteCustomCategory } from './categories-perso.ts'
import { savePersonCategories } from './categories-reglages.ts'
import type { CategoryListState } from './categories-reglages-forms.tsx'
import { categoryListDoneMessage, readCategoryListForm } from './categories-reglages-regles.ts'

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

/**
 * Ma liste de catégories (ADR 078) : renommer, masquer, ordonner les
 * catégories proposées comme les miennes, pour moi seul. Sans redirection :
 * la liste se redessine en place, le focus revient au bouton pressé.
 */
export async function savePersonCategoriesAction(
  _previous: CategoryListState,
  formData: FormData,
): Promise<CategoryListState> {
  const { accounts } = await requireClientAccount()
  const clientId = String(formData.get('entreprise') ?? accounts[0]?.clientId ?? '')
  const { inputs, gesture, values } = readCategoryListForm(formData)
  const result = await savePersonCategories(accounts, clientId, inputs)
  if (!result.ok) return { error: result.error, fieldErrors: result.fieldErrors, values }
  refresh()
  return {
    done: categoryListDoneMessage(gesture, inputs),
    focus: gesture.type === 'deplacer' ? `deplacer-${gesture.key}-${gesture.direction}` : undefined,
  }
}

/** Supprimer, après confirmation : les plis rangés là redeviennent non classés. */
export async function deleteCategoryAction(formData: FormData): Promise<void> {
  const { accounts } = await requireClientAccount()
  const id = String(formData.get('id') ?? '')
  const result = isUuid(id) ? await deleteCustomCategory(accounts, id) : null
  refresh()
  redirect(result ? `${PAGE}?fait=supprimee&plis=${result.declassified}` : PAGE)
}
