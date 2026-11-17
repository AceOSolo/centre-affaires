'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { pageReturnPath, keepPageReturn } from '../../lib/redirection-serveur.ts'
import { isUuid } from '../../lib/uuid.ts'
import { requireClientAccount } from '../clients/session.ts'
import { createCustomCategory } from './categories-perso.ts'
import { classifyMail } from './classement.ts'
import { NEW_CATEGORY_CHOICE } from './classement-ui.ts'
import { isCustomCategoryId } from './categories-perso-regles.ts'
import { readClassificationChange, readTags, isMailCategory, type ClassificationChange } from './classement-regles.ts'

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

/**
 * La liste d'où vient la fiche d'un pli (`?retour=` de la fiche), en chaîne de
 * requête : y revenir après « Ignorer » ou « Marquer comme non lu », filtres
 * et page gardés.
 */
async function listQueryOfPage(): Promise<string> {
  const path = await pageReturnPath()
  if (!path) return ''
  const queryAt = path.indexOf('?')
  const pathname = queryAt === -1 ? path : path.slice(0, queryAt)
  return pathname === '/compte/courrier' && queryAt !== -1 ? path.slice(queryAt).split('#', 1)[0] : ''
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
  if (count === 0 && read.change.type === 'customCategory') {
    // Une catégorie personnelle ne range que le courrier de son entreprise (ADR 060).
    return {
      fieldErrors: {
        'selection-categorie': 'Cette catégorie ne range que le courrier de son entreprise, ou n’existe plus.',
      },
    }
  }
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
  // Une catégorie de départ par sa clé, une catégorie personnelle par son identifiant (ADR 060).
  const categoryChange: ClassificationChange | undefined =
    categoryInput === ''
      ? { type: 'category', category: null }
      : isMailCategory(categoryInput)
        ? { type: 'category', category: categoryInput }
        : isCustomCategoryId(categoryInput)
          ? { type: 'customCategory', id: categoryInput }
          : undefined
  const tags = readTags(String(formData.get('etiquettes') ?? ''))
  const fieldErrors: Record<string, string> = {}
  if (categoryChange === undefined) fieldErrors.categorie = 'Choisissez une catégorie de la liste.'
  if (tags.error !== undefined) fieldErrors.etiquettes = tags.error
  if (Object.keys(fieldErrors).length > 0 || categoryChange === undefined || tags.error !== undefined) {
    return { fieldErrors }
  }

  const handled = formData.get('traite') === 'on'
  let count = await classifyMail(accounts, [id], categoryChange)
  if (count === 0 && categoryChange.type === 'customCategory') {
    // Supprimée entre-temps, ou d'une autre entreprise que celle du pli.
    return { fieldErrors: { categorie: 'Cette catégorie n’existe plus pour ce courrier : choisissez-en une autre.' } }
  }
  if (count > 0) count = await classifyMail(accounts, [id], { type: 'setTags', tags: tags.tags })
  if (count > 0) count = await classifyMail(accounts, [id], { type: handled ? 'handled' : 'unhandled' })
  if (count === 0) return { error: 'Ce courrier n’est plus dans votre boîte aux lettres.' }
  revalidatePath('/compte/courrier')
  revalidatePath(`/compte/courrier/${id}`)
  redirect(await keepPageReturn(`/compte/courrier/${id}?classe=enregistre`))
}

/** État d'un geste fait depuis la carte d'un pli, sans quitter la liste (ADR 078). */
export type QuickActionState = {
  ok?: true
  value?: string
  /** Nom de la catégorie créée à la volée : la liste de la carte ne la connaît pas encore. */
  label?: string
  error?: string
  /** Erreur sur le nom de la nouvelle catégorie : dite sous son champ. */
  nameError?: string
} | null

/** La catégorie choisie sur la carte d'un pli : de départ, personnelle, ou « non classé ». */
function readCategoryChoice(value: string): ClassificationChange | undefined {
  if (value === '' || value === 'non-classe') return { type: 'category', category: null }
  if (isMailCategory(value)) return { type: 'category', category: value }
  if (isCustomCategoryId(value)) return { type: 'customCategory', id: value }
  return undefined
}

/**
 * Classer un pli depuis la liste, sans ouvrir sa fiche (ADR 078). La carte
 * reste à sa place et dit ce qui a été fait ; plusieurs plis d'un coup : la
 * barre de sélection.
 */
export async function classifyOneAction(_previous: QuickActionState, formData: FormData): Promise<QuickActionState> {
  const { accounts } = await requireClientAccount()
  const id = String(formData.get('id') ?? '')
  let value = String(formData.get('categorie') ?? '')
  let label: string | undefined
  // « Ajouter une catégorie… » : la catégorie personnelle est créée pour
  // l'entreprise du pli (ADR 060), puis le pli y est rangé.
  if (value === NEW_CATEGORY_CHOICE && isUuid(id)) {
    const created = await createCustomCategory(
      accounts,
      String(formData.get('entreprise') ?? ''),
      String(formData.get('nouvelleCategorie') ?? ''),
    )
    if (!created.ok) return { nameError: created.error }
    value = created.id
    label = created.name
    revalidatePath('/compte/courrier/categories')
  }
  const change = readCategoryChoice(value)
  if (!isUuid(id) || !change) return { error: 'Choisissez une catégorie de la liste.' }
  const count = await classifyMail(accounts, [id], change)
  if (count === 0) {
    return {
      error:
        change.type === 'customCategory'
          ? 'Cette catégorie ne range que le courrier de son entreprise, ou n’existe plus.'
          : 'Ce courrier n’est plus dans votre boîte aux lettres.',
    }
  }
  revalidatePath('/compte/courrier')
  return { ok: true, value, label }
}

/**
 * « Marquer comme lu » et « Marquer comme non lu » depuis la carte d'un pli
 * (ADR 078) : au même rang que les autres gestes de la carte, sans quitter la
 * liste.
 */
export async function toggleReadAction(_previous: QuickActionState, formData: FormData): Promise<QuickActionState> {
  const { accounts } = await requireClientAccount()
  const id = String(formData.get('id') ?? '')
  const read = formData.get('lu') === '1'
  if (!isUuid(id)) return { error: 'Courrier introuvable.' }
  const count = await classifyMail(accounts, [id], { type: read ? 'read' : 'unread' })
  if (count === 0) return { error: 'Ce courrier n’est plus dans votre boîte aux lettres.' }
  revalidatePath('/compte/courrier')
  return { ok: true, value: read ? 'lu' : 'non-lu' }
}

/**
 * Ignorer un pli, ou le rendre à la liste (ADR 078). Ignoré, il quitte la
 * vue : retour à la boîte aux lettres, filtres gardés, avec une confirmation
 * qui dit où le retrouver — le focus s'y porte, la carte n'étant plus là.
 */
export async function ignoreMailAction(formData: FormData): Promise<void> {
  const { accounts } = await requireClientAccount()
  const id = String(formData.get('id') ?? '')
  const ignore = formData.get('ignorer') === '1'
  if (!isUuid(id)) return
  const count = await classifyMail(accounts, [id], { type: ignore ? 'ignore' : 'unignore' })
  revalidatePath('/compte/courrier')
  const action = ignore ? 'ignorer' : 'ne-plus-ignorer'
  if (formData.get('depuis') === 'fiche') {
    redirect(
      ignore
        ? `/compte/courrier${withParam(await listQueryOfPage(), 'classe', `${action}-${count}`)}`
        : await keepPageReturn(`/compte/courrier/${id}?classe=${action}`),
    )
  }
  redirect(`/compte/courrier${withParam(returnQuery(formData), 'classe', `${action}-${count}`)}`)
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
  redirect(`/compte/courrier${withParam(await listQueryOfPage(), 'classe', 'non-lu-1')}`)
}
