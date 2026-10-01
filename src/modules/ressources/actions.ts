'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'

import { parseResourceInput } from './attributs.ts'
import {
  DuplicateLockerNumberError,
  DuplicateResourceCodeError,
  archiveResource,
  createResource,
  findResource,
  updateResource,
  updateResourceStatus,
} from './queries.ts'
import { resourceStatuses, type ResourceStatus } from './schema.ts'

/**
 * Ce qu'un formulaire réaffiche après un échec : un message général, les
 * erreurs par champ et la saisie, pour que rien ne soit à retaper.
 */
export type FormState = {
  error?: string
  fieldErrors?: Record<string, string>
  values?: Record<string, string>
} | null

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

/** La saisie brute, renvoyée telle quelle au formulaire en cas d'échec. */
function submittedValues(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string' && !key.startsWith('$')) values[key] = value
  }
  return values
}

/** L'erreur d'unicité, rattachée au champ qu'elle concerne. */
function uniquenessFailure(error: unknown): Record<string, string> | undefined {
  if (error instanceof DuplicateResourceCodeError) return { code: error.message }
  if (error instanceof DuplicateLockerNumberError) return { numero: error.message }
  return undefined
}

/**
 * Déclaration d'une ressource. Les attributs propres au type sont validés côté
 * serveur (`attributs.ts`) : le formulaire n'est qu'un confort, une action
 * serveur s'appelle sans lui.
 */
export async function createResourceAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // Contrôle d'accès dans l'action elle-même : une action serveur s'invoque
  // par son identifiant depuis n'importe quel chemin, le filtre de routes ne
  // la protège pas (ADR 008).
  await requirePermission('ressources.gerer')
  const values = submittedValues(formData)
  // Une ressource naît en service ou en maintenance ; « retirée » se décide
  // par l'archivage ou la modification, pas à la création.
  const parsed = parseResourceInput((key) => text(formData, key), {
    allowedStatuses: ['active', 'maintenance'],
  })
  if (!parsed.ok) return { fieldErrors: parsed.errors, values }

  let id: string
  try {
    id = (await createResource(parsed.input)).id
  } catch (error) {
    const fieldErrors = uniquenessFailure(error)
    if (fieldErrors) return { fieldErrors, values }
    throw error
  }

  // Hors du `try` : `redirect` interrompt l'exécution en levant, un `catch`
  // l'avalerait et la page resterait sur le formulaire.
  revalidatePath('/ressources')
  redirect(`/ressources/${id}`)
}

/**
 * Modification d'une ressource (R01) : nom, code, capacité, état, attributs
 * et description. Le type est celui de la ressource en base, jamais celui du
 * formulaire.
 */
export async function updateResourceAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requirePermission('ressources.gerer')
  const id = text(formData, 'id')
  const values = submittedValues(formData)
  const existing = id ? await findResource(id) : undefined
  if (!existing || existing.deletedAt) {
    return { error: 'Cette ressource n’existe pas ou a été archivée.', values }
  }

  const parsed = parseResourceInput((key) => text(formData, key), {
    resourceType: existing.resourceType,
  })
  if (!parsed.ok) return { fieldErrors: parsed.errors, values }

  try {
    const updated = await updateResource(id, parsed.input)
    if (!updated) return { error: 'Cette ressource vient d’être archivée.', values }
  } catch (error) {
    const fieldErrors = uniquenessFailure(error)
    if (fieldErrors) return { fieldErrors, values }
    throw error
  }

  revalidatePath('/ressources')
  revalidatePath(`/ressources/${id}`)
  revalidatePath('/reservations')
  redirect(`/ressources/${id}`)
}

export async function updateResourceStatusAction(formData: FormData): Promise<void> {
  await requirePermission('ressources.gerer')
  const id = text(formData, 'id')
  const status = text(formData, 'status') as ResourceStatus
  if (!id || !resourceStatuses.includes(status)) return
  await updateResourceStatus(id, status)
  revalidatePath('/ressources')
  revalidatePath('/reservations')
}

export async function archiveResourceAction(formData: FormData): Promise<void> {
  await requirePermission('ressources.gerer')
  const id = text(formData, 'id')
  if (!id) return
  await archiveResource(id)
  revalidatePath('/ressources')
  revalidatePath('/reservations')
}
