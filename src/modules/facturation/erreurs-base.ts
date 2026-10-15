/**
 * Message d'une erreur levée par une garde de la base (`CA002` à `CA007`),
 * sous l'enveloppe de Drizzle. Les gardes écrivent en français ce qu'il faut
 * corriger : l'écran le reprend tel quel. Le message SQL a la forme
 * `CA003: <texte>` ; le préfixe est retiré.
 *
 * Seulement pour ces codes propres : le message d'une autre erreur MySQL
 * peut citer une valeur saisie — un IBAN, par exemple — et ne s'affiche pas.
 */
export function guardMessage(error: unknown): string | undefined {
  for (let cause: unknown = error, depth = 0; cause && depth < 10; depth++) {
    const sqlMessage = (cause as { sqlMessage?: unknown }).sqlMessage
    if (typeof sqlMessage === 'string') {
      const match = /^CA\d{3}:\s*([\s\S]*)$/.exec(sqlMessage)
      if (match) return match[1]
    }
    cause = (cause as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * Le nom d'un index ou d'une contrainte figure-t-il dans le message du
 * pilote ? `dbConstraintName()` ne lit que les messages anglais de MySQL ;
 * un serveur en `lc_messages = fr_FR` écrit « Duplicata du champ … pour la
 * clef 'table.index' ». Chercher le nom lui-même vaut pour toutes les langues.
 */
export function mentionsConstraint(error: unknown, name: string): boolean {
  for (let cause: unknown = error, depth = 0; cause && depth < 10; depth++) {
    const sqlMessage = (cause as { sqlMessage?: unknown }).sqlMessage
    if (typeof sqlMessage === 'string' && sqlMessage.includes(name)) return true
    cause = (cause as { cause?: unknown }).cause
  }
  return false
}
