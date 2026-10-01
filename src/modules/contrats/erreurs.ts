/**
 * Message en français d'un refus métier de la base (ADR 025).
 *
 * Les gardes de la migration 0031 lèvent des SQLSTATE propres (`CA004`
 * engagement figé, `CA005` avenant refusé) avec un message qui dit quoi
 * corriger. Drizzle enveloppe l'erreur du pilote : le message d'origine est
 * dans la chaîne des `cause`, sur l'objet qui porte le SQLSTATE.
 *
 * Rend `undefined` si l'erreur n'est pas une erreur de la base, ou si son
 * code n'est pas l'un de `codes` : une panne doit remonter, pas s'afficher.
 */
export function pgRefusalMessage(error: unknown, codes: readonly string[]): string | undefined {
  // La borne coupe une chaîne de `cause` circulaire.
  for (let cause: unknown = error, depth = 0; cause && depth < 10; depth++) {
    const { code, message } = cause as { code?: unknown; message?: unknown }
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return codes.includes(code) && typeof message === 'string' && message ? message : undefined
    }
    cause = (cause as { cause?: unknown }).cause
  }
  return undefined
}
