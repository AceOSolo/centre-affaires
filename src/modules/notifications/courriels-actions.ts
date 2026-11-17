'use server'

import { requirePermission } from '../../lib/auth/staff.ts'
import { currentTenant } from '../../lib/tenant.ts'
import { notificationEventLabels } from './catalogue.ts'
import { sendBrandedMessage, siteOrigins } from './identite-queries.ts'
import { findTemplateState } from './queries.ts'
import { exampleValuesFor, renderMessage } from './rendu.ts'
import { notificationEvents, type NotificationEvent } from './schema.ts'

/*
 * Essai d'envoi de l'encart « Courriels » (Réglages, ADR 059) et de l'aperçu
 * des courriels (Configuration, ADR 080). Réservé à qui configure le centre
 * (`centre.configurer`) : la vérification de l'envoi accompagne la pose des
 * variables SMTP sur le serveur et le réglage du logo et de la signature.
 */

export type TestEmailState =
  | { status: 'sent'; to: string }
  | { status: 'failed'; to: string; error: string }
  | { status: 'not_configured' }
  | null

/** Message d'essai sans modèle : il dit d'où il vient et quoi vérifier. */
function genericMessage(centre: string): { subject: string; text: string } {
  return {
    subject: `Essai d’envoi — ${centre}`,
    text:
      `Bonjour,\n\nCe message d’essai a été demandé depuis le back-office de ${centre}.` +
      '\n\nS’il vous parvient, les courriels de l’application partent bien : demandes, courrier, invitations à l’espace client.' +
      '\n\nVérifiez aussi qu’il n’est pas arrivé dans les indésirables : sinon, authentifiez le domaine de l’expéditeur chez Brevo.' +
      `\n\n—\n${centre}`,
  }
}

/**
 * Un modèle du centre (ou son texte par défaut), rempli de valeurs d'exemple
 * fictives — jamais une donnée réelle (`CLAUDE.md`) —, dont les liens mènent
 * au site. L'objet le dit : « [Essai] ».
 */
async function templateMessage(event: NotificationEvent, centre: string): Promise<{ subject: string; text: string }> {
  const template = await findTemplateState(event)
  const values = exampleValuesFor(event, { centre, origin: siteOrigins()[0] ?? null })
  const rendered = renderMessage(template, values, notificationEventLabels[event])
  return {
    subject: `[Essai] ${rendered.subject}`,
    text:
      `Essai du message « ${notificationEventLabels[event]} », rempli avec des valeurs d’exemple fictives.` +
      `${template.active ? '' : ' Ce message est désactivé : il ne part pas aux clients.'}\n\n${rendered.body}`,
  }
}

/**
 * Envoie un message d'essai à l'adresse du membre connecté — la sienne, jamais
 * une adresse saisie : l'essai ne peut pas servir à écrire à n'importe qui.
 * `modele` choisit un événement du catalogue ; vide, le message d'essai
 * générique. L'issue est rendue à l'écran ; un essai n'est pas un message du
 * centre et n'entre pas au journal.
 */
export async function sendTestEmailAction(_previous: TestEmailState, formData: FormData): Promise<TestEmailState> {
  const { member } = await requirePermission('centre.configurer')
  const tenant = await currentTenant()
  const modele = String(formData.get('modele') ?? '')
  const event = (notificationEvents as readonly string[]).includes(modele) ? (modele as NotificationEvent) : null

  const message = event ? await templateMessage(event, tenant.name) : genericMessage(tenant.name)
  const result = await sendBrandedMessage({ to: [member.email], ...message }, { tenantId: tenant.id })
  switch (result.status) {
    case 'sent':
      return { status: 'sent', to: member.email }
    case 'failed':
      return { status: 'failed', to: member.email, error: result.error ?? 'Envoi refusé par le serveur SMTP.' }
    case 'not_configured':
      return { status: 'not_configured' }
    case 'no_recipient':
      return { status: 'failed', to: member.email, error: 'Votre fiche d’équipe n’a pas d’adresse de courriel.' }
  }
}
