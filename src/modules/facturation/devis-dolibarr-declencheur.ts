import { revalidatePath } from 'next/cache'

import { pushReadyProposals } from './devis-dolibarr-envoi.ts'

/**
 * Envoie au CRM les devis « prêts », après la réponse faite à l'utilisateur
 * (`after()`, ADR 073). À appeler quand une action vient de produire un devis
 * « prêt » : demande publique, demande de l'espace client, devis validé par
 * l'accueil. Sans effet si le centre n'a pas demandé l'envoi des devis.
 *
 * Ne lève jamais : l'envoi est une suite de la demande, pas une condition. Un
 * devis qui n'est pas parti reste « prêt » ; la tâche de reprise
 * (`/api/maintenance/devis-dolibarr`) le renverra.
 */
export async function sendReadyProposalsToDolibarr(): Promise<void> {
  try {
    const report = await pushReadyProposals()
    if (report.sent > 0) revalidatePath('/devis')
  } catch (error) {
    console.error('Envoi des devis à Dolibarr :', error)
  }
}
