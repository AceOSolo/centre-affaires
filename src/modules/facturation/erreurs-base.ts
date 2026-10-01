/**
 * Message d'une erreur levée par une garde de la base (`CA002` à `CA007`),
 * sous l'enveloppe de Drizzle. Les gardes écrivent en français ce qu'il faut
 * corriger (migration 0031) : l'écran le reprend tel quel.
 *
 * Seulement pour ces codes propres : le message d'une autre erreur Postgres
 * peut citer une valeur saisie — un IBAN, par exemple — et ne s'affiche pas.
 */
export function guardMessage(error: unknown): string | undefined {
  for (let cause: unknown = error, depth = 0; cause && depth < 10; depth++) {
    const code = (cause as { code?: unknown }).code
    const message = (cause as { message?: unknown }).message
    if (typeof code === 'string' && /^CA\d{3}$/.test(code) && typeof message === 'string') {
      return message
    }
    cause = (cause as { cause?: unknown }).cause
  }
  return undefined
}
