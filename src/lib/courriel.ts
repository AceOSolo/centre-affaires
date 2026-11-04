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
 * aucune adresse réelle ne doit recevoir de message — sauf vers un capteur
 * local (Mailpit, profil `courriel` de `docker-compose.yml`, ADR 059), qui
 * garde les messages sans les remettre à personne.
 */
type Env = Record<string, string | undefined>

/** Variables de l'envoi, dans l'ordre où l'encart « Courriels » les cite. */
export const SMTP_VARIABLES = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM'] as const
export type SmtpVariable = (typeof SMTP_VARIABLES)[number]

/**
 * Le serveur SMTP est-il sur la machine elle-même ? Seul cas où le clair est
 * admis : le message ne quitte pas la boucle locale (le capteur de
 * développement). `localhost.exemple.fr` n'en est pas un.
 */
export function isLoopbackHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return name === 'localhost' || name === '::1' || /^127(?:\.\d{1,3}){3}$/.test(name)
}

function readPort(env: Env): number | undefined {
  const port = Number(env.SMTP_PORT?.trim() || 587)
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined
}

/**
 * Réglages du transport, ou `undefined` s'il en manque un.
 *
 * Jamais de courriel en clair sur le réseau : 465 chiffre d'emblée, tout
 * autre port exige STARTTLS — sans lui, la connexion est refusée plutôt que
 * de continuer en clair. Brevo accepte les deux ; 587 est son port
 * recommandé. Seule exception : un serveur de la boucle locale, le capteur de
 * développement, qui ne chiffre pas.
 *
 * Délais bornés : un serveur injoignable répond en secondes, pas en deux
 * minutes — l'essai de l'encart « Courriels » attend sa réponse.
 */
export function smtpSettings(env: Env): SMTPTransport.Options | undefined {
  const host = env.SMTP_HOST?.trim()
  const user = env.SMTP_USER?.trim()
  const pass = env.SMTP_PASSWORD
  if (!host || !user || !pass || !env.MAIL_FROM?.trim()) return undefined

  const port = readPort(env)
  if (port === undefined) return undefined
  return {
    host,
    port,
    secure: port === 465,
    requireTLS: port !== 465 && !isLoopbackHost(host),
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  }
}

/**
 * Ce que l'encart « Courriels » dit de la configuration (ADR 059) : jamais
 * l'identifiant ni la clé, seulement s'ils sont renseignés.
 */
export type SmtpStatus = {
  configured: boolean
  /** Variables vides, ou illisibles pour le port. */
  missing: SmtpVariable[]
  host: string | null
  port: number | null
  /** Chiffrement de la connexion. */
  security: 'TLS' | 'STARTTLS' | 'aucun, capteur local' | null
  from: string | null
}

export function smtpStatus(env: Env = process.env): SmtpStatus {
  const missing = SMTP_VARIABLES.filter((name) =>
    name === 'SMTP_PORT' ? readPort(env) === undefined : !env[name]?.trim(),
  )
  const settings = smtpSettings(env)
  return {
    configured: settings !== undefined,
    missing,
    host: env.SMTP_HOST?.trim() || null,
    port: readPort(env) ?? null,
    security: !settings ? null : settings.secure ? 'TLS' : settings.requireTLS ? 'STARTTLS' : 'aucun, capteur local',
    from: env.MAIL_FROM?.trim() || null,
  }
}

/** Un transport par configuration : un environnement changé (tests, essai) n'en réutilise pas un ancien. */
const transporters = new Map<string, Transporter>()

function transport(env: Env): Transporter | undefined {
  const settings = smtpSettings(env)
  if (!settings) return undefined
  const key = JSON.stringify(settings)
  let found = transporters.get(key)
  if (!found) {
    found = nodemailer.createTransport(settings)
    transporters.set(key, found)
  }
  return found
}

export type Message = { to: string[]; subject: string; text: string }

/**
 * Issue d'un envoi, telle que le journal des messages la garde (ADR 038) :
 * les adresses, normalisées, celles que le serveur SMTP a refusées, et la
 * cause d'un refus — jamais le texte du message.
 */
export type SendResult = {
  status: 'sent' | 'failed' | 'not_configured' | 'no_recipient'
  /** Adresses en minuscules, sans doublon. */
  recipients: string[]
  /** Refusées par le serveur SMTP, parmi `recipients`. */
  failed: string[]
  /** Cause du premier refus. */
  error: string | null
}

/** Adresses en minuscules, sans blanc ni doublon : la forme du journal. */
export function normalizeRecipients(to: readonly string[]): string[] {
  return [...new Set(to.map((address) => address.trim().toLowerCase()).filter(Boolean))]
}

/** Ce que nodemailer joint à une erreur SMTP. */
type SmtpErrorFields = { code?: string; responseCode?: number; command?: string; response?: string }

const UNREACHABLE = ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED', 'ECONNRESET']

/**
 * Cause lisible d'un refus SMTP, pour le journal des messages et l'encart
 * « Courriels » (ADR 059) : ce qu'il faut vérifier, en français, puis la
 * réponse du serveur — jamais le message. Bornée à 400 caractères.
 */
export function explainSmtpError(reason: unknown): string {
  const fields = (typeof reason === 'object' && reason !== null ? reason : {}) as SmtpErrorFields
  const raw = (reason instanceof Error ? reason.message : String(reason)).replace(/\s+/g, ' ').trim()
  const code = fields.code ?? ''
  const command = (fields.command ?? '').toUpperCase()

  let hint: string | null = null
  if (code === 'EAUTH' || fields.responseCode === 535) {
    hint =
      'Identifiant ou clé SMTP refusés : vérifiez SMTP_USER (l’identifiant SMTP affiché par Brevo) et SMTP_PASSWORD (la clé SMTP, pas la clé d’API).'
  } else if (code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(raw)) {
    hint = 'Serveur SMTP introuvable : vérifiez SMTP_HOST (smtp-relay.brevo.com chez Brevo).'
  } else if (code === 'ETLS' || command.includes('STARTTLS')) {
    hint = 'La connexion chiffrée (STARTTLS) a échoué : vérifiez SMTP_PORT (587 chez Brevo).'
  } else if (UNREACHABLE.includes(code) || /ECONNREFUSED|ETIMEDOUT/.test(raw)) {
    hint =
      'Serveur SMTP injoignable : vérifiez SMTP_HOST et SMTP_PORT (587 chez Brevo), et que le serveur peut sortir sur ce port.'
  } else if (command.startsWith('MAIL') || /sender|expéditeur/i.test(`${fields.response ?? ''} ${raw}`)) {
    hint =
      'Expéditeur refusé : MAIL_FROM doit être une adresse d’un domaine authentifié, ou un expéditeur validé, dans Brevo.'
  } else if (command.startsWith('RCPT')) {
    hint = 'Adresse du destinataire refusée par le serveur SMTP.'
  }
  const detail = raw || 'Envoi refusé par le serveur SMTP.'
  return (hint ? `${hint} Réponse du serveur : ${detail}` : detail).slice(0, 400)
}

/**
 * Envoie un message à chaque destinataire séparément : aucun ne voit l'adresse
 * des autres, qui travaillent peut-être pour des entreprises différentes.
 *
 * Ne lève jamais : un courriel qui ne part pas ne doit pas faire échouer
 * l'enregistrement d'un courrier ou d'une demande. L'issue est rendue, pour
 * le journal des messages (`modules/notifications`), et écrite dans les
 * journaux du serveur.
 */
export async function sendMessage(message: Message, env: Env = process.env): Promise<SendResult> {
  const recipients = normalizeRecipients(message.to)
  if (recipients.length === 0) return { status: 'no_recipient', recipients, failed: [], error: null }

  const smtp = transport(env)
  const from = env.MAIL_FROM as string
  if (!smtp) {
    console.info(`Courriel non envoyé (SMTP non configuré) : « ${message.subject} »`)
    return { status: 'not_configured', recipients, failed: [], error: null }
  }

  const results = await Promise.allSettled(
    recipients.map((to) => smtp.sendMail({ from, to, subject: message.subject, text: message.text })),
  )
  const failed = recipients.filter((_to, index) => results[index].status === 'rejected')
  if (failed.length === 0) return { status: 'sent', recipients, failed: [], error: null }

  const reason = (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason
  console.error(
    `Courriel « ${message.subject} » : ${failed.length} envoi(s) sur ${recipients.length} en échec`,
    reason,
  )
  return {
    status: 'failed',
    recipients,
    failed,
    error: `${failed.length} envoi${failed.length > 1 ? 's' : ''} sur ${recipients.length} en échec : ${explainSmtpError(reason)}`,
  }
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
