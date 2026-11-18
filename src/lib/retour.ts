import { safeRedirect } from './redirection.ts'

/**
 * Revenir là où l'on était (recette du 17/11), sans base ni navigateur :
 * `LienRetour` (`src/components/ui/lien-retour.tsx`) et les listes passent
 * par ces règles.
 *
 * Une liste qui ouvre une fiche lui passe son adresse, filtres compris, en
 * `?retour=` ; le lien de retour de la fiche y ramène. Le paramètre se
 * fabrique à la main : il n'est suivi que s'il reste sur le site
 * (`safeRedirect`).
 */

/** Le paramètre qui porte l'adresse de retour. */
export const RETOUR = 'retour'

type Params = URLSearchParams | Record<string, string | string[] | undefined>

/**
 * L'adresse d'une page, requête comprise, pour la passer en `retour` : sans
 * son propre `retour`, qui s'emboîterait de fiche en fiche.
 */
export function adresseCourante(pathname: string, params?: Params): string {
  const search = new URLSearchParams()
  const entries: [string, string | string[] | undefined][] =
    params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params ?? {})
  for (const [key, value] of entries) {
    if (key === RETOUR || value === undefined) continue
    for (const one of [value].flat()) search.append(key, one)
  }
  const query = search.toString()
  return query ? `${pathname}?${query}` : pathname
}

/** `href` qui ramènera à `retour` ; `href` tel quel sans retour sûr. */
export function avecRetour(href: string, retour: string | null | undefined): string {
  const safe = safeRedirect(retour)
  if (!safe) return href
  const [beforeHash, hash] = href.split('#', 2)
  const [path, query = ''] = beforeHash.split('?', 2)
  const search = new URLSearchParams(query)
  search.set(RETOUR, safe)
  return `${path}?${search.toString()}${hash === undefined ? '' : `#${hash}`}`
}

/** L'adresse de retour lue dans la requête d'une page, si elle est sûre et mène ailleurs. */
export function retourDe(search: string | URLSearchParams, pathname: string): string | null {
  const value = safeRedirect(new URLSearchParams(search).get(RETOUR))
  if (!value || value.split(/[?#]/)[0] === pathname) return null
  return value
}

/**
 * Une page qu'on ne veut pas retrouver en revenant : un formulaire de
 * création ou de modification (on vient de l'enregistrer), une page de
 * connexion.
 */
export const estPageDeSaisie = (pathname: string) =>
  /\/(nouveau|nouvelle|modifier)(\/|$)/.test(pathname) || pathname.startsWith('/auth/')

/**
 * Combien de pas reculer dans l'historique de l'onglet pour revenir à la
 * page d'avant : la dernière qui n'est ni la page courante (une fiche
 * rechargée après « Enregistrer ») ni un formulaire. `undefined` si on ne la
 * connaît pas — page ouverte dans un nouvel onglet, ou rechargée.
 *
 * `entrees[i]` est l'adresse de la i-ème entrée de l'historique de l'onglet
 * (chemin et requête), `position` celle de la page courante ; un trou est une
 * entrée d'avant le chargement de l'application.
 */
export function pasEnArriere(
  entrees: readonly (string | undefined)[],
  position: number,
  pathname: string,
): number | undefined {
  for (let index = position - 1; index >= 0; index--) {
    const entree = entrees[index]
    if (entree === undefined) return undefined
    const chemin = entree.split(/[?#]/)[0]
    if (chemin === pathname || estPageDeSaisie(chemin)) continue
    return position - index
  }
  return undefined
}
