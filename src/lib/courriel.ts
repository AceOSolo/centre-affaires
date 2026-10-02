import nodemailer, { type Transporter } from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'

/**
 * Envoi de courriels par SMTP, chez Brevo (ADR 015).
 *
 * Brevo est un prestataire français qui héberge ses données en Europe, comme
 * l'exige `CLAUDE.md`. Il reste un choix de configuration, pas de code : tout
 * SMTP authentifié convient.
 *
 * Variables séparées plutôt qu'une URL : l'identifiant SMTP de Brevo contient
 * un `@`, qu'une URL obligerait à encoder — l'oubli ferait échouer l'envoi
 * sans message clair.
 *
 * Sans configuration complète, rien ne part : l'envoi est journalisé sans
 * destinataire et l'application continue. C'est le cas du développement, où
 * aucune adresse réelle ne doit recevoir de message.
 */
type Env = Record<string, string | undefined>

/**
 * Réglages du transport, ou `undefined` s'il en manque un.
 *
 * Jamais de courriel en clair : 465 chiffre d'emblée, tout autre port exige
 * STARTTLS — sans lui, la connexion est refusée plutôt que de continuer en
 * clair. Brevo accepte les deux ; 587 est son port recommandé.
 */
export function smtpSettings(env: Env): SMTPTransport.Options | undefined {
  const host = env.SMTP_HOST?.trim()
  const user = env.SMTP_USER?.trim()
  const pass = env.SMTP_PASSWORD
  if (!host || !user || !pass || !env.MAIL_FROM?.trim()) return undefined

  const port = Number(env.SMTP_PORT || 587)
  if (!Number.isInteger(port) || port <= 0) return undefined
  return { host, port, secure: port === 465, requireTLS: port !== 465, auth: { user, pass } }
}

let transporter: Transporter | undefined

function transport(): Transporter | undefined {
  const settings = smtpSettings(process.env)
  if (!settings) return undefined
  transporter ??= nodemailer.createTransport(settings)
  return transporter
}

export type Message = { to: string[]; subject: string; text: string }

/**
 * Issue d'un envoi, dans les termes du journal des messages
 * (`notification_deliveries`, ADR 038) : parti, refusé pour certains
 * destinataires, SMTP non configuré, ou rien à envoyer.
 */
export type SendReport = {
  status: 'sent' | 'failed' | 'not_configured' | 'skipped'
  /** Adresses, en minuscules et sans doublon. */
  recipients: string[]
  /** Adresses refusées par le serveur SMTP, parmi `recipients`. */
  failedRecipients: string[]
  /** Cause lisible d'un échec ou d'un envoi sauté ; jamais le contenu du message. */
  error: string | null
}

/**
 * Envoie un message à chaque destinataire séparément : aucun ne voit l'adresse
 * des autres, qui travaillent peut-être pour des entreprises différentes.
 *
 * Ne lève jamais : un courriel qui ne part pas ne doit pas faire échouer
 * l'enregistrement d'un courrier ou d'une demande. L'échec est journalisé, et
 * rendu à l'appelant qui veut le consigner.
 */
export async function sendMessage(message: Message): Promise<SendReport> {
  const recipients = [...new Set(message.to.map((to) => to.trim().toLowerCase()).filter(Boolean))]
  if (recipients.length === 0) {
    return { status: 'skipped', recipients, failedRecipients: [], error: 'Aucun destinataire.' }
  }

  const smtp = transport()
  const from = process.env.MAIL_FROM as string
  if (!smtp) {
    console.info(`Courriel non envoyé (SMTP non configuré) : « ${message.subject} »`)
    return { status: 'not_configured', recipients, failedRecipients: [], error: null }
  }

  const results = await Promise.allSettled(
    recipients.map((to) => smtp.sendMail({ from, to, subject: message.subject, text: message.text })),
  )
  const failedRecipients = recipients.filter((_, index) => results[index].status === 'rejected')
  if (failedRecipients.length > 0) {
    const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    console.error(
      `Courriel « ${message.subject} » : ${failedRecipients.length} envoi(s) sur ${recipients.length} en échec`,
      failed.reason,
    )
    return {
      status: 'failed',
      recipients,
      failedRecipients,
      error: `${failedRecipients.length} envoi(s) sur ${recipients.length} refusé(s) par le serveur de courriel.`,
    }
  }
  return { status: 'sent', recipients, failedRecipients: [], error: null }
}

/** Vrai quand les courriels partent réellement : les écrans ne promettent rien d'autre. */
export function emailEnabled(): boolean {
  return smtpSettings(process.env) !== undefined
}

/** Adresse publique de l'application, pour les liens des courriels. */
export function appUrl(path: string): string | undefined {
  const base = process.env.APP_URL
  return base ? new URL(path, base).toString() : undefined
}
