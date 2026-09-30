/**
 * Les identifiants viennent de l'URL ou d'un champ caché. Un texte qui n'est
 * pas un UUID fait lever Postgres (`22P02`) et finit en erreur 500, là où la
 * page doit répondre « introuvable ».
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string | undefined | null): value is string {
  return typeof value === 'string' && UUID.test(value)
}
