import type { NeonAuth } from '@neondatabase/auth/next/server'

import { getAuth } from '../../../../lib/auth/server.ts'

type Handlers = ReturnType<NeonAuth['handler']>

// Construit à la première requête : importer cette route au build ne doit pas
// exiger les secrets de Neon Auth (voir `getAuth`).
let handlers: Handlers | undefined

function relay<M extends keyof Handlers>(method: M): Handlers[M] {
  return (request, context) => (handlers ??= getAuth().handler())[method](request, context)
}

/**
 * Relais same-origin vers Neon Auth.
 *
 * Le navigateur ne parle jamais directement au service d'authentification : il
 * passe par ce chemin, sur notre domaine. C'est ce qui permet au SDK de poser
 * des cookies de session first-party plutôt que de dépendre des cookies tiers,
 * bloqués par une partie des navigateurs.
 */
export const GET = relay('GET')
export const POST = relay('POST')
export const PUT = relay('PUT')
export const DELETE = relay('DELETE')
export const PATCH = relay('PATCH')
