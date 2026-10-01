import type { NeonAuth } from '@neondatabase/auth/next/server'
import type { NextRequest } from 'next/server'

import { getAuth } from './src/lib/auth/server.ts'

// Construit à la première requête : importer ce fichier au build ne doit pas
// exiger les secrets de Neon Auth (voir `getAuth`).
let middleware: ReturnType<NeonAuth['middleware']> | undefined

/**
 * Filtre d'accès au back-office (ADR 008).
 *
 * Next 16 nomme ce fichier `proxy.ts`. Il redirige vers la connexion les
 * visiteurs sans session, avant même le rendu de la page.
 *
 * Ce filtre est une commodité, pas la protection : une action serveur s'invoque
 * par son identifiant depuis n'importe quel chemin, y compris la page publique
 * que `matcher` laisse volontairement passer. Le contrôle qui compte est
 * `requirePermission()`, appelé dans les pages et dans chaque action serveur
 * (ADR 019).
 */
export default function proxy(request: NextRequest) {
  middleware ??= getAuth().middleware({ loginUrl: '/auth/connexion' })
  return middleware(request)
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
    '/indicateurs/:path*',
    '/equipe/:path*',
    '/configuration/:path*',
    '/paiements/:path*',
    '/comptabilite/:path*',
    '/acces-reserve/:path*',
    // L'espace client : même commodité, même limite — les pages et les
    // actions revérifient le compte elles-mêmes (ADR 015).
    '/compte/:path*',
  ],
}
