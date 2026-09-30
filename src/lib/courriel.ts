import nodemailer, { type Transporter } from 'nodemailer'

/**
 * Envoi de courriels par SMTP (ADR 015).
 *
 * `SMTP_URL` désigne le serveur — `smtps://utilisateur:motdepasse@smtp.exemple.eu:465`
 * — et `MAIL_FROM` l'expéditeur. Le fournisseur est un choix de configuration,
 * pas de code : un SMTP hébergé en Europe convient, comme l'exige `CLAUDE.md`.
 *
 * Sans `SMTP_URL`, rien ne part : l'envoi est journalisé sans destinataire et
 * l'application continue. C'est le cas du développement, où aucune adresse
 * réelle ne doit recevoir de message.
 */
let transporter: Transporter | undefined

function transport(): Transporter | undefined {
  const url = process.env.SMTP_URL
  if (!url) return undefined
  transporter ??= nodemailer.createTransport(url)
  return transporter
}

export type Message = { to: string[]; subject: string; text: string }

/**
 * Envoie un message à chaque destinataire séparément : aucun ne voit l'adresse
 * des autres, qui travaillent peut-être pour des entreprises différentes.
 *
 * Ne lève jamais : un courriel qui ne part pas ne doit pas faire échouer
 * l'enregistrement d'un courrier ou d'une demande. L'échec est journalisé.
 */
export async function sendMessage(message: Message): Promise<void> {
  const recipients = [...new Set(message.to.map((to) => to.trim().toLowerCase()).filter(Boolean))]
  if (recipients.length === 0) return

  const smtp = transport()
  const from = process.env.MAIL_FROM
  if (!smtp || !from) {
    console.info(`Courriel non envoyé (SMTP non configuré) : « ${message.subject} »`)
    return
  }

  const results = await Promise.allSettled(
    recipients.map((to) => smtp.sendMail({ from, to, subject: message.subject, text: message.text })),
  )
  const failed = results.filter((result) => result.status === 'rejected')
  if (failed.length > 0) {
    console.error(
      `Courriel « ${message.subject} » : ${failed.length} envoi(s) sur ${recipients.length} en échec`,
      (failed[0] as PromiseRejectedResult).reason,
    )
  }
}

/** Vrai quand les courriels partent réellement : les écrans ne promettent rien d'autre. */
export function emailEnabled(): boolean {
  return Boolean(process.env.SMTP_URL && process.env.MAIL_FROM)
}

/** Adresse publique de l'application, pour les liens des courriels. */
export function appUrl(path: string): string | undefined {
  const base = process.env.APP_URL
  return base ? new URL(path, base).toString() : undefined
}
