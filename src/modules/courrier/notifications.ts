import { formatDateTime } from '../../lib/dates.ts'
import { appUrl, sendMessage, type Message } from '../../lib/courriel.ts'
import { currentTenant } from '../../lib/tenant.ts'
import { listClientMemberEmails } from '../clients/comptes.ts'
import { mailKindLabels } from './labels.ts'
import { findMail } from './queries.ts'
import type { MailKind } from './schema.ts'

/**
 * Courriels du courrier (ADR 015).
 *
 * Ils préviennent, ils ne transportent pas : ni le document, ni l'expéditeur
 * n'y figurent. Un courriel se transfère, s'archive chez un tiers et échappe
 * au journal d'accès ; le contenu reste dans l'espace client.
 *
 * Les textes sont construits par des fonctions pures, éprouvées seules ; les
 * `notify…` chargent les données et envoient, sans jamais lever.
 */

type MailFacts = {
  centreName: string
  clientName: string
  kind: MailKind
  receivedAt: Date
  timeZone: string
  link?: string
}

const signature = (centreName: string) => `\n\n—\n${centreName}`
const linkLine = (link: string | undefined, label: string) => (link ? `\n\n${label} : ${link}` : '')

export function mailArrivedMessage(facts: MailFacts & { opened: boolean }): Omit<Message, 'to'> {
  const kind = mailKindLabels[facts.kind].toLowerCase()
  return {
    subject: facts.opened
      ? `Nouveau courrier numérisé pour ${facts.clientName}`
      : `Nouveau courrier pour ${facts.clientName}`,
    text:
      `Bonjour,\n\nUn courrier (${kind}) est arrivé au centre pour ${facts.clientName}, ` +
      `le ${formatDateTime(facts.receivedAt, facts.timeZone)}.\n\n` +
      (facts.opened
        ? 'Il a été ouvert et numérisé : vous pouvez le lire dans votre espace client.'
        : 'Vous pouvez le voir dans votre espace client et, si vous le souhaitez, en demander l’ouverture et la numérisation.') +
      linkLine(facts.link, 'Votre boîte aux lettres') +
      '\n\nPar confidentialité, ce message ne contient pas le document.' +
      signature(facts.centreName),
  }
}

export function mailScannedMessage(facts: MailFacts): Omit<Message, 'to'> {
  return {
    subject: `Votre courrier a été numérisé — ${facts.clientName}`,
    text:
      `Bonjour,\n\nLe courrier reçu le ${formatDateTime(facts.receivedAt, facts.timeZone)} ` +
      `pour ${facts.clientName} a été ouvert et numérisé. Vous pouvez le lire dans votre espace client.` +
      linkLine(facts.link, 'Votre boîte aux lettres') +
      '\n\nPar confidentialité, ce message ne contient pas le document.' +
      signature(facts.centreName),
  }
}

export function openingRequestedMessage(
  facts: MailFacts & { requestedBy: string | null },
): Omit<Message, 'to'> {
  return {
    subject: `Demande d’ouverture de courrier — ${facts.clientName}`,
    text:
      `${facts.requestedBy ?? 'Le client'} demande l’ouverture et la numérisation du courrier ` +
      `reçu le ${formatDateTime(facts.receivedAt, facts.timeZone)} pour ${facts.clientName}.` +
      linkLine(facts.link, 'Traiter la demande') +
      signature(facts.centreName),
  }
}

/** Charge le pli et le centre ; `undefined` si le pli a disparu entre-temps. */
async function load(mailItemId: string) {
  const [mail, tenant] = await Promise.all([findMail(mailItemId), currentTenant()])
  if (!mail || mail.deletedAt) return undefined
  return { mail, tenant }
}

/** Arrivée d'un pli : aux personnes de l'entreprise, inscrites ou déjà connectées. */
export async function notifyMailRegistered(mailItemId: string): Promise<void> {
  try {
    const loaded = await load(mailItemId)
    if (!loaded) return
    const { mail, tenant } = loaded
    await sendMessage({
      to: await listClientMemberEmails(mail.clientId),
      ...mailArrivedMessage({
        centreName: tenant.name,
        clientName: mail.clientName,
        kind: mail.kind,
        receivedAt: mail.receivedAt,
        timeZone: tenant.timezone,
        link: appUrl('/compte/courrier'),
        opened: mail.status === 'opened',
      }),
    })
  } catch (error) {
    console.error('Notification d’arrivée de courrier impossible', error)
  }
}

export async function notifyMailScanned(mailItemId: string): Promise<void> {
  try {
    const loaded = await load(mailItemId)
    if (!loaded) return
    const { mail, tenant } = loaded
    await sendMessage({
      to: await listClientMemberEmails(mail.clientId),
      ...mailScannedMessage({
        centreName: tenant.name,
        clientName: mail.clientName,
        kind: mail.kind,
        receivedAt: mail.receivedAt,
        timeZone: tenant.timezone,
        link: appUrl('/compte/courrier'),
      }),
    })
  } catch (error) {
    console.error('Notification de numérisation impossible', error)
  }
}

/** Demande d'ouverture : à l'adresse du centre, quand il en a une. */
export async function notifyOpeningRequested(mailItemId: string): Promise<void> {
  try {
    const loaded = await load(mailItemId)
    if (!loaded || !loaded.tenant.email) return
    const { mail, tenant } = loaded
    await sendMessage({
      to: [tenant.email as string],
      ...openingRequestedMessage({
        centreName: tenant.name,
        clientName: mail.clientName,
        kind: mail.kind,
        receivedAt: mail.receivedAt,
        timeZone: tenant.timezone,
        link: appUrl(`/courrier/${mail.id}`),
        requestedBy: mail.requestedBy,
      }),
    })
  } catch (error) {
    console.error('Notification de demande d’ouverture impossible', error)
  }
}
