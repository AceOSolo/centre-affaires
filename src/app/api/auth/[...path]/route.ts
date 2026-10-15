import { toNextJsHandler } from 'better-auth/next-js'

import { getAuth } from '../../../../lib/auth/server.ts'

type Handlers = ReturnType<typeof toNextJsHandler>

// Construit à la première requête : importer cette route au build ne doit pas
// exiger les secrets d'authentification (voir `getAuth`).
let handlers: Handlers | undefined

function relay<M extends keyof Handlers>(method: M): Handlers[M] {
  return ((request: Request) => (handlers ??= toNextJsHandler(getAuth()))[method](request)) as Handlers[M]
}

/**
 * Point d'entrée de Better Auth : inscription, connexion, déconnexion,
 * vérification d'adresse. Servi par l'application elle-même, sur son domaine :
 * les cookies de session sont first-party.
 */
export const GET = relay('GET')
export const POST = relay('POST')
export const PUT = relay('PUT')
export const DELETE = relay('DELETE')
export const PATCH = relay('PATCH')
