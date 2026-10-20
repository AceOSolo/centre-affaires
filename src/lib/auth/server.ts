import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { nextCookies } from 'better-auth/next-js'

import { createDatabase, databaseOptionsFromEnv } from '../../db/index.ts'
import { sendMessage } from '../courriel.ts'
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
} from './schema.ts'

/**
 * Authentification : Better Auth, hébergé par l'application, dans la même base
 * MySQL que le métier (ADR 042, qui remplace Neon Auth de l'ADR 008).
 *
 * Les comptes, sessions et vérifications vivent dans les tables `auth_*`
 * (`schema.ts`).
 *
 * Ce module ne dit **que** qui est connecté. Savoir si cette personne a le droit
 * d'entrer dans le back-office est une autre question, traitée par
 * `src/lib/auth/staff.ts` : n'importe qui peut créer un compte, personne ne
 * devient membre de l'équipe pour autant.
 */
function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} manquant (voir .env.example).`)
  }
  return value
}

/**
 * Le rattachement d'un compte à un membre se fait sur l'adresse : sans
 * vérification, quiconque s'inscrirait avec l'adresse d'un membre invité
 * prendrait sa place. La vérification est donc exigée, sauf en développement
 * où aucun courriel ne part (`AUTH_SKIP_EMAIL_VERIFICATION=true`). Cette
 * dérogation est refusée en production.
 */
export function requireEmailVerification(): boolean {
  if (process.env.AUTH_SKIP_EMAIL_VERIFICATION !== 'true') return true
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'AUTH_SKIP_EMAIL_VERIFICATION est refusé en production : il laisserait n’importe qui prendre la place d’un membre invité.',
    )
  }
  return false
}

// Création paresseuse, comme le pool de `src/db/index.ts` : `next build` évalue
// ce module pour collecter la configuration des pages et ne doit pas exiger les
// secrets d'exécution. Leur absence se signale à la première requête.
function createAuth() {
  // Pool propre à l'authentification : `src/db/index.ts` n'expose volontairement
  // pas sa base (tout le métier passe par `withTenant()`), et Better Auth gère
  // des tables sans centre.
  const { db } = createDatabase(databaseOptionsFromEnv(), { connectionLimit: 3 })
  const verify = requireEmailVerification()

  return betterAuth({
    secret: required('AUTH_SECRET'),
    baseURL: required('APP_URL'),
    database: drizzleAdapter(db, {
      provider: 'mysql',
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      requireEmailVerification: verify,
    },
    emailVerification: {
      sendOnSignUp: verify,
      sendOnSignIn: verify,
      autoSignInAfterVerification: true,
      async sendVerificationEmail({ user, url }) {
        await sendMessage({
          to: [user.email],
          subject: 'Confirmez votre adresse',
          text:
            `Bonjour,\n\nConfirmez votre adresse pour accéder à votre espace :\n${url}\n\n` +
            'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message.',
        })
      },
    },
    advanced: {
      database: { generateId: () => crypto.randomUUID() },
    },
    plugins: [nextCookies()],
  })
}

export type Auth = ReturnType<typeof createAuth>

let instance: Auth | undefined

export function getAuth(): Auth {
  instance ??= createAuth()
  return instance
}
