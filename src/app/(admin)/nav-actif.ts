/**
 * Entrée du menu à allumer pour l'adresse courante.
 *
 * Une entrée correspond quand son chemin est celui de la page ou l'un de ses
 * parents, et que chacun de ses paramètres (`?type=salle`, `?produit=bureaux`)
 * figure dans l'adresse avec la même valeur : le rayon Salles reste allumé de
 * la vue jour à la vue semaine de son planning, et ne s'allume pas sur le
 * planning du camion (ADR 046).
 *
 * La plus précise l'emporte : d'abord celle qui retient le plus de paramètres,
 * puis le plus long chemin — `/ressources/annonces` n'allume pas `/ressources`.
 */
export function activeEntry(hrefs: readonly string[], pathname: string, search: URLSearchParams): string | undefined {
  return hrefs
    .map((href) => {
      const [path, query = ''] = href.split('?')
      const params = [...new URLSearchParams(query)]
      const matches =
        (pathname === path || pathname.startsWith(`${path}/`)) &&
        params.every(([key, value]) => search.get(key) === value)
      return { href, matches, params: params.length, length: path.length }
    })
    .filter((candidate) => candidate.matches)
    .sort((a, b) => b.params - a.params || b.length - a.length)[0]?.href
}
