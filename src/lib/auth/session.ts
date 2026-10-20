import { cache } from 'react'

import { headers } from 'next/headers'

import type { AuthenticatedUser } from './membre.ts'
import { getAuth, requireEmailVerification } from './server.ts'

/**
 * Compte connecté, lu une fois par requête HTTP.
 *
 * Commun aux deux populations : l'équipe (`staff.ts`) et les clients
 * (`modules/clients/session.ts`) partent du même compte Neon Auth et ne
 * diffèrent que par la table qui leur donne des droits.
 *
 * `emailVerified` est rendu à part : il ne sert qu'au premier rattachement
 * d'un compte à une personne inscrite par son adresse.
 */
export const sessionUser = cache(
  async (): Promise<{ user: AuthenticatedUser; emailVerified?: boolean } | undefined> => {
    const session = await getAuth().api.getSession({ headers: await headers() })
    const raw = session?.user as
      | { id?: string; email?: string; name?: string | null; emailVerified?: boolean }
      | undefined

    if (!raw?.id || !raw.email) return undefined

    return {
      user: {
        id: raw.id,
        email: raw.email.trim().toLowerCase(),
        name: raw.name ?? null,
      },
      // En développement, la vérification est désactivée
      // (`AUTH_SKIP_EMAIL_VERIFICATION`) et aucune adresse n'est jamais
      // confirmée : la transmettre telle quelle fermerait tout rattachement, y
      // compris celui des comptes de démonstration. Elle n'est donc rendue
      // que lorsque le serveur l'exige — toujours en production.
      emailVerified: requireEmailVerification() ? raw.emailVerified : undefined,
    }
  },
)
