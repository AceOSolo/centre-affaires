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
  const given = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
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
