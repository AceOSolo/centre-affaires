import { appUrl, sendMessage, type Message } from '../../lib/courriel.ts'
import { currentTenant } from '../../lib/tenant.ts'
import { findClient } from './queries.ts'

/**
 * Courriel envoyé à une personne que le centre vient d'inscrire sur une fiche
 * client (ADR 015) : elle apprend que l'accès existe et comment l'activer.
 */
export function invitationMessage(facts: {
  centreName: string
  clientName: string
  email: string
  link?: string
}): Omit<Message, 'to'> {
  return {
    subject: `Votre espace client ${facts.centreName}`,
    text:
      `Bonjour,\n\n${facts.centreName} vous a ouvert un accès à l’espace client de ${facts.clientName} : ` +
      'le courrier reçu à son nom, et ses réservations.\n\n' +
      `Pour l’activer, créez votre accès avec cette adresse (${facts.email}) ` +
      'depuis la page de connexion, puis confirmez-la.' +
      (facts.link ? `\n\n${facts.link}` : '') +
      '\n\nSi vous n’attendiez pas ce message, ignorez-le : rien n’est ouvert tant que l’adresse n’est pas confirmée.' +
      `\n\n—\n${facts.centreName}`,
  }
}

export async function sendInvitation(clientId: string, email: string): Promise<void> {
  try {
    const [client, tenant] = await Promise.all([findClient(clientId), currentTenant()])
    if (!client) return
    await sendMessage({
      to: [email],
      ...invitationMessage({
        centreName: tenant.name,
        clientName: client.name,
        email,
        link: appUrl('/auth/connexion'),
      }),
    })
  } catch (error) {
    console.error('Invitation à l’espace client impossible', error)
  }
}
