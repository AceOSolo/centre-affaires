import {
  findPendingMailRequestId,
  notifyMailReceived,
  notifyMailRequestSubmitted,
  notifyMailScanned as notifyScanned,
} from '../notifications/declencheurs-courrier.ts'

/**
 * Courriels du courrier (ADR 015), envoyés par le moteur de notifications
 * (ADR 038) : modèle du centre ou texte par défaut, préférences des
 * personnes, journal des envois.
 *
 * Ils préviennent, ils ne transportent pas : ni le document, ni l'expéditeur
 * n'y figurent. Un courriel se transfère, s'archive chez un tiers et échappe
 * au journal d'accès ; le contenu reste dans l'espace client.
 *
 * Les textes sont dans `notifications/catalogue.ts`, les déclencheurs dans
 * `notifications/declencheurs-courrier.ts`. Ces fonctions gardent les noms
 * qu'appellent les actions du courrier ; aucune ne lève.
 */

/** Arrivée d'un pli : aux personnes de l'entreprise, inscrites ou déjà connectées. */
export async function notifyMailRegistered(mailItemId: string): Promise<void> {
  await notifyMailReceived(mailItemId)
}

export async function notifyMailScanned(mailItemId: string): Promise<void> {
  await notifyScanned(mailItemId)
}

/** Demande d'ouverture : à l'adresse du centre, quand il en a une. */
export async function notifyOpeningRequested(mailItemId: string): Promise<void> {
  try {
    const requestId = await findPendingMailRequestId(mailItemId, 'open_and_scan')
    if (requestId) await notifyMailRequestSubmitted(requestId)
  } catch (error) {
    console.error('Notification de demande d’ouverture impossible', error)
  }
}
