'use server'

import { revalidatePath } from 'next/cache'

import { PG_OFFER_REQUEST_REFUSED, pgErrorCode } from '../../db/errors.ts'
import { requirePermission } from '../../lib/auth/staff.ts'
import { isUuid } from '../../lib/uuid.ts'
import { DISMISSAL_REASON_MAX_LENGTH, dismissOfferRequest } from './offres-portail.ts'

export type DismissOfferRequestState = { error?: string } | null

/**
 * L'accueil écarte une demande d'offre (ADR 041) : elle sort de la file, sa
 * trace reste, et le client lit le motif dans son historique. Le contrat tiré
 * de l'offre la clôt de son côté (`createContractFromOffer`).
 */
export async function dismissOfferRequestAction(
  _previous: DismissOfferRequestState,
  formData: FormData,
): Promise<DismissOfferRequestState> {
  const { member } = await requirePermission('demandes.traiter')
  const id = String(formData.get('id') ?? '').trim()
  if (!isUuid(id)) return { error: 'Demande introuvable.' }
  const reason = String(formData.get('reason') ?? '').trim()
  if (reason.length > DISMISSAL_REASON_MAX_LENGTH) {
    return { error: `Motif trop long : ${DISMISSAL_REASON_MAX_LENGTH} caractères au plus.` }
  }

  try {
    if (!(await dismissOfferRequest(id, member.id, reason || null))) {
      return { error: 'Cette demande est déjà traitée : rechargez la page.' }
    }
  } catch (error) {
    if (pgErrorCode(error) === PG_OFFER_REQUEST_REFUSED) {
      return { error: 'Cette demande ne peut plus être écartée : rechargez la page.' }
    }
    throw error
  }
  revalidatePath('/demandes')
  revalidatePath('/compte/historique')
  return null
}
