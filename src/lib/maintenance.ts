import { timingSafeEqual } from 'node:crypto'

/**
 * Accès aux routes de maintenance (`/api/maintenance/*`), appelées par les
 * tâches planifiées du serveur (infra/serveur/README.md) avec le jeton
 * `MAINTENANCE_TOKEN`. Sans jeton configuré, aucune ne répond : elles ne
 * doivent jamais être joignables sans secret.
 */
export function isMaintenanceRequest(request: Request): boolean {
  return hasBearerToken(request, process.env.MAINTENANCE_TOKEN)
}

/**
 * Vrai si la requête porte `Authorization: Bearer <expected>`. Sans jeton
 * configuré, toujours faux : une route protégée ne s'ouvre jamais par oubli.
 * Sert aussi l'API de Dolibarr (`DOLIBARR_API_TOKEN`, ADR 043).
 */
export function hasBearerToken(request: Request, expected: string | undefined): boolean {
  if (!expected) return false
  return sameToken(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '', expected)
}

/**
 * Comme `hasBearerToken`, ou le jeton dans l'adresse (`?jeton=…`) : le module
 * Webhook de Dolibarr ne sait poser aucun en-tête (ADR 049). L'adresse finit
 * dans les journaux d'Apache et dans l'historique des webhooks de Dolibarr :
 * réservé aux routes qui n'écrivent que ce que Dolibarr fait déjà foi.
 */
export function hasBearerOrQueryToken(request: Request, expected: string | undefined): boolean {
  if (!expected) return false
  if (hasBearerToken(request, expected)) return true
  // Un jeton en base64 collé tel quel dans l'adresse : son « + » se lit comme
  // une espace. Un jeton n'en contient jamais, il est rendu à l'identique.
  const given = (new URL(request.url).searchParams.get('jeton') ?? '').replaceAll(' ', '+')
  return sameToken(given, expected)
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  // Comparaison à temps constant : la durée de la réponse ne doit pas
  // renseigner sur le nombre de caractères justes.
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Réponse d'une route de maintenance sans jeton valide : elle n'existe pas. */
export function maintenanceNotFound(): Response {
  return new Response('Introuvable.', { status: 404 })
}
