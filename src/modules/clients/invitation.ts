import { notifyMemberInvited } from '../notifications/declencheurs-clients.ts'

/**
 * Courriel envoyé à une personne que le centre vient d'inscrire sur une fiche
 * client (ADR 015) : elle apprend que l'accès existe et comment l'activer.
 *
 * Envoyé par le moteur de notifications (ADR 038), événement
 * `member_invited` : modèle du centre ou texte par défaut
 * (`notifications/catalogue.ts`), journal des envois. Ne lève jamais.
 */
export async function sendInvitation(clientId: string, email: string): Promise<void> {
  await notifyMemberInvited(clientId, email)
}
