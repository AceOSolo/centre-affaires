'use server'

import { revalidatePath } from 'next/cache'

import { requirePermission } from '../../lib/auth/staff.ts'
import { readClientBellSettingsForm } from './cloche-client.ts'
import { saveClientBellSettings } from './cloche-client-queries.ts'

/**
 * Réglage de la cloche de l'espace client (ADR 077), par centre : les
 * nouveautés qu'elle annonce et combien de jours elle les garde. Droit
 * `notifications.gerer`, celui des modèles des messages aux clients : ce que
 * le centre dit à ses clients, et comment.
 */
export type ClientBellSettingsFormState = { saved?: boolean; errors?: { windowDays?: string } } | null

export async function saveClientBellSettingsAction(
  _previous: ClientBellSettingsFormState,
  formData: FormData,
): Promise<ClientBellSettingsFormState> {
  const { member } = await requirePermission('notifications.gerer')
  const read = readClientBellSettingsForm(formData)
  if (read.errors) return { errors: read.errors }
  await saveClientBellSettings(read.settings, member.id)
  revalidatePath('/notifications/cloche-client')
  return { saved: true }
}
