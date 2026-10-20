import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { nextCookies } from 'better-auth/next-js'

import { createDatabase, databaseOptionsFromEnv, withTenant, type Database } from '../../db/index.ts'
import { activeBan } from '../../modules/comptes/comptes.ts'
import { adresseIpDerriereLeRelais } from '../anti-robot.ts'
import { EN_TETE_PREUVE } from '../champs-anti-robot.ts'
import { sendMessage } from '../courriel.ts'
import { preuveHumaine } from '../preuve-humaine.ts'
import { currentTenantId } from '../tenant.ts'
import { MOT_DE_PASSE_MIN } from './messages.ts'
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
 * Chemins qui font partir un courriel vers une adresse saisie par un
 * inconnu : pas d'appel sans preuve ALTCHA (ADR 047). Un robot ne doit pas
 * pouvoir en faire partir des milliers.
 */
const CHEMINS_SOUS_PREUVE = new Set(['/sign-up/email', '/request-password-reset'])

/** Validité du lien de réinitialisation, annoncée dans le courriel. */
const LIEN_REINITIALISATION_SECONDES = 3600

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
//
// Exportée pour les tests, qui lui passent la base de test.
export function createAuth(
  // Pool propre à l'authentification : `src/db/index.ts` n'expose volontairement
  // pas sa base (tout le métier passe par `withTenant()`), et Better Auth gère
  // des tables sans centre.
  db: Database = createDatabase(databaseOptionsFromEnv(), { connectionLimit: 3 }).db,
) {
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
      minPasswordLength: MOT_DE_PASSE_MIN,
      requireEmailVerification: verify,
      // Mot de passe oublié (`app/(auth)/auth/mot-de-passe-oublie`). Better
      // Auth répond de la même façon que l'adresse ait un compte ou non ;
      // l'envoi n'est pas attendu, pour que la durée de la réponse ne le
      // dise pas non plus. `sendMessage` ne lève jamais.
      resetPasswordTokenExpiresIn: LIEN_REINITIALISATION_SECONDES,
      async sendResetPassword({ user, url }) {
        void sendMessage({
          to: [user.email],
          subject: 'Choisissez un nouveau mot de passe',
          text:
            `Bonjour,\n\nPour choisir un nouveau mot de passe, ouvrez ce lien dans l’heure :\n${url}\n\n` +
            'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.',
        })
      },
      // Une réinitialisation suit souvent un doute sur le compte : les
      // sessions ouvertes avec l'ancien mot de passe sont fermées.
      revokeSessionsOnPasswordReset: true,
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
    // Raison sociale saisie à l'inscription libre (ADR 045) : la fiche client
    // n'est créée qu'une fois l'adresse confirmée (`modules/comptes/inscription.ts`).
    user: {
      additionalFields: {
        companyName: { type: 'string', required: false, input: true },
      },
    },
    hooks: {
      // Pas d'inscription ni de demande de réinitialisation sans preuve
      // ALTCHA (ADR 047) : le formulaire joint la réponse du widget à la
      // requête (`CHEMINS_SOUS_PREUVE`).
      before: createAuthMiddleware(async (ctx) => {
        if (!CHEMINS_SOUS_PREUVE.has(ctx.path)) return
        if (!(await preuveHumaine().verifier(ctx.headers?.get(EN_TETE_PREUVE)))) {
          throw APIError.from('BAD_REQUEST', {
            message: 'La vérification anti-robot n’a pas abouti ou a expiré. Attendez que la case « Je ne suis pas un robot » se coche, puis réessayez.',
            code: 'PREUVE_HUMAINE',
          })
        }
      }),
    },
    databaseHooks: {
      session: {
        create: {
          // Un compte banni par l'équipe n'ouvre plus de session (ADR 045). Les
          // sessions en cours sont supprimées au bannissement
          // (`banAccounts`) ; ce refus couvre les suivantes.
          async before(session) {
            const ban = await withTenant(currentTenantId(), (tx) => activeBan(tx, session.userId))
            if (ban) {
              throw APIError.from('FORBIDDEN', {
                message: 'Ce compte est suspendu. Pour en savoir plus, contactez l’équipe du centre.',
                code: 'BANNED_USER',
              })
            }
          },
        },
      },
    },
    // Contre les robots (`lib/anti-robot.ts`) : Better Auth compte les appels
    // par adresse IP, en production seulement. Ses plafonds par défaut (trois
    // essais en dix secondes, plus d'un millier par heure) sont resserrés là
    // où un robot gagne quelque chose : deviner un mot de passe, créer des
    // comptes en série, ou faire partir des courriels vers n'importe quelle
    // adresse. En mémoire : un seul conteneur (ADR 013).
    rateLimit: {
      customRules: {
        '/sign-in/email': { window: 300, max: 10 },
        '/sign-up/email': { window: 3600, max: 5 },
        '/send-verification-email': { window: 900, max: 3 },
        '/request-password-reset': { window: 900, max: 3 },
      },
    },
    advanced: {
      database: { generateId: () => crypto.randomUUID() },
      ipAddress: adresseIpDerriereLeRelais,
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
