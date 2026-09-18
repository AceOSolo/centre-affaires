import { auth } from '../../../../lib/auth/server.ts'

/**
 * Relais same-origin vers Neon Auth.
 *
 * Le navigateur ne parle jamais directement au service d'authentification : il
 * passe par ce chemin, sur notre domaine. C'est ce qui permet au SDK de poser
 * des cookies de session first-party plutôt que de dépendre des cookies tiers,
 * bloqués par une partie des navigateurs.
 */
export const { GET, POST, PUT, DELETE, PATCH } = auth.handler()
