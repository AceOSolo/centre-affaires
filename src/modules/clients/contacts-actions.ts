'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requireStaff } from '../../lib/auth/staff.ts'
import { isUuid } from '../../lib/uuid.ts'
import {
  ContactClientUnavailableError,
  PrimaryContactConflictError,
  createClientContact,
  removeClientContact,
  updateClientContact,
} from './contacts-queries.ts'
import { readContactForm, type ContactFieldErrors, type ContactValues } from './contacts-regles.ts'

export type ContactFormState = {
  fieldErrors?: ContactFieldErrors
  /** Échec qui ne tient à aucun champ : fiche archivée, contact retiré entre-temps. */
  message?: string
  values?: ContactValues
} | null

/**
 * Ajout ou modification d'un contact, selon que le formulaire porte un `id`.
 *
 * Le succès ramène sur la fiche client, qui l'annonce : la liste des contacts
 * à jour est la meilleure confirmation.
 */
export async function saveClientContactAction(
  _previous: ContactFormState,
  formData: FormData,
): Promise<ContactFormState> {
  // Contrôle d'accès dans l'action elle-même (ADR 008).
  await requireStaff()
  const clientId = String(formData.get('clientId') ?? '')
  const id = String(formData.get('id') ?? '') || null
  if (!isUuid(clientId) || (id !== null && !isUuid(id))) {
    return { message: 'Contact ou fiche client introuvable.' }
  }

  const read = readContactForm(formData)
  if (read.fieldErrors) return { fieldErrors: read.fieldErrors, values: read.values }

  try {
    if (id) {
      const updated = await updateClientContact(clientId, id, read.input)
      if (!updated) {
        return { message: 'Ce contact a été retiré de la fiche entre-temps.', values: read.values }
      }
    } else {
      await createClientContact(clientId, read.input)
    }
  } catch (error) {
    if (
      error instanceof PrimaryContactConflictError ||
      error instanceof ContactClientUnavailableError
    ) {
      return { message: error.message, values: read.values }
    }
    throw error
  }

  revalidatePath(`/clients/${clientId}`)
  redirect(`/clients/${clientId}?contact=${id ? 'modifie' : 'ajoute'}`)
}

/** Retrait logique d'un contact (décision 6). */
export async function removeClientContactAction(formData: FormData): Promise<void> {
  await requireStaff()
  const clientId = String(formData.get('clientId') ?? '')
  const id = String(formData.get('id') ?? '')
  if (!isUuid(clientId) || !isUuid(id)) return

  let removed = false
  try {
    removed = await removeClientContact(clientId, id)
  } catch (error) {
    // Fiche archivée entre l'affichage et l'envoi : rien n'est retiré, la fiche
    // le montre.
    if (!(error instanceof ContactClientUnavailableError)) throw error
  }

  revalidatePath(`/clients/${clientId}`)
  // N'annonce le retrait que s'il a eu lieu : un double envoi ne dit pas
  // « retiré » pour un contact qui l'était déjà.
  redirect(removed ? `/clients/${clientId}?contact=retire` : `/clients/${clientId}`)
}
