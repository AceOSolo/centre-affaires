import { randomBytes } from 'node:crypto'

import { INVITATION_CALLBACK, INVITATION_JOURS } from './messages.ts'
import { getAuth, type Auth } from './server.ts'

// Les destinations du lien vivent dans `messages.ts`, sans dépendance : le
// script d'amorçage (`infra/lien-invitation.mjs`) les lit aussi.
export { INVITATION_CALLBACK, STAFF_INVITATION_CALLBACK } from './messages.ts'

/**
 * Lien d'invitation (ADR 059, ADR 068) : la personne reçoit un lien pour
 * choisir son mot de passe — sans s'inscrire elle-même ni confirmer son
 * adresse à part. Il sert à l'espace client (accès ouvert par l'accueil), à
 * l'équipe (membre ajouté par la direction ou un exploitant) et au demandeur
 * d'une demande du site, qui y crée son espace.
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
 *
 * Depuis l'ADR 068, c'est la seule façon de naître pour un compte : la page
 * de connexion n'a plus d'inscription libre.
 */

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
 * Le compte de cette adresse a-t-il déjà un mot de passe ? Alors la personne
 * se connecte avec lui : un lien pour en choisir un autre n'a pas lieu d'être.
 */
export async function accountHasPassword(email: string, options: { auth?: Auth } = {}): Promise<boolean> {
  const context = await (options.auth ?? getAuth()).$context
  const found = await context.internalAdapter.findUserByEmail(email.trim().toLowerCase())
  if (!found) return false
  const accounts = await context.internalAdapter.findAccounts(found.user.id)
  return accounts.some((account) => account.providerId === 'credential' && Boolean(account.password))
}

/**
 * Prépare le compte de la personne invitée et son lien. Lève si Better Auth
 * n'est pas configuré (`AUTH_SECRET`, `APP_URL`) : l'appelant envoie alors
 * l'invitation sans lien.
 *
 * `companyName` : la raison sociale saisie avec une demande du site, posée
 * sur un compte créé ici ; elle nomme la fiche client créée à la première
 * entrée (`modules/comptes/inscription.ts`).
 */
export async function prepareInvitationLink(
  input: { email: string; name?: string | null; companyName?: string | null },
  options: { auth?: Auth; now?: Date; callback?: string } = {},
): Promise<InvitationLink> {
  const context = await (options.auth ?? getAuth()).$context
  const email = input.email.trim().toLowerCase()
  const now = options.now ?? new Date()

  let created = false
  let userId = (await context.internalAdapter.findUserByEmail(email))?.user.id
  if (!userId) {
    // Créé par l'équipe ou par une demande : la provenance « admin » de Better Auth.
    const user = await context.internalAdapter.createUser(
      {
        email,
        name: input.name?.trim() ?? '',
        emailVerified: false,
        companyName: input.companyName?.trim().slice(0, 255) || null,
      },
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
  const callback = options.callback ?? INVITATION_CALLBACK
  const url = `${context.baseURL}/reset-password/${token}?callbackURL=${encodeURIComponent(callback)}`
  return { url, expiresAt, created }
}
