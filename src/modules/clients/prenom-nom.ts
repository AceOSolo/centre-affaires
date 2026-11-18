/**
 * Prénom et nom d'une personne, toujours saisis dans deux champs (ADR 084).
 *
 * Le nom complet (`full_name`) reste écrit à côté, recomposé « Prénom Nom » :
 * c'est lui que lisent la fiche du client, les demandes et les courriels.
 *
 * Module pur : formulaires, actions et tests s'en servent.
 */

export const NAME_PART_MAX = 100

export type PersonName = { firstName: string; lastName: string }

/** Espaces de tête, de queue et en double retirés. */
export const tidyNamePart = (value: string) => value.trim().replace(/\s+/g, ' ')

/** « Prénom Nom », ou celui des deux qui est renseigné. */
export function joinName({ firstName, lastName }: PersonName): string {
  return [tidyNamePart(firstName), tidyNamePart(lastName)].filter(Boolean).join(' ')
}

/**
 * Prénom et nom d'une personne dont on ne connaît que le nom complet (comptes
 * ouverts avant l'ADR 084) : le premier mot en prénom, le reste en nom. Ce
 * n'est qu'une proposition pré-remplie, que la personne corrige avant
 * d'envoyer ; elle n'est jamais écrite en base telle quelle.
 */
export function splitFullName(fullName: string | null | undefined): PersonName {
  const words = tidyNamePart(fullName ?? '').split(' ').filter(Boolean)
  if (words.length < 2) return { firstName: words[0] ?? '', lastName: '' }
  return { firstName: words[0], lastName: words.slice(1).join(' ') }
}

/** Erreurs de saisie du prénom et du nom, rangées par champ. */
export function nameErrors(name: PersonName): Partial<Record<keyof PersonName, string>> {
  const errors: Partial<Record<keyof PersonName, string>> = {}
  const firstName = tidyNamePart(name.firstName)
  const lastName = tidyNamePart(name.lastName)
  if (!firstName) errors.firstName = 'Saisissez votre prénom.'
  else if (firstName.length > NAME_PART_MAX) errors.firstName = `${NAME_PART_MAX} caractères au plus.`
  if (!lastName) errors.lastName = 'Saisissez votre nom.'
  else if (lastName.length > NAME_PART_MAX) errors.lastName = `${NAME_PART_MAX} caractères au plus.`
  return errors
}

/**
 * Prénom et nom connus d'une personne : ceux de ses accès, sinon tirés du nom
 * de son compte (« Bonjour » de l'accueil, inscription).
 */
export function nameOf(profile: PersonName, accountName: string | null | undefined): PersonName {
  return profile.firstName || profile.lastName
    ? { firstName: profile.firstName, lastName: profile.lastName }
    : splitFullName(accountName)
}
