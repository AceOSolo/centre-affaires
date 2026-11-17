import { safeRedirect } from '../../lib/redirection.ts'

/**
 * Une personne déjà connectée n'a rien à faire sur une page de connexion
 * (ADR 077, recette du 17/11) : `/auth/connexion`, `/auth/equipe` et
 * `/auth/mot-de-passe-oublie` la renvoient vers l'espace de la page — ou vers
 * « Accès refusé » si son compte ne l'ouvre pas (ADR 083).
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
 * Chaque page de connexion n'ouvre que son espace (ADR 083) : celle des
 * clients un compte qui a un espace client, celle de l'équipe un membre de
 * l'équipe. Une personne qui est les deux passe par l'une ou l'autre.
 */
export function ouvreLaPorte(page: PageDeConnexion, acces: AccesDuCompte): boolean {
  return page === 'equipe' ? acces.equipe : acces.client
}

/** L'espace où mène la page, faute de chemin demandé. */
export const accueilDeLaPorte: Record<PageDeConnexion, string> = { client: '/compte', equipe: '/aujourdhui' }

const espaceClient = (chemin: string) => chemin === '/compte' || /^\/compte[/?#]/.test(chemin)

/**
 * Où mène la page une fois connecté : le chemin demandé (`?redirect=`, que
 * `proxy.ts` ajoute) s'il est sûr, hors des pages d'authentification et dans
 * l'espace de la page — `/compte…` pour les clients, le reste pour l'équipe ;
 * sinon l'accueil de l'espace. La page visée revérifie les droits.
 */
export function suiteDeLaPorte(page: PageDeConnexion, demande?: string | null): string {
  const chemin = safeRedirect(demande)
  const ok =
    chemin &&
    chemin !== '/auth' &&
    !chemin.startsWith('/auth/') &&
    !chemin.startsWith('/auth?') &&
    espaceClient(chemin) === (page === 'client')
  return ok ? chemin : accueilDeLaPorte[page]
}

/**
 * Où envoyer la personne déjà connectée qui ouvre une page de connexion :
 * dans l'espace de cette page si son compte l'ouvre (`suiteDeLaPorte`), sinon
 * « Accès refusé », qui le dit et propose de se déconnecter pour changer de
 * compte. Jamais vers l'espace de l'autre page (ADR 083).
 */
export function destinationSiConnecte(
  page: PageDeConnexion,
  acces: AccesDuCompte,
  demande?: string | null,
): string {
  return ouvreLaPorte(page, acces) ? suiteDeLaPorte(page, demande) : '/auth/acces-refuse'
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
