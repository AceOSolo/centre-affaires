import { clientReturnPath } from '../../../lib/redirection.ts'

/** Nom de la page où ramène un lien « ← … », d'après son chemin. */
const pageNames: Record<string, string> = {
  '/compte': 'Mon espace',
  '/compte/mon-compte': 'Mon compte',
  '/compte/courrier': 'Ma boîte aux lettres',
  '/compte/courrier/demandes': 'Mes demandes',
  '/compte/courrier/adresses': 'Mes adresses',
  '/compte/courrier/categories': 'Mes catégories',
  '/compte/pieces': 'Pièces justificatives',
}

export type ReturnLink = { href: string; label: string }

/**
 * Lien « ← … » d'une page de l'espace client (recette du 17/11) : vers la
 * page d'où l'on vient, dite par `?retour=` — la boîte aux lettres avec ses
 * filtres et sa page, « Mon compte »… —, sinon vers `fallback`. Le libellé
 * nomme la page de destination.
 */
export function returnLink(value: unknown, fallback: ReturnLink): ReturnLink {
  const href = clientReturnPath(Array.isArray(value) ? value[0] : value, '')
  if (!href) return fallback
  const pathname = href.split(/[?#]/, 1)[0]
  const label =
    pageNames[pathname] ?? (pathname.startsWith('/compte/courrier/') ? 'Le courrier' : 'Retour')
  return { href, label }
}
