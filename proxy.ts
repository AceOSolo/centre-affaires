import { auth } from './src/lib/auth/server.ts'

/**
 * Filtre d'accès au back-office (ADR 008).
 *
 * Next 16 nomme ce fichier `proxy.ts`. Il redirige vers la connexion les
 * visiteurs sans session, avant même le rendu de la page.
 *
 * Ce filtre est une commodité, pas la protection : une action serveur s'invoque
 * par son identifiant depuis n'importe quel chemin, y compris la page publique
 * que `matcher` laisse volontairement passer. Le contrôle qui compte est
 * `requireStaff()`, appelé dans les pages et dans chaque action qui écrit.
 */
export default auth.middleware({ loginUrl: '/auth/connexion' })

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
  ],
}
