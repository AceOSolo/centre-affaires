/**
 * Règles du message groupé aux clients (ADR 060), sans base ni framework :
 * lecture du formulaire, paquets d'envoi, bilan d'un envoi. Éprouvées seules
 * (`diffusion-regles.test.ts`). Le formulaire du navigateur les charge sans
 * tirer le schéma de la base, qui en reprend les listes
 * (`schema-diffusion.ts`).
 */

/**
 * À qui s'adresse le message :
 *
 * - `domiciliation` : contrat de domiciliation en cours ;
 * - `bureaux` : contrat de bureau ou de coworking en cours ;
 * - `selection` : entreprises cochées une à une.
 *
 * Salles et camion n'ont pas de clientèle « en cours » (location ponctuelle) :
 * on les atteint par la sélection.
 */
export const broadcastTargets = ['domiciliation', 'bureaux', 'selection'] as const
export type BroadcastTarget = (typeof broadcastTargets)[number]

/**
 * Issue de l'envoi à une entreprise : `pending` tant que son paquet n'est pas
 * parti, puis celle que le moteur a inscrite au journal (`sent`, `failed`,
 * `not_configured`, `skipped`).
 */
export const broadcastRecipientStatuses = ['pending', 'sent', 'failed', 'not_configured', 'skipped'] as const
export type BroadcastRecipientStatus = (typeof broadcastRecipientStatuses)[number]

/** Longueurs maximales de l'objet et du texte, vérifiées aussi par la base. */
export const BROADCAST_SUBJECT_MAX = 150
export const BROADCAST_BODY_MAX = 5000

/**
 * Entreprises servies par paquet, et pause entre deux paquets : Brevo limite
 * le débit et, selon le forfait, le nombre de courriels par jour. Chaque
 * entreprise reçoit un exemplaire par personne de son espace : un paquet fait
 * de 25 à une centaine de courriels.
 */
export const BROADCAST_BATCH_SIZE = 25
export const BROADCAST_BATCH_PAUSE_MS = 2_000

/**
 * Un paquet pris par un envoi qui ne s'est pas terminé (serveur redémarré)
 * se reprend passé ce délai ; un paquet vivant met bien moins à partir.
 */
export const BROADCAST_STALE_MINUTES = 10

/** Une sélection manuelle ne dépasse pas la clientèle d'un centre. */
export const BROADCAST_SELECTION_MAX = 500

export const broadcastTargetLabels: Record<BroadcastTarget, string> = {
  domiciliation: 'Tous les domiciliés',
  bureaux: 'Tous les clients des bureaux',
  selection: 'Une sélection de clients',
}

export const broadcastTargetDescriptions: Record<BroadcastTarget, string> = {
  domiciliation: 'Entreprises qui ont un contrat de domiciliation en cours aujourd’hui.',
  bureaux: 'Entreprises qui ont un contrat de bureau ou de coworking en cours aujourd’hui.',
  selection: 'Les entreprises que vous cochez dans la liste.',
}

export const broadcastRecipientStatusLabels: Record<BroadcastRecipientStatus, string> = {
  pending: 'En attente',
  sent: 'Envoyé',
  failed: 'Échec',
  not_configured: 'Non envoyé : SMTP non configuré',
  skipped: 'Non envoyé',
}

export type BroadcastInput = {
  target: BroadcastTarget
  /** Entreprises cochées, pour une sélection ; vide sinon. */
  clientIds: string[]
  subject: string
  body: string
}

export type BroadcastField = 'target' | 'clients' | 'subject' | 'body'
export type BroadcastErrors = Partial<Record<BroadcastField, string>>

/** Espaces resserrés, sur une ligne : l'objet d'un courriel. */
function cleanSubject(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Fins de ligne unifiées, blancs de fin retirés : le texte d'un courriel. */
function cleanBody(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()
}

export function isBroadcastTarget(value: unknown): value is BroadcastTarget {
  return typeof value === 'string' && (broadcastTargets as readonly string[]).includes(value)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Le message saisi, nettoyé et vérifié. Les accolades doubles sont refusées :
 * le texte est inséré tel quel dans le modèle, une variable écrite à la main
 * partirait telle quelle chez le client.
 */
export function readBroadcastInput(form: {
  target: unknown
  clientIds: readonly unknown[]
  subject: unknown
  body: unknown
}): { input: BroadcastInput; errors: BroadcastErrors } {
  const target = isBroadcastTarget(form.target) ? form.target : undefined
  const subject = cleanSubject(String(form.subject ?? ''))
  const body = cleanBody(String(form.body ?? ''))
  const clientIds =
    target === 'selection'
      ? [...new Set(form.clientIds.map(String).filter((id) => UUID.test(id)))]
      : []
  const errors: BroadcastErrors = {}

  if (!target) errors.target = 'Choisissez à qui envoyer le message.'
  if (target === 'selection' && clientIds.length === 0) errors.clients = 'Cochez au moins une entreprise.'
  else if (clientIds.length > BROADCAST_SELECTION_MAX) {
    errors.clients = `${BROADCAST_SELECTION_MAX} entreprises au plus par message.`
  }

  if (subject === '') errors.subject = 'Saisissez l’objet du message.'
  else if (subject.length > BROADCAST_SUBJECT_MAX) {
    errors.subject = `L’objet dépasse ${BROADCAST_SUBJECT_MAX} caractères (${subject.length}).`
  } else if (subject.includes('{{') || subject.includes('}}')) {
    errors.subject = 'L’objet ne peut pas contenir de doubles accolades.'
  }

  if (body === '') errors.body = 'Saisissez le texte du message.'
  else if (body.length > BROADCAST_BODY_MAX) {
    errors.body = `Le texte dépasse ${BROADCAST_BODY_MAX.toLocaleString('fr-FR')} caractères (${body.length.toLocaleString('fr-FR')}).`
  } else if (body.includes('{{') || body.includes('}}')) {
    errors.body = 'Le texte ne peut pas contenir de doubles accolades.'
  }

  return { input: { target: target ?? 'domiciliation', clientIds, subject, body }, errors }
}

/** Ce que l'aperçu dit des destinataires, avant confirmation. */
export type BroadcastAudience = {
  /** Entreprises visées. */
  companies: number
  /** Personnes de leur espace client qui recevront le message. */
  people: number
  /** Personnes qui ont décoché « Informations du centre ». */
  renounced: number
  /** Entreprises sans personne qui le recevra : aucun accès, ou tous ont décoché. */
  unreached: number
}

/** Phrase de confirmation : « 12 entreprises, 18 personnes ». */
export function audiencePhrase(audience: Pick<BroadcastAudience, 'companies' | 'people'>): string {
  const companies = `${audience.companies} entreprise${audience.companies > 1 ? 's' : ''}`
  const people = `${audience.people} personne${audience.people > 1 ? 's' : ''}`
  return `${companies}, ${people}`
}

/** Bilan d'un envoi, compté sur les entreprises visées. */
export type BroadcastTally = {
  companies: number
  pending: number
  sent: number
  failed: number
  notConfigured: number
  skipped: number
  /** Adresses servies et adresses refusées par le serveur SMTP. */
  addresses: number
  failedAddresses: number
}

export const emptyTally = (): BroadcastTally => ({
  companies: 0,
  pending: 0,
  sent: 0,
  failed: 0,
  notConfigured: 0,
  skipped: 0,
  addresses: 0,
  failedAddresses: 0,
})

/** Additionne les lignes d'un envoi, groupées par issue. */
export function tallyOf(
  rows: readonly { status: BroadcastRecipientStatus; companies: number; addresses: number; failedAddresses: number }[],
): BroadcastTally {
  const tally = emptyTally()
  for (const row of rows) {
    tally.companies += row.companies
    tally.addresses += row.addresses
    tally.failedAddresses += row.failedAddresses
    if (row.status === 'pending') tally.pending += row.companies
    else if (row.status === 'sent') tally.sent += row.companies
    else if (row.status === 'failed') tally.failed += row.companies
    else if (row.status === 'not_configured') tally.notConfigured += row.companies
    else tally.skipped += row.companies
  }
  return tally
}

/**
 * Où en est l'envoi : en cours, interrompu (rien n'a bougé depuis le délai
 * de reprise), ou terminé.
 */
export function broadcastProgress(
  tally: Pick<BroadcastTally, 'pending'>,
  lastActivity: Date | null,
  now: Date,
): 'done' | 'running' | 'stalled' {
  if (tally.pending === 0) return 'done'
  if (!lastActivity) return 'stalled'
  return now.getTime() - lastActivity.getTime() > BROADCAST_STALE_MINUTES * 60_000 ? 'stalled' : 'running'
}
