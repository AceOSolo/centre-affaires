'use server'

import { revalidatePath } from 'next/cache'

import { formatDateTime } from '../../lib/dates.ts'
import { currentTenant } from '../../lib/tenant.ts'
import { requireClientAccount } from '../clients/session.ts'
import { findPortalOffer, recentOfferRequest, requestOffer } from './offres-portail.ts'

/** Réponse rendue au bouton « Demander cette offre », annoncée au lecteur d'écran. */
export type OfferRequestState =
  | { status: 'idle' }
  | { status: 'sent'; message: string }
  | { status: 'error'; message: string; field?: 'clientId' }

/**
 * Demande d'une offre groupée depuis l'espace client (R23, ADR 036), en une
 * action : elle part à l'accueil, qui en tire le contrat. Revérifie le compte
 * (ADR 008) ; l'entreprise doit être l'une du compte, l'offre présentée dans
 * l'espace.
 */
export async function requestOfferAction(
  _previous: OfferRequestState,
  formData: FormData,
): Promise<OfferRequestState> {
  const { accounts } = await requireClientAccount()
  const offerId = String(formData.get('offerId') ?? '')
  const clientId = String(formData.get('clientId') ?? '')
  const account =
    accounts.find((candidate) => candidate.clientId === clientId) ??
    (accounts.length === 1 && !clientId ? accounts[0] : undefined)
  if (!account) {
    return { status: 'error', field: 'clientId', message: 'Choisissez l’entreprise pour laquelle vous demandez l’offre.' }
  }

  const offer = await findPortalOffer(accounts, offerId)
  if (!offer) {
    return { status: 'error', message: 'Cette offre n’est plus proposée. Contactez le centre.' }
  }

  // Une seconde demande ne ferait que doubler le message à l'accueil.
  const previous = await recentOfferRequest(account.clientId, offer.id)
  if (previous) {
    const tenant = await currentTenant()
    return {
      status: 'sent',
      message: `Votre demande du ${formatDateTime(previous, tenant.timezone)} est déjà entre les mains de l’accueil, qui vous recontacte pour établir le contrat.`,
    }
  }

  await requestOffer({ account, offer })
  revalidatePath('/demandes')
  return {
    status: 'sent',
    message: `Demande transmise à l’accueil pour ${account.clientName}. L’équipe vous recontacte pour établir le contrat : rien ne vous engage avant sa signature.`,
  }
}
