import { and, eq, inArray, isNull } from 'drizzle-orm'

import { withTenant, type Database, type Transaction } from '../../db/index.ts'
import { tenants } from '../../db/tenants.ts'
import { normalizeRecipients, sendMessage, type Message, type SendResult } from '../../lib/courriel.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { defaultTemplates, notificationCategoryLabels, notificationEventLabels } from './catalogue.ts'
import { renderMessage, type TemplateValues } from './rendu.ts'
import {
  notificationDeliveries,
  notificationEventAudience,
  notificationEventCategory,
  notificationPreferences,
  notificationTemplates,
  type NotificationCategory,
  type NotificationDeliveryStatus,
  type NotificationEvent,
  type NotificationRelatedType,
} from './schema.ts'

/**
 * Moteur de notifications (R26, ADR 038) : **le** point d'envoi des messages
 * de l'application.
 *
 * Pour un événement, il prend le modèle du centre — ou, sans modèle, le texte
 * par défaut du code —, remplit les variables, écarte les personnes qui ont
 * renoncé à la catégorie du message, envoie par `sendMessage()` et inscrit
 * l'issue au journal des envois : envoyé, échec, SMTP non configuré, ou non
 * envoyé avec sa raison. Le journal garde l'objet, jamais le corps.
 *
 * Ne lève jamais : un message qui ne part pas ne fait pas échouer
 * l'enregistrement d'un courrier, d'une facture ou d'une réservation. Les
 * appelants le lancent après la réponse (`after()`), comme avant.
 */

/** Une adresse, et l'accès de l'espace client qu'elle représente s'il y en a un. */
export type Recipient = {
  email: string
  /**
   * Accès (`client_members`) dont les préférences s'appliquent. Absent : une
   * adresse qui n'est pas celle d'un accès — contact « factures », personne
   * invitée —, toujours servie.
   */
  memberId?: string | null
}

export type NotificationRequest = {
  event: NotificationEvent
  /** Entreprise concernée. Requise pour un message au client (contrainte de la base). */
  clientId?: string | null
  /** Entité dont parle le message, pour retrouver ses envois. */
  related?: { type: NotificationRelatedType; id: string } | null
  /**
   * Destinataires d'un message au client. Sans eux : toutes les personnes de
   * l'espace du client. `memberIds` désigne des accès de l'entreprise, retirés
   * exclus ; `addresses`, des adresses données telles quelles. Ignorés pour un
   * message au centre, qui part à l'adresse du centre.
   */
  recipients?: { memberIds?: readonly string[]; addresses?: readonly Recipient[] }
  /** Valeurs des variables. `centre` est fourni par le moteur. */
  values: TemplateValues
}

export type NotificationOutcome = {
  status: NotificationDeliveryStatus
  subject: string
  /** Corps rendu : rendu à l'appelant (la relance l'archive), jamais journalisé. */
  body: string
  /** Adresses servies — ou qui l'auraient été, SMTP non configuré. */
  recipients: string[]
  failedRecipients: string[]
  /** Cause d'un échec, raison d'un message non envoyé. */
  error: string | null
  /** Le journal a-t-il été écrit ? */
  logged: boolean
}

export type NotifyOptions = {
  /** Base des tests ; sans elle, celle de l'application. */
  database?: Database
  tenantId?: string
  /** Transport des tests ; sans lui, `sendMessage()`. */
  send?: (message: Message) => Promise<SendResult>
}

type Prepared = {
  subject: string
  body: string
  recipients: string[]
  /** Raison de ne rien envoyer : modèle désactivé, aucun destinataire, renoncement. */
  skip: string | null
}

/**
 * Accès actifs d'une entreprise : ni retirés, ni anonymisés, et l'entreprise
 * n'est pas archivée — une fiche archivée ferme l'accès à ses personnes.
 */
async function activeMembers(
  tx: Transaction,
  clientId: string,
  memberIds?: readonly string[],
): Promise<Recipient[]> {
  if (memberIds && memberIds.length === 0) return []
  const rows = await tx
    .select({ memberId: clientMembers.id, email: clientMembers.email })
    .from(clientMembers)
    .innerJoin(
      clients,
      and(eq(clients.tenantId, clientMembers.tenantId), eq(clients.id, clientMembers.clientId)),
    )
    .where(
      and(
        eq(clientMembers.clientId, clientId),
        isNull(clientMembers.deletedAt),
        isNull(clientMembers.anonymizedAt),
        isNull(clients.deletedAt),
        memberIds ? inArray(clientMembers.id, [...memberIds]) : undefined,
      ),
    )
  return rows
}

/**
 * Écarte les personnes qui ont renoncé à la catégorie. Une adresse reste
 * servie si l'une au moins de ses entrées n'y a pas renoncé : une adresse
 * donnée sans accès (contact « factures ») l'est toujours.
 */
async function withoutRenouncements(
  tx: Transaction,
  recipients: readonly Recipient[],
  category: NotificationCategory,
): Promise<string[]> {
  const memberIds = [...new Set(recipients.map((recipient) => recipient.memberId).filter(Boolean))] as string[]
  const renounced = new Set<string>()
  if (memberIds.length > 0) {
    const rows = await tx
      .select({ memberId: notificationPreferences.clientMemberId })
      .from(notificationPreferences)
      .where(
        and(
          inArray(notificationPreferences.clientMemberId, memberIds),
          eq(notificationPreferences.category, category),
          eq(notificationPreferences.enabled, false),
        ),
      )
    for (const row of rows) renounced.add(row.memberId)
  }
  const kept = recipients.filter((recipient) => !recipient.memberId || !renounced.has(recipient.memberId))
  return normalizeRecipients(kept.map((recipient) => recipient.email))
}

async function prepare(tx: Transaction, request: NotificationRequest, tenantId: string): Promise<Prepared> {
  const { event } = request
  const [tenant] = await tx
    .select({ name: tenants.name, email: tenants.email })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
  const [template] = await tx
    .select({
      subject: notificationTemplates.subject,
      body: notificationTemplates.body,
      active: notificationTemplates.active,
    })
    .from(notificationTemplates)
    .where(eq(notificationTemplates.event, event))

  const rendered = renderMessage(
    template ?? defaultTemplates[event],
    { centre: tenant?.name, ...request.values },
    notificationEventLabels[event],
  )
  const prepared = (recipients: string[], skip: string | null): Prepared => ({ ...rendered, recipients, skip })

  if (template && !template.active) {
    return prepared([], 'Modèle désactivé par le centre : rien n’est envoyé pour cet événement.')
  }

  if (notificationEventAudience[event] === 'centre') {
    const address = normalizeRecipients(tenant?.email ? [tenant.email] : [])
    return address.length > 0
      ? prepared(address, null)
      : prepared([], 'Le centre n’a pas d’adresse de courriel : renseignez-la dans la configuration.')
  }

  if (!request.clientId) throw new Error(`Message « ${event} » au client sans client.`)
  const asked = request.recipients
  const recipients: Recipient[] = [
    ...(!asked || asked.memberIds ? await activeMembers(tx, request.clientId, asked?.memberIds) : []),
    ...(asked?.addresses ?? []),
  ]
  if (normalizeRecipients(recipients.map((recipient) => recipient.email)).length === 0) {
    return prepared(
      [],
      asked?.addresses
        ? 'Aucune adresse de courriel à prévenir.'
        : 'Aucune personne n’a accès à l’espace de ce client.',
    )
  }

  const category = notificationEventCategory[event]
  if (!category) return prepared(normalizeRecipients(recipients.map((recipient) => recipient.email)), null)
  const kept = await withoutRenouncements(tx, recipients, category)
  return kept.length > 0
    ? prepared(kept, null)
    : prepared(
        [],
        `Les personnes à prévenir ont renoncé aux messages « ${notificationCategoryLabels[category]} ».`,
      )
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, ' ').trim().slice(0, 500) || 'Erreur inconnue.'
}

/** Issue d'un envoi, telle qu'elle s'inscrit au journal. */
function outcomeOf(prepared: Prepared, result: SendResult | null): Omit<NotificationOutcome, 'logged'> {
  const base = { subject: prepared.subject, body: prepared.body }
  if (prepared.skip !== null || result === null) {
    return { ...base, status: 'skipped', recipients: [], failedRecipients: [], error: prepared.skip }
  }
  switch (result.status) {
    case 'sent':
      return { ...base, status: 'sent', recipients: result.recipients, failedRecipients: [], error: null }
    case 'failed':
      return {
        ...base,
        status: 'failed',
        recipients: result.recipients,
        failedRecipients: result.failed,
        error: result.error ?? 'Envoi refusé par le serveur SMTP.',
      }
    case 'not_configured':
      return { ...base, status: 'not_configured', recipients: result.recipients, failedRecipients: [], error: null }
    case 'no_recipient':
      return { ...base, status: 'skipped', recipients: [], failedRecipients: [], error: 'Aucune adresse de courriel à prévenir.' }
  }
}

/**
 * Envoie le message d'un événement et l'inscrit au journal. Ne lève jamais :
 * une panne de la base ou du transport rend une issue `failed` non
 * journalisée, et laisse sa trace dans les journaux du serveur.
 */
export async function notify(
  request: NotificationRequest,
  options: NotifyOptions = {},
): Promise<NotificationOutcome> {
  const tenantId = options.tenantId ?? currentTenantId()
  const send = options.send ?? sendMessage
  const fallback: NotificationOutcome = {
    status: 'failed',
    subject: notificationEventLabels[request.event],
    body: '',
    recipients: [],
    failedRecipients: [],
    error: null,
    logged: false,
  }

  let outcome: Omit<NotificationOutcome, 'logged'>
  try {
    // La préparation lit le modèle, les accès et les préférences dans une
    // transaction courte ; l'envoi se fait hors de toute transaction, un
    // serveur SMTP lent ne retient pas de connexion à la base.
    const prepared = await withTenant(tenantId, (tx) => prepare(tx, request, tenantId), options.database)
    let result: SendResult | null = null
    if (prepared.skip === null) {
      try {
        result = await send({ to: prepared.recipients, subject: prepared.subject, text: prepared.body })
      } catch (error) {
        // `sendMessage()` ne lève pas ; un transport qui le ferait vaut échec.
        result = {
          status: 'failed',
          recipients: prepared.recipients,
          failed: prepared.recipients,
          error: describeError(error),
        }
      }
    }
    outcome = outcomeOf(prepared, result)
  } catch (error) {
    console.error(`Message « ${request.event} » non préparé`, error)
    return { ...fallback, error: describeError(error) }
  }

  try {
    await withTenant(
      tenantId,
      (tx) =>
        tx.insert(notificationDeliveries).values({
          event: request.event,
          audience: notificationEventAudience[request.event],
          clientId: request.clientId ?? null,
          recipients: outcome.recipients,
          failedRecipients: outcome.failedRecipients,
          subject: outcome.subject,
          status: outcome.status,
          error: outcome.error,
          relatedType: request.related?.type ?? null,
          relatedId: request.related?.id ?? null,
        }),
      options.database,
    )
    return { ...outcome, logged: true }
  } catch (error) {
    console.error(`Message « ${request.event} » non inscrit au journal (${outcome.status})`, error)
    return { ...outcome, logged: false }
  }
}
