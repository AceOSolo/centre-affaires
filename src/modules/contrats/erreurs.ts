import { dbErrorCode } from '../../db/errors.ts'

/**
 * Message en français d'un refus métier de la base (ADR 025).
 *
 * Les gardes de `src/db/regles/40-contrats.sql` lèvent des codes propres
 * (`CA004` engagement figé, `CA005` avenant refusé) avec un message qui dit
 * quoi corriger : `SIGNAL … MESSAGE_TEXT = 'CA004: …'`. Drizzle enveloppe
 * l'erreur du pilote : le message d'origine est dans la chaîne des `cause`,
 * sur l'objet qui porte `sqlMessage`.
 *
 * Rend `undefined` si l'erreur n'est pas une erreur de la base, ou si son
 * code n'est pas l'un de `codes` : une panne doit remonter, pas s'afficher.
 * Le préfixe `CAnnn: ` est retiré : il identifie la règle, il ne se lit pas.
 */
export function dbRefusalMessage(error: unknown, codes: readonly string[]): string | undefined {
  const code = dbErrorCode(error)
  if (!code || !codes.includes(code)) return undefined
  // La borne coupe une chaîne de `cause` circulaire.
  for (let cause: unknown = error, depth = 0; cause && depth < 10; depth++) {
    const { sqlMessage } = cause as { sqlMessage?: unknown }
    if (typeof sqlMessage === 'string' && sqlMessage) {
      return sqlMessage.replace(/^CA\d{3}:\s*/, '')
    }
    cause = (cause as { cause?: unknown }).cause
  }
  return undefined
}
