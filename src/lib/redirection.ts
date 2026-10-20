/**
 * Chemin de retour après connexion, lu dans l'URL (`?redirect=`).
 *
 * N'importe qui peut fabriquer cette URL : seul un chemin du site est suivi.
 * `https://…`, `//autre-site` ou `/\autre-site` enverraient la personne
 * ailleurs juste après qu'elle a saisi son mot de passe. Rend `null` quand le
 * chemin n'est pas sûr ; l'appelant choisit alors sa destination par défaut.
 */
export function safeRedirect(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/')) return null
  if (value.startsWith('//') || value.startsWith('/\\')) return null
  return value
}
