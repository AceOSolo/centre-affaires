'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import { isUuid } from '../../lib/uuid.ts'
import {
  ArchivedServiceError,
  DuplicateServiceCodeError,
  archiveService,
  createService,
  findService,
  updateService,
} from './services-queries.ts'
import { readServiceForm, type ServiceFieldErrors, type ServiceValues } from './services-regles.ts'

export type ServiceFormState = {
  fieldErrors?: ServiceFieldErrors
  /** Échec qui ne tient à aucun champ : service archivé entre-temps. */
  message?: string
  values?: ServiceValues
} | null

/**
 * Création ou modification d'un service du catalogue, selon que le formulaire
 * porte un `id`. Réservé à l'exploitant : un service engage un prix (ADR 024).
 */
export async function saveServiceAction(
  _previous: ServiceFormState,
  formData: FormData,
): Promise<ServiceFormState> {
  // Contrôle d'accès dans l'action elle-même : une action serveur s'invoque
  // par son identifiant depuis n'importe quel chemin (ADR 008, ADR 019).
  await requirePermission('services.gerer')
  const id = String(formData.get('id') ?? '') || null
  if (id !== null && !isUuid(id)) return { message: 'Service introuvable.' }

  const existing = id ? await findService(id) : undefined
  if (id && !existing) return { message: 'Service introuvable.' }

  const read = readServiceForm(formData, existing ?? undefined)
  if (read.fieldErrors) return { fieldErrors: read.fieldErrors, values: read.values }

  let savedId = id
  try {
    if (id) await updateService(id, read.input)
    else savedId = (await createService(read.input)).id
  } catch (error) {
    if (error instanceof DuplicateServiceCodeError) {
      return { fieldErrors: { code: error.message }, values: read.values }
    }
    if (error instanceof ArchivedServiceError) return { message: error.message, values: read.values }
    throw error
  }

  revalidatePath('/services')
  redirect(`/services/${savedId}?enregistre=${id ? 'modifie' : 'cree'}`)
}

/** Archivage d'un service (décision 6). */
export async function archiveServiceAction(formData: FormData): Promise<void> {
  await requirePermission('services.gerer')
  const id = String(formData.get('id') ?? '')
  if (!isUuid(id)) return
  await archiveService(id)
  revalidatePath('/services')
  redirect(`/services/${id}?enregistre=archive`)
}
