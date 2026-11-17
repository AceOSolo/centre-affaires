/** Origine fictive : sert seulement à résoudre le chemin comme le ferait le navigateur. */
const ORIGINE = 'http://site.invalid'

/**
 * Chemin de retour après connexion, lu dans l'URL (`?redirect=`).
 *
 * N'importe qui peut fabriquer cette URL : seul un chemin du site est suivi.
 * `https://…`, `//autre-site` ou `/\autre-site` enverraient la personne
 * ailleurs juste après qu'elle a saisi son mot de passe. Rend `null` quand le
 * chemin n'est pas sûr ; l'appelant choisit alors sa destination par défaut.
 *
 * Le chemin n'est pas jugé sur sa forme écrite mais sur ce que le navigateur
 * en fera : il retire tabulations et retours à la ligne (`/⇥/autre-site`
 * devient `//autre-site`), lit `\` comme `/`, et résout `..`
 * (`/..//autre-site`). On le résout donc de la même façon, on exige qu'il
 * reste sur le site, et on rend la forme résolue — celle qui a été vérifiée.
 */
export function safeRedirect(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/')) return null
  let url: URL
  try {
    url = new URL(value, ORIGINE)
  } catch {
    return null
  }
  // Un chemin résolu qui commence par `//` redeviendrait une adresse d'un
  // autre site une fois rendu au navigateur.
  if (url.origin !== ORIGINE || url.pathname.startsWith('//')) return null
  return url.pathname + url.search + url.hash
}

/**
 * Adresse de retour dans l'espace client (`?retour=`, recette du 17/11) : le
 * lien « ← … » d'une page ramène là où l'on était — la boîte aux lettres
 * avec ses filtres et sa page, « Mon compte »… Même garde que `safeRedirect`,
 * et en plus le chemin doit rester dans l'espace client (`/compte`). Sinon,
 * `fallback`.
 */
export function clientReturnPath(value: unknown, fallback: string): string {
  const path = typeof value === 'string' ? safeRedirect(value) : null
  if (!path) return fallback
  const pathname = path.split(/[?#]/, 1)[0]
  return pathname === '/compte' || pathname.startsWith('/compte/') ? path : fallback
}

/**
 * `href` avec le paramètre `retour` quand `returnTo` est une adresse de
 * retour valable (`clientReturnPath`) ; `href` tel quel sinon. L'ancre de
 * `href` reste à la fin.
 */
export function withReturn(href: string, returnTo: unknown): string {
  const path = clientReturnPath(returnTo, '')
  if (!path) return href
  const hashAt = href.indexOf('#')
  const base = hashAt === -1 ? href : href.slice(0, hashAt)
  const hash = hashAt === -1 ? '' : href.slice(hashAt)
  return `${base}${base.includes('?') ? '&' : '?'}retour=${encodeURIComponent(path)}${hash}`
}
