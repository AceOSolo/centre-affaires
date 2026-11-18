'use server'

import { revalidatePath } from 'next/cache'

import { requirePermission } from '../../lib/auth/staff.ts'
import { saveCentreCategories } from './categories-reglages.ts'
import type { CategoryListState } from './categories-reglages-forms.tsx'
import { categoryListDoneMessage, readCategoryListForm } from './categories-reglages-regles.ts'

/**
 * Catégories du courrier proposées aux clients, réglées par le centre
 * (ADR 078) : renommer, masquer, ordonner. Réglage du centre
 * (`centre.configurer`, exploitant et direction), revérifié ici : une action
 * serveur s'appelle sans passer par la page.
 */
export async function saveCentreCategoriesAction(
  _previous: CategoryListState,
  formData: FormData,
): Promise<CategoryListState> {
  await requirePermission('centre.configurer')
  const { inputs, gesture, values } = readCategoryListForm(formData)
  const result = await saveCentreCategories(inputs)
  if (!result.ok) return { error: result.error, fieldErrors: result.fieldErrors, values }
  revalidatePath('/courrier/categories')
  // Les boîtes aux lettres des clients lisent la liste du centre.
  revalidatePath('/compte/courrier', 'layout')
  return {
    done: categoryListDoneMessage(gesture, inputs),
    focus: gesture.type === 'deplacer' ? `deplacer-${gesture.key}-${gesture.direction}` : undefined,
  }
}
