'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import { readSenderList } from './expediteurs.ts'
import { saveSenderList } from './expediteurs-queries.ts'

export type SenderListFormState = {
  error?: string
  /** Par champ (`expediteur-<rang>`) : la ligne en cause. */
  fieldErrors?: Record<string, string>
  /** La saisie refusée, rendue à l'écran pour être corrigée plutôt que retapée. */
  values?: string[]
} | null

/**
 * Liste des expéditeurs proposés à la saisie du courrier (ADR 079), réglée
 * par le centre : un réglage de configuration, au droit de la configuration
 * du centre (exploitant, direction ; ADR 019). « Revenir à la liste par
 * défaut » efface le réglage : celle du code et les expéditeurs les plus
 * saisis reviennent.
 */
export async function saveSenderListAction(
  _previous: SenderListFormState,
  formData: FormData,
): Promise<SenderListFormState> {
  await requirePermission('centre.configurer')
  if (String(formData.get('intent') ?? '') === 'retablir') {
    await saveSenderList(null)
    revalidatePath('/courrier', 'layout')
    redirect('/courrier/expediteurs?fait=retablie')
  }
  const lines = formData.getAll('expediteur').map(String)
  const read = readSenderList(lines)
  const fieldErrors = Object.fromEntries(
    Object.entries(read.lineErrors).map(([index, error]) => [`expediteur-${index}`, error]),
  )
  if (read.error || Object.keys(fieldErrors).length > 0) {
    return { error: read.error, fieldErrors, values: lines }
  }
  await saveSenderList(read.list)
  revalidatePath('/courrier', 'layout')
  redirect('/courrier/expediteurs?fait=enregistree')
}
