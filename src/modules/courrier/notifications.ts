import {
  findPendingMailRequestId,
  notifyMailReceived,
  notifyMailRequestDone as notifyRequestDone,
  notifyMailRequestRefused as notifyRequestRefused,
  notifyMailRequestSubmitted as notifyRequestSubmitted,
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
    if (requestId) await notifyRequestSubmitted(requestId)
  } catch (error) {
    console.error('Notification de demande d’ouverture impossible', error)
  }
}

/**
 * Demande de numérisation ou de réexpédition déposée depuis l'espace client
 * (ADR 037) : à l'adresse du centre.
 */
export async function notifyMailRequestSubmitted(mailRequestId: string): Promise<void> {
  await notifyRequestSubmitted(mailRequestId)
}

/**
 * Numérisation ou réexpédition faite par l'accueil (ADR 037) : aux personnes
 * de l'entreprise, avec le numéro de suivi d'une réexpédition. Une demande
 * d'ouverture faite ne passe pas ici : l'ouverture prévient déjà par
 * « courrier numérisé ».
 */
export async function notifyMailRequestDone(mailRequestId: string): Promise<void> {
  await notifyRequestDone(mailRequestId)
}

/** Demande refusée par l'accueil (ADR 037) : aux personnes de l'entreprise. */
export async function notifyMailRequestRefused(mailRequestId: string): Promise<void> {
  await notifyRequestRefused(mailRequestId)
}
