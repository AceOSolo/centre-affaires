'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { isUuid } from '../../lib/uuid.ts'
import { requireClientAccount } from '../clients/session.ts'
import { inspectionRefusalMessage } from './erreurs.ts'
import { signInspection } from './queries.ts'

/** Réserves du client : quelques lignes, pas un second état des lieux. */
const MAX_REMARKS = 2000

export type SignState = { error?: string; fieldErrors?: Record<string, string>; remarks?: string } | null

/**
 * Validation d'un état des lieux clos depuis l'espace client (ADR 039) : la
 * personne connectée, au titre de l'entreprise de l'état des lieux ; la date
 * est posée par la base. Le compte est revérifié ici (ADR 008, 015).
 */
export async function signInspectionAction(
  _previous: SignState,
  formData: FormData,
): Promise<SignState> {
  const { accounts } = await requireClientAccount()
  const id = String(formData.get('id') ?? '').trim()
  const remarks = String(formData.get('remarks') ?? '').trim()
  if (!isUuid(id)) return { error: 'État des lieux introuvable.' }
  if (remarks.length > MAX_REMARKS) {
    return {
      fieldErrors: { remarks: 'Vos réserves comptent 2 000 caractères au plus.' },
      remarks,
    }
  }

  let outcome
  try {
    outcome = await signInspection(id, accounts, remarks || null)
  } catch (error) {
    const message = inspectionRefusalMessage(error)
    if (!message) throw error
    return { error: message, remarks }
  }
  if (outcome === 'not_found') return { error: 'État des lieux introuvable.' }
  if (outcome === 'already_signed') {
    return { error: 'Cet état des lieux a déjà été validé. Rechargez la page.' }
  }

  revalidatePath('/compte/etats-des-lieux')
  revalidatePath(`/compte/etats-des-lieux/${id}`)
  redirect(`/compte/etats-des-lieux/${id}?fait=valide`)
}
