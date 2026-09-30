import { createNeonAuth, type NeonAuth } from '@neondatabase/auth/next/server'

/**
 * Authentification : Neon Auth, c'est-à-dire Better Auth managé (ADR 008).
 *
 * Les utilisateurs, sessions et comptes vivent dans le schéma `neon_auth` de la
 * même base que le métier, sur la même branche : un environnement de test a ses
 * propres comptes, sans montage particulier.
 *
 * Ce module ne dit **que** qui est connecté. Savoir si cette personne a le droit
 * d'entrer dans le back-office est une autre question, traitée par
 * `src/lib/auth/staff.ts` : n'importe qui peut créer un compte, personne ne
 * devient membre de l'équipe pour autant.
 */
function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} manquant. Lancer \`neon env pull\` pour les valeurs fournies par Neon, ` +
        'et voir .env.example pour celles propres à l\'application.',
    )
  }
  return value
}

// Création paresseuse, comme le pool de `src/db/index.ts` : `next build` évalue
// ce module pour collecter la configuration des pages et ne doit pas exiger les
// secrets d'exécution. Leur absence se signale à la première requête.
let instance: NeonAuth | undefined

export function getAuth(): NeonAuth {
  instance ??= createNeonAuth({
    baseUrl: required('NEON_AUTH_BASE_URL'),
    cookies: { secret: required('NEON_AUTH_COOKIE_SECRET') },
  })
  return instance
}
