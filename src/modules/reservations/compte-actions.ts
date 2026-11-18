'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'

import { requireClientAccount } from '../clients/session.ts'
import { notifyBookingCancelledByClient } from '../notifications/declencheurs-reservations-client.ts'
import { syncBookingToGoogleCalendar, syncBookingsToGoogleCalendar } from './agenda-google-queries.ts'
import { cancelForAccounts } from './compte-queries.ts'

/** Réponse rendue au bouton, annoncée au lecteur d'écran. */
export type ClientCancelState = { ok?: string; error?: string } | null

/**
 * Annulation d'une demande ou d'une réservation depuis l'espace client, dans
 * le délai du centre (ADR 076). Revérifie le compte : une action serveur
 * s'invoque depuis n'importe quelle page (ADR 008).
 */
export async function cancelClientRequestAction(
  _previous: ClientCancelState,
  formData: FormData,
): Promise<ClientCancelState> {
  const { accounts } = await requireClientAccount()
  const id = String(formData.get('id') ?? '')

  const outcome = await cancelForAccounts(id, accounts)
  if (!outcome.ok) return { error: outcome.message }

  // L'accueil est prévenu ; une réservation confirmée sort de l'agenda Google
  // de la ressource (ADR 014), avec son matériel en option.
  after(() => notifyBookingCancelledByClient(id, outcome.memberId, outcome.wasConfirmed))
  if (outcome.wasConfirmed) after(() => syncBookingToGoogleCalendar(id))
  if (outcome.optionIds.length > 0) after(() => syncBookingsToGoogleCalendar(outcome.optionIds))
  // Le créneau redevient libre pour tout le monde.
  revalidatePath('/compte/reservations', 'layout')
  revalidatePath('/reservations', 'layout')
  revalidatePath('/demandes')
  revalidatePath('/devis')
  revalidatePath('/')
  return {
    ok: outcome.wasConfirmed ? 'Réservation annulée. Le créneau est libéré.' : 'Demande annulée. Le créneau est libéré.',
  }
}
