/**
 * Identifiants lisibles pour les URL publiques.
 *
 * Le slug d'une annonce paraît dans l'adresse et dans les résultats de
 * recherche : il doit rester stable même si la ressource est renommée, d'où son
 * stockage en base plutôt qu'un calcul à l'affichage.
 */

/** « Salle Europe » → « salle-europe ». */
export function slugify(value: string): string {
  return (
    value
      .normalize('NFD')
      // Retire les diacritiques : « é » devient « e », pas « %C3%A9 ».
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .replace(/-+$/g, '')
  )
}

/**
 * Slug libre parmi ceux déjà pris, en suffixant un compteur.
 *
 * Deux bureaux nommés « Bureau 201 » dans deux bâtiments donneraient le même
 * slug ; le second devient « bureau-201-2 » plutôt que d'échouer.
 */
export function uniqueSlug(value: string, taken: Iterable<string>): string {
  const base = slugify(value) || 'annonce'
  const pris = new Set(taken)
  if (!pris.has(base)) return base

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!pris.has(candidate)) return candidate
  }
  // Repli théorique : mille homonymes.
  return `${base}-${Date.now()}`
}
