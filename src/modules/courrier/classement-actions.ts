'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { isUuid } from '../../lib/uuid.ts'
import { requireClientAccount } from '../clients/session.ts'
import { classifyMail } from './classement.ts'
import { readClassificationChange, readTags, isMailCategory } from './classement-regles.ts'

/**
 * Classement du courrier depuis l'espace client (ADR 044). Chaque action
 * revérifie le compte connecté : une action serveur s'appelle sans passer
 * par la page.
 */

export type ClassificationFormState = {
  error?: string
  fieldErrors?: Record<string, string>
} | null

/** Retour à la boîte aux lettres, filtres gardés : seulement une chaîne de requête. */
function returnQuery(formData: FormData): string {
  const value = String(formData.get('retour') ?? '')
  return value.startsWith('?') && !value.includes('//') ? value : ''
}

const withParam = (query: string, key: string, value: string) => {
  const params = new URLSearchParams(query.slice(1))
  params.delete('page')
  params.set(key, value)
  return `?${params.toString()}`
}

/** Barre de sélection : un geste sur les plis cochés. */
export async function classifySelectionAction(
  _previous: ClassificationFormState,
  formData: FormData,
): Promise<ClassificationFormState> {
  const { accounts } = await requireClientAccount()
  const ids = formData.getAll('ids').map(String).filter((id) => isUuid(id))
  const action = String(formData.get('action') ?? '')
  const value = String(formData.get(action === 'classer' ? 'categorie' : 'etiquette') ?? '')

  if (ids.length === 0) return { error: 'Cochez d’abord les courriers à traiter.' }
  const read = readClassificationChange(action, value)
  if (read.error !== undefined) {
    // Clé de l'erreur = `id` du champ de la barre : le résumé d'erreurs y mène.
    const field =
      action === 'classer' ? 'selection-categorie' : action === 'etiqueter' ? 'selection-etiquette' : undefined
    return field ? { fieldErrors: { [field]: read.error } } : { error: read.error }
  }

  const count = await classifyMail(accounts, ids, read.change)
  if (count === 0) return { error: 'Ces courriers ne sont plus dans votre boîte aux lettres.' }
  revalidatePath('/compte/courrier')
  // Le compte et le geste suffisent à la confirmation : rien de personnel dans l'URL.
  redirect(`/compte/courrier${withParam(returnQuery(formData), 'classe', `${action}-${count}`)}`)
}

/** Fiche d'un pli : catégorie, étiquettes et suivi, enregistrés ensemble. */
export async function saveClassificationAction(
  _previous: ClassificationFormState,
  formData: FormData,
): Promise<ClassificationFormState> {
  const { accounts } = await requireClientAccount()
  const id = String(formData.get('id') ?? '')
  if (!isUuid(id)) return { error: 'Courrier introuvable.' }

  const categoryInput = String(formData.get('categorie') ?? '')
  const category = categoryInput === '' ? null : isMailCategory(categoryInput) ? categoryInput : undefined
  const tags = readTags(String(formData.get('etiquettes') ?? ''))
  const fieldErrors: Record<string, string> = {}
  if (category === undefined) fieldErrors.categorie = 'Choisissez une catégorie de la liste.'
  if (tags.error !== undefined) fieldErrors.etiquettes = tags.error
  if (Object.keys(fieldErrors).length > 0 || category === undefined || tags.error !== undefined) {
    return { fieldErrors }
  }

  const handled = formData.get('traite') === 'on'
  let count = await classifyMail(accounts, [id], { type: 'category', category })
  if (count > 0) count = await classifyMail(accounts, [id], { type: 'setTags', tags: tags.tags })
  if (count > 0) count = await classifyMail(accounts, [id], { type: handled ? 'handled' : 'unhandled' })
  if (count === 0) return { error: 'Ce courrier n’est plus dans votre boîte aux lettres.' }
  revalidatePath('/compte/courrier')
  revalidatePath(`/compte/courrier/${id}`)
  redirect(`/compte/courrier/${id}?classe=enregistre`)
}

/**
 * « Marquer comme non lu » : retour à la boîte aux lettres, sans quoi la
 * fiche, en se rouvrant, marquerait aussitôt le pli lu de nouveau.
 */
export async function markUnreadAction(formData: FormData): Promise<void> {
  const { accounts } = await requireClientAccount()
  const id = String(formData.get('id') ?? '')
  if (!isUuid(id)) return
  await classifyMail(accounts, [id], { type: 'unread' })
  revalidatePath('/compte/courrier')
  redirect('/compte/courrier?classe=non-lu-1')
}
