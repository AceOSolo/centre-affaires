import { randomBytes } from 'node:crypto'

import { INVITATION_JOURS } from './messages.ts'
import { getAuth, type Auth } from './server.ts'

/**
 * Lien d'invitation à l'espace client (ADR 059) : l'accueil crée l'accès
 * depuis la fiche du client, la personne reçoit un lien pour choisir son mot
 * de passe — sans s'inscrire elle-même ni confirmer son adresse à part.
 *
 * Le lien est celui de Better Auth pour un nouveau mot de passe
 * (`/api/auth/reset-password/:jeton`), avec une validité d'invitation :
 * sept jours au lieu d'une heure. Le jeton ne vaut qu'une fois ; renvoyer
 * l'invitation en crée un autre. Choisir le mot de passe confirme l'adresse
 * (`onPasswordReset`, `server.ts`) : seul son titulaire a reçu le lien.
 *
 * Le compte (`auth_users`) est créé s'il n'existe pas, sans mot de passe :
 * personne ne peut s'y connecter avant d'avoir ouvert le lien. Un compte qui
 * existe déjà — la personne a accès à une autre entreprise — est repris tel
 * quel ; le lien lui permet seulement d'en changer le mot de passe.
 */

/** Où mène le lien, une fois le jeton vérifié par Better Auth. */
export const INVITATION_CALLBACK = '/auth/nouveau-mot-de-passe?invitation=1'

export type InvitationLink = {
  url: string
  expiresAt: Date
  /** Le compte vient d'être créé pour l'invitation. */
  created: boolean
}

/** Jeton du lien : 18 octets aléatoires, 24 caractères sûrs dans une adresse. */
function newToken(): string {
  return randomBytes(18).toString('base64url')
}

/**
 * Prépare le compte de la personne invitée et son lien. Lève si Better Auth
 * n'est pas configuré (`AUTH_SECRET`, `APP_URL`) : l'appelant envoie alors
 * l'invitation sans lien.
 */
export async function prepareInvitationLink(
  input: { email: string; name?: string | null },
  options: { auth?: Auth; now?: Date } = {},
): Promise<InvitationLink> {
  const context = await (options.auth ?? getAuth()).$context
  const email = input.email.trim().toLowerCase()
  const now = options.now ?? new Date()

  let created = false
  let userId = (await context.internalAdapter.findUserByEmail(email))?.user.id
  if (!userId) {
    // Créé par l'équipe : la provenance « admin » de Better Auth.
    const user = await context.internalAdapter.createUser(
      { email, name: input.name?.trim() ?? '', emailVerified: false },
      { method: 'admin' },
    )
    userId = user.id
    created = true
  }

  const token = newToken()
  const expiresAt = new Date(now.getTime() + INVITATION_JOURS * 86_400_000)
  await context.internalAdapter.createVerificationValue({
    identifier: `reset-password:${token}`,
    value: userId,
    expiresAt,
  })
  const url = `${context.baseURL}/reset-password/${token}?callbackURL=${encodeURIComponent(INVITATION_CALLBACK)}`
  return { url, expiresAt, created }
}
