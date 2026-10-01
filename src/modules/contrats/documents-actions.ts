'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import { isUuid } from '../../lib/uuid.ts'
import { establishContractDocument } from './documents.ts'

export type DocumentFormState = { error?: string } | null

/**
 * Établit le document d'un contrat engagé qui n'en a pas : activé avant les
 * documents (vague 1) ou repris. L'instantané est archivé avec son empreinte,
 * comme à l'activation (ADR 025). Droit des avenants : « éditer les documents
 * de contrat ».
 */
export async function establishContractDocumentAction(
  _previous: DocumentFormState,
  formData: FormData,
): Promise<DocumentFormState> {
  const { member } = await requirePermission('contrats.avenants')
  const id = String(formData.get('id') ?? '')
  if (!isUuid(id)) return { error: 'Contrat introuvable.' }

  const document = await establishContractDocument(id, member.id)
  if (!document) {
    return { error: 'Ce contrat a déjà son document, ou n’est encore qu’un brouillon.' }
  }

  revalidatePath(`/contrats/${id}`)
  redirect(`/contrats/${id}?fait=document`)
}
