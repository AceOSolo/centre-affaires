'use server'

import { requirePermission } from '../../lib/auth/staff.ts'
import { sendMessage } from '../../lib/courriel.ts'
import { currentTenant } from '../../lib/tenant.ts'

/*
 * Essai d'envoi de l'encart « Courriels » (Réglages, ADR 059). Réservé à qui
 * configure le centre (`centre.configurer`) : la vérification de l'envoi
 * accompagne la pose des variables SMTP sur le serveur.
 */

export type TestEmailState =
  | { status: 'sent'; to: string }
  | { status: 'failed'; to: string; error: string }
  | { status: 'not_configured' }
  | null

/**
 * Envoie un message d'essai à l'adresse du membre connecté — la sienne, jamais
 * une adresse saisie : l'essai ne peut pas servir à écrire à n'importe qui.
 * L'issue est rendue à l'écran ; un essai n'est pas un message du centre et
 * n'entre pas au journal.
 */
export async function sendTestEmailAction(): Promise<TestEmailState> {
  const { member } = await requirePermission('centre.configurer')
  const tenant = await currentTenant()
  const result = await sendMessage({
    to: [member.email],
    subject: `Essai d’envoi — ${tenant.name}`,
    text:
      `Bonjour,\n\nCe message d’essai a été demandé depuis Réglages, encart « Courriels », du back-office de ${tenant.name}.` +
      '\n\nS’il vous parvient, les courriels de l’application partent bien : demandes, courrier, invitations à l’espace client.' +
      '\n\nVérifiez aussi qu’il n’est pas arrivé dans les indésirables : sinon, authentifiez le domaine de l’expéditeur chez Brevo.',
  })
  switch (result.status) {
    case 'sent':
      return { status: 'sent', to: member.email }
    case 'failed':
      return { status: 'failed', to: member.email, error: result.error ?? 'Envoi refusé par le serveur SMTP.' }
    case 'not_configured':
      return { status: 'not_configured' }
    case 'no_recipient':
      return { status: 'failed', to: member.email, error: 'Votre fiche d’équipe n’a pas d’adresse de courriel.' }
  }
}
