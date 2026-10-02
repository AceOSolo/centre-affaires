import { formatDateTime } from '../../lib/dates.ts'
import { appUrl, sendMessage, type Message } from '../../lib/courriel.ts'
import { currentTenant } from '../../lib/tenant.ts'
import { listClientMemberEmails } from '../clients/comptes.ts'
import { findMailRequest } from './demandes-queries.ts'
import { mailRequestKindLabels } from './labels.ts'
import type { MailRequestKind } from './schema.ts'

/**
 * Courriels des demandes sur un pli (R21, R26, ADR 037, ADR 038) : dépôt
 * d'une numérisation ou d'une réexpédition (au centre), réexpédition faite et
 * refus (au client). La numérisation faite et la demande d'ouverture passent
 * par les envois existants (`notifications.ts`).
 *
 * Même règle que le reste du courrier (ADR 015) : un courriel prévient, il ne
 * transporte rien — ni document, ni expéditeur, ni adresse de réexpédition,
 * ni motif de refus. Tout se lit dans l'espace, derrière la connexion.
 *
 * Événements du journal (ADR 038) : `mail_request_submitted`,
 * `mail_request_done`, `mail_request_refused`. Les textes sont des fonctions
 * pures ; les `notify…` chargent la demande et envoient, sans jamais lever.
 */

type RequestFacts = {
  centreName: string
  clientName: string
  kind: MailRequestKind
  receivedAt: Date
  timeZone: string
  link?: string
}

const signature = (centreName: string) => `\n\n—\n${centreName}`
const linkLine = (link: string | undefined, label: string) => (link ? `\n\n${label} : ${link}` : '')
/** « demande de numérisation », « demande d’ouverture et de numérisation ». */
const requestOf: Record<MailRequestKind, string> = {
  open_and_scan: 'd’ouverture et de numérisation',
  scan: 'de numérisation',
  forward: 'de réexpédition',
}

/** « demande la numérisation du courrier ». */
const theAct: Record<MailRequestKind, string> = {
  open_and_scan: 'l’ouverture et la numérisation',
  scan: 'la numérisation',
  forward: 'la réexpédition',
}

/** Au centre : une demande déposée depuis l'espace client. */
export function mailRequestSubmittedMessage(
  facts: RequestFacts & { requestedBy: string | null },
): Omit<Message, 'to'> {
  return {
    subject: `${mailRequestKindLabels[facts.kind]} de courrier demandée — ${facts.clientName}`,
    text:
      `${facts.requestedBy ?? 'Le client'} demande ${theAct[facts.kind]} du courrier ` +
      `reçu le ${formatDateTime(facts.receivedAt, facts.timeZone)} pour ${facts.clientName}.` +
      linkLine(facts.link, 'Traiter la demande') +
      signature(facts.centreName),
  }
}

/** Au client : son pli est parti à l'adresse de sa demande. */
export function mailForwardedMessage(facts: RequestFacts & { forwardedAt: Date }): Omit<Message, 'to'> {
  return {
    subject: `Votre courrier a été réexpédié — ${facts.clientName}`,
    text:
      `Bonjour,\n\nLe courrier reçu le ${formatDateTime(facts.receivedAt, facts.timeZone)} ` +
      `pour ${facts.clientName} a été réexpédié le ${formatDateTime(facts.forwardedAt, facts.timeZone)}, ` +
      'à l’adresse indiquée dans votre demande. Le numéro de suivi, quand il y en a un, figure dans votre espace client.' +
      linkLine(facts.link, 'Vos demandes') +
      signature(facts.centreName),
  }
}

/** Au client : le centre n'a pas donné suite. Le motif reste dans l'espace. */
export function mailRequestRefusedMessage(facts: RequestFacts): Omit<Message, 'to'> {
  return {
    subject: `Votre demande ${requestOf[facts.kind]} n’a pas pu être traitée — ${facts.clientName}`,
    text:
      `Bonjour,\n\nLe centre n’a pas pu donner suite à votre demande ${requestOf[facts.kind]} ` +
      `pour le courrier reçu le ${formatDateTime(facts.receivedAt, facts.timeZone)} (${facts.clientName}). ` +
      'Le motif est indiqué dans votre espace client.' +
      linkLine(facts.link, 'Vos demandes') +
      signature(facts.centreName),
  }
}

async function load(requestId: string) {
  const [request, tenant] = await Promise.all([findMailRequest(requestId), currentTenant()])
  // Pli retiré entre-temps : il n'est plus dans l'espace du client, on se tait.
  if (!request || request.mailDeletedAt) return undefined
  return { request, tenant }
}

/** Dépôt d'une numérisation ou d'une réexpédition : à l'adresse du centre, quand il en a une. */
export async function notifyMailRequestSubmitted(requestId: string): Promise<void> {
  try {
    const loaded = await load(requestId)
    if (!loaded || !loaded.tenant.email) return
    const { request, tenant } = loaded
    await sendMessage({
      to: [tenant.email as string],
      ...mailRequestSubmittedMessage({
        centreName: tenant.name,
        clientName: request.clientName,
        kind: request.kind,
        receivedAt: request.mailReceivedAt,
        timeZone: tenant.timezone,
        link: appUrl(`/courrier/${request.mailItemId}`),
        requestedBy: request.requestedByName,
      }),
    })
  } catch (error) {
    console.error('Notification de demande de courrier impossible', error)
  }
}

/** Réexpédition faite : aux personnes de l'entreprise. */
export async function notifyMailForwarded(requestId: string): Promise<void> {
  try {
    const loaded = await load(requestId)
    if (!loaded) return
    const { request, tenant } = loaded
    if (request.status !== 'done' || !request.completedAt) return
    await sendMessage({
      to: await listClientMemberEmails(request.clientId),
      ...mailForwardedMessage({
        centreName: tenant.name,
        clientName: request.clientName,
        kind: request.kind,
        receivedAt: request.mailReceivedAt,
        timeZone: tenant.timezone,
        forwardedAt: request.completedAt,
        link: appUrl('/compte/courrier/demandes'),
      }),
    })
  } catch (error) {
    console.error('Notification de réexpédition impossible', error)
  }
}

/** Refus : aux personnes de l'entreprise, sans le motif. */
export async function notifyMailRequestRefused(requestId: string): Promise<void> {
  try {
    const loaded = await load(requestId)
    if (!loaded || loaded.request.status !== 'refused') return
    const { request, tenant } = loaded
    await sendMessage({
      to: await listClientMemberEmails(request.clientId),
      ...mailRequestRefusedMessage({
        centreName: tenant.name,
        clientName: request.clientName,
        kind: request.kind,
        receivedAt: request.mailReceivedAt,
        timeZone: tenant.timezone,
        link: appUrl('/compte/courrier/demandes'),
      }),
    })
  } catch (error) {
    console.error('Notification de refus de demande impossible', error)
  }
}
