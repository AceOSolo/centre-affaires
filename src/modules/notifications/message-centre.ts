import { eq } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { sendMessage, type SendReport } from '../../lib/courriel.ts'
import { currentTenant, currentTenantId } from '../../lib/tenant.ts'
import {
  notificationDeliveries,
  notificationTemplates,
  type NotificationEvent,
  type NotificationRelatedType,
} from './schema.ts'

/**
 * Messages **au centre** déclenchés depuis l'espace client (ADR 038) : une
 * demande de réservation à valider (`booking_request_submitted`), une offre
 * groupée demandée (`offer_requested`, ADR 036). Chacun part à l'adresse du
 * centre et laisse une ligne dans le journal des envois — l'objet, jamais le
 * corps.
 *
 * Chemin minimal de la tranche « portail », dans les termes du moteur de
 * l'ADR 038 : modèle du centre s'il existe (désactivé, rien ne part et
 * l'envoi est journalisé `skipped`), texte par défaut du code sinon. Les
 * messages au centre n'ont pas de catégorie : aucune préférence ne s'y
 * applique.
 */

export type CentreEvent = Extract<NotificationEvent, 'booking_request_submitted' | 'offer_requested'>

export type CentreMessage = {
  event: CentreEvent
  /** Entreprise concernée, pour le journal. */
  clientId: string | null
  related: { type: NotificationRelatedType; id: string } | null
  /** Texte par défaut, quand le centre n'a pas de modèle pour l'événement. */
  subject: string
  text: string
  /** Valeurs des variables `{{nom}}` d'un modèle du centre. */
  variables: Record<string, string>
}

/** Remplace les variables `{{nom}}` connues ; une variable inconnue reste telle quelle, visible. */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, name: string) =>
    Object.hasOwn(variables, name) ? variables[name] : match,
  )
}

/** Objet du journal : non vide (`notification_deliveries_subject_not_blank`), sur une ligne. */
function journalSubject(subject: string): string {
  const line = subject.replace(/\s+/g, ' ').trim()
  return (line || 'Message au centre').slice(0, 200)
}

/**
 * Envoie le message à l'adresse du centre et le journalise.
 *
 * L'envoi ne lève jamais (`sendMessage`) ; l'écriture du journal, elle, lève
 * en cas d'échec : pour une offre demandée, le journal est la seule trace de
 * la demande (ADR 036), l'appelant doit le savoir.
 */
export async function sendCentreMessage(message: CentreMessage): Promise<SendReport> {
  const tenant = await currentTenant()
  const [template] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        subject: notificationTemplates.subject,
        body: notificationTemplates.body,
        active: notificationTemplates.active,
      })
      .from(notificationTemplates)
      .where(eq(notificationTemplates.event, message.event))
      .limit(1),
  )

  const subject = template ? renderTemplate(template.subject, message.variables) : message.subject
  const text = template ? renderTemplate(template.body, message.variables) : message.text

  let report: SendReport
  if (template && !template.active) {
    report = { status: 'skipped', recipients: [], failedRecipients: [], error: 'Modèle désactivé par le centre.' }
  } else if (!tenant.email) {
    report = {
      status: 'skipped',
      recipients: [],
      failedRecipients: [],
      error: 'Le centre n’a pas d’adresse de courriel (Configuration).',
    }
  } else {
    report = await sendMessage({ to: [tenant.email], subject, text })
  }

  await withTenant(currentTenantId(), (tx) =>
    tx.insert(notificationDeliveries).values({
      event: message.event,
      audience: 'centre',
      clientId: message.clientId,
      recipients: report.recipients,
      failedRecipients: report.failedRecipients,
      subject: journalSubject(subject),
      status: report.status,
      error: report.error,
      relatedType: message.related?.type ?? null,
      relatedId: message.related?.id ?? null,
    }),
  )
  return report
}
