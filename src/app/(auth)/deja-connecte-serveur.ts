import { redirect } from 'next/navigation'

import { getAuth } from '../../lib/auth/server.ts'
import { sessionUser } from '../../lib/auth/session.ts'
import { staffAccess } from '../../lib/auth/staff.ts'
import { clientAccess } from '../../modules/clients/session.ts'
import { destinationSiConnecte, type PageDeConnexion } from './deja-connecte.ts'

/**
 * Applique `destinationSiConnecte` (ADR 077) : sans session valide, la page
 * de connexion s'affiche ; avec, elle renvoie vers l'espace de la personne.
 *
 * La session est relue, pas seulement la présence du cookie : un cookie
 * périmé laisse la page s'afficher, sans boucle de redirection.
 */
export async function redirigerSiConnecte(page: PageDeConnexion, demande?: string | null): Promise<void> {
  const staff = await staffAccess()
  if (staff.status === 'anonyme') return
  const client = await clientAccess()
  redirect(
    destinationSiConnecte(page, { equipe: staff.status === 'membre', client: client.status === 'client' }, demande),
  )
}

/**
 * Compte connecté, et compte à qui appartient un lien de mot de passe
 * (`reset-password:<jeton>` de Better Auth, celui des invitations comme du
 * mot de passe oublié). `null` pour un lien inconnu ou périmé. Ne lève pas :
 * sans réponse, la page dit le cas général.
 */
export async function connecteEtLien(
  token: string | undefined,
): Promise<{ connecte: { id: string; email: string } | null; proprietaire: string | null }> {
  const session = await sessionUser()
  const connecte = session ? { id: session.user.id, email: session.user.email } : null
  if (!connecte || !token) return { connecte, proprietaire: null }
  try {
    const context = await getAuth().$context
    const verification = await context.internalAdapter.findVerificationValue(`reset-password:${token}`)
    return { connecte, proprietaire: verification?.value ?? null }
  } catch {
    return { connecte, proprietaire: null }
  }
}
