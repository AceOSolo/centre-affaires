'use server'

import { revalidatePath } from 'next/cache'

import { requireClientAccount } from '../clients/session.ts'
import { cancelRequestForAccounts } from './compte-queries.ts'

/** Réponse rendue au bouton, annoncée au lecteur d'écran. */
export type ClientCancelState = { ok?: string; error?: string } | null

/**
 * Annulation d'une demande depuis l'espace client. Revérifie le compte : une
 * action serveur s'invoque depuis n'importe quelle page (ADR 008).
 */
export async function cancelClientRequestAction(
  _previous: ClientCancelState,
  formData: FormData,
): Promise<ClientCancelState> {
  const { accounts } = await requireClientAccount()
  const id = String(formData.get('id') ?? '')

  if (!(await cancelRequestForAccounts(id, accounts))) {
    return {
      error:
        'Cette demande ne peut plus être annulée d’ici : le centre l’a peut-être déjà validée. Contactez-le.',
    }
  }
  // Le créneau redevient libre pour tout le monde.
  revalidatePath('/compte/reservations')
  revalidatePath('/reservations')
  revalidatePath('/demandes')
  revalidatePath('/')
  return { ok: 'Demande annulée. Le créneau est libéré.' }
}
