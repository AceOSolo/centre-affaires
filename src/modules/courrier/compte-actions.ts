'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'

import { requireClientAccount } from '../clients/session.ts'
import { notifyOpeningRequested } from './notifications.ts'
import { cancelOpeningRequest, requestOpening } from './queries.ts'

/**
 * Actions de l'espace client. Chacune revérifie le compte : une action serveur
 * s'invoque par son identifiant depuis n'importe quelle page (ADR 008).
 */
export type RequestState = { ok?: string; error?: string } | null

export async function requestOpeningAction(
  _previous: RequestState,
  formData: FormData,
): Promise<RequestState> {
  const { accounts } = await requireClientAccount()
  const id = String(formData.get('id') ?? '')

  if (!(await requestOpening(id, accounts))) {
    return { error: 'La demande n’a pas pu être enregistrée : ce courrier a peut-être déjà été traité.' }
  }
  after(() => notifyOpeningRequested(id))
  revalidatePath('/compte/courrier')
  // La file « À ouvrir » et le compteur de la navigation du back-office.
  revalidatePath('/courrier')
  return { ok: 'Demande envoyée. Le centre ouvrira ce courrier et vous le mettra à disposition ici.' }
}

export async function cancelOpeningRequestAction(
  _previous: RequestState,
  formData: FormData,
): Promise<RequestState> {
  const { accounts } = await requireClientAccount()
  const id = String(formData.get('id') ?? '')

  if (!(await cancelOpeningRequest(id, accounts))) {
    return { error: 'La demande ne peut plus être annulée : le courrier a peut-être déjà été ouvert.' }
  }
  revalidatePath('/compte/courrier')
  return { ok: 'Demande annulée.' }
}
