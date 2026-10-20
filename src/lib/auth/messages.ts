/**
 * Refus du service d'authentification (Better Auth), dits en français aux
 * formulaires de connexion, d'inscription et de mot de passe oublié.
 *
 * Better Auth répond en anglais (« Invalid email or password », « User
 * already exists ») : le message affiché est choisi par le `code` du refus,
 * stable d'une version à l'autre, jamais repris de la réponse — sauf pour les
 * codes posés par le projet (`server.ts`), dont le message est déjà en
 * français.
 *
 * Sans dépendance au serveur : les formulaires l'importent dans le navigateur.
 */

/** Longueur minimale d'un mot de passe : imposée par `server.ts`, annoncée par les formulaires. */
export const MOT_DE_PASSE_MIN = 10

/** Ce que le client d'authentification rend dans `error`. */
export type RefusAuth = { code?: string; message?: string; status?: number }

/** Champ concerné par le refus : l'erreur se place à côté de lui. */
export type ChampAuth = 'email' | 'password'

export type MessageAuth = { message: string; champ?: ChampAuth }

/** Codes du projet (`server.ts`) : leur message, en français, est gardé tel quel. */
const CODES_DU_PROJET = new Set(['PREUVE_HUMAINE', 'BANNED_USER'])

/** Plafond de tentatives atteint (`rateLimit`, `server.ts`) : Better Auth répond 429. */
export const tropDeTentatives =
  'Trop de tentatives depuis votre connexion. Patientez quelques minutes, puis réessayez.'

/** Exception réseau : la requête n'a pas abouti du tout. */
export const serveurInjoignable =
  'Le serveur ne répond pas. Vérifiez votre connexion à internet, puis réessayez.'

const lienPerime = 'Ce lien n’est plus valable : il a déjà servi ou a expiré. Demandez-en un nouveau.'
const compteExistant =
  'Un compte existe déjà avec cette adresse. Connectez-vous, ou choisissez « Mot de passe oublié ? ».'
const requeteRefusee = 'Demande refusée par sécurité. Rechargez la page, puis réessayez.'

const PAR_CODE: Record<string, MessageAuth> = {
  // Connexion. Le message ne dit pas lequel des deux est faux : il
  // renseignerait sur les adresses inscrites.
  INVALID_EMAIL_OR_PASSWORD: { message: 'Adresse ou mot de passe incorrect.' },
  EMAIL_NOT_VERIFIED: {
    message: 'Adresse non confirmée : ouvrez le message de confirmation reçu, puis réessayez.',
  },
  // Inscription.
  USER_ALREADY_EXISTS: { message: compteExistant, champ: 'email' },
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: { message: compteExistant, champ: 'email' },
  INVALID_EMAIL: { message: 'Cette adresse électronique n’est pas valide.', champ: 'email' },
  INVALID_PASSWORD: { message: 'Saisissez un mot de passe.', champ: 'password' },
  PASSWORD_TOO_SHORT: {
    message: `Mot de passe trop court : ${MOT_DE_PASSE_MIN} caractères au minimum.`,
    champ: 'password',
  },
  PASSWORD_TOO_LONG: { message: 'Mot de passe trop long : 128 caractères au maximum.', champ: 'password' },
  // Lien de réinitialisation.
  INVALID_TOKEN: { message: lienPerime },
  TOKEN_EXPIRED: { message: lienPerime },
  // Garde de l'origine de la requête.
  INVALID_ORIGIN: { message: requeteRefusee },
  MISSING_OR_NULL_ORIGIN: { message: requeteRefusee },
  CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: { message: requeteRefusee },
  // Codes du projet, au cas où leur message manquerait.
  BANNED_USER: { message: 'Ce compte est suspendu. Pour en savoir plus, contactez l’équipe du centre.' },
  PREUVE_HUMAINE: {
    message:
      'La vérification anti-robot n’a pas abouti ou a expiré. Attendez que la case « Je ne suis pas un robot » se coche, puis réessayez.',
  },
}

/**
 * Message à afficher pour un refus. `repli` dit l'échec dans les termes du
 * formulaire (« La création du compte a échoué. ») quand le code est inconnu.
 */
export function messageRefusAuth(refus: RefusAuth | null | undefined, repli: string): MessageAuth {
  if (refus?.status === 429) return { message: tropDeTentatives }
  const code = refus?.code
  if (!code) return { message: repli }
  if (CODES_DU_PROJET.has(code) && refus.message) return { message: refus.message }
  return PAR_CODE[code] ?? { message: repli }
}
