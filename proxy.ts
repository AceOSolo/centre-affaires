import { getSessionCookie } from 'better-auth/cookies'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Filtre d'accès au back-office (ADR 008).
 *
 * Next 16 nomme ce fichier `proxy.ts`. Il redirige vers la connexion les
 * visiteurs sans cookie de session, avant même le rendu de la page.
 *
 * Ce filtre est une commodité, pas la protection : il ne regarde que la
 * présence du cookie, pas sa validité, et une action serveur s'invoque par son
 * identifiant depuis n'importe quel chemin, y compris la page publique que
 * `matcher` laisse volontairement passer. Le contrôle qui compte est
 * `requirePermission()`, appelé dans les pages et dans chaque action serveur
 * (ADR 019).
 */
export default function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next()

  const login = new URL('/auth/connexion', request.url)
  login.searchParams.set('redirect', request.nextUrl.pathname + request.nextUrl.search)
  return NextResponse.redirect(login)
}

export const config = {
  // Uniquement les écrans du back-office. Le site public, les pages
  // d'authentification, le relais `/api/auth` et les fichiers statiques doivent
  // rester joignables sans session — sinon la page de connexion elle-même ne
  // peut pas se charger.
  matcher: [
    '/reservations/:path*',
    '/ressources/:path*',
    '/disponibilites/:path*',
    '/demandes/:path*',
    '/clients/:path*',
    '/contrats/:path*',
    '/tarifs/:path*',
    '/services/:path*',
    '/offres/:path*',
    '/factures/:path*',
    '/courrier/:path*',
    '/etats-des-lieux/:path*',
    '/indicateurs/:path*',
    '/equipe/:path*',
    '/comptes/:path*',
    '/configuration/:path*',
    '/paiements/:path*',
    '/comptabilite/:path*',
    '/acces-reserve/:path*',
    // L'espace client : même commodité, même limite — les pages et les
    // actions revérifient le compte elles-mêmes (ADR 015).
    '/compte/:path*',
  ],
}
