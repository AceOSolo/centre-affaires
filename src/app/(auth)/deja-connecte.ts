import { safeRedirect } from '../../lib/redirection.ts'

/**
 * Une personne déjà connectée n'a rien à faire sur une page de connexion
 * (ADR 077, recette du 17/11) : `/auth/connexion`, `/auth/equipe` et
 * `/auth/mot-de-passe-oublie` la renvoient vers son espace.
 *
 * Restent ouvertes, connecté ou non : `/auth/acces-refuse` (elle dit pourquoi
 * on n'entre pas), la déconnexion, et `/auth/nouveau-mot-de-passe` — le lien
 * d'une invitation ou d'un mot de passe oublié, peut-être pour un autre
 * compte que celui qui est connecté : la page dit alors ce qui se passe.
 *
 * Module pur, éprouvé seul (`deja-connecte.test.ts`) ; les pages l'appliquent
 * par `deja-connecte-serveur.ts`.
 */

/** La page ouverte : celle des clients (`connexion`, mot de passe oublié) ou celle de l'équipe. */
export type PageDeConnexion = 'client' | 'equipe'

/** Ce que le compte connecté ouvre : le back-office, un espace client, les deux ou rien. */
export type AccesDuCompte = { equipe: boolean; client: boolean }

/**
 * Où envoyer la personne connectée :
 *
 * - le chemin demandé (`?redirect=`, que `proxy.ts` ajoute), s'il est sûr et
 *   hors des pages d'authentification — la page visée revérifie les droits ;
 * - sinon son espace : depuis la page de l'équipe, le back-office d'abord ;
 *   depuis celle des clients, l'espace client d'abord ;
 * - un compte qui n'ouvre rien : « Accès refusé », qui le dit et propose de
 *   se déconnecter pour changer de compte.
 */
export function destinationSiConnecte(
  page: PageDeConnexion,
  acces: AccesDuCompte,
  demande?: string | null,
): string {
  if (!acces.equipe && !acces.client) return '/auth/acces-refuse'
  const chemin = safeRedirect(demande)
  if (chemin && chemin !== '/auth' && !chemin.startsWith('/auth/') && !chemin.startsWith('/auth?')) return chemin
  if (page === 'equipe') return acces.equipe ? '/aujourdhui' : '/compte'
  return acces.client ? '/compte' : '/aujourdhui'
}

/**
 * Ce que dit la page du nouveau mot de passe à une personne connectée :
 * `meme-compte` quand le lien est celui de son propre compte (ses sessions se
 * fermeront), `autre-compte` sinon — ou quand on ne sait pas à qui est le
 * lien (périmé) : il faudra se déconnecter pour entrer avec l'autre compte.
 */
export function lienPourQui(connecte: { id: string } | null, proprietaire: string | null): 'anonyme' | 'meme-compte' | 'autre-compte' {
  if (!connecte) return 'anonyme'
  return proprietaire === connecte.id ? 'meme-compte' : 'autre-compte'
}
