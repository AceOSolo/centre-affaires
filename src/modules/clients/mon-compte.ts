import { PHONE_FORMAT_HINT, normalisePhone } from './contacts-regles.ts'
import { joinName, nameErrors, tidyNamePart } from './prenom-nom.ts'

/**
 * « Mon compte » dans l'espace client (ADR 077) : ce que la personne dit
 * d'elle-même — son prénom, son nom et son téléphone —, séparé de ses
 * notifications. Prénom et nom sont deux champs (ADR 084) : ils pré-remplissent
 * les demandes faites depuis la page publique.
 *
 * L'adresse électronique ne se change pas ici : c'est l'identifiant du compte
 * **et** la clé qui le rattache aux entreprises (`client_members.email`,
 * ADR 015). La changer depuis l'espace détacherait la personne de ses accès,
 * ou laisserait une adresse non vérifiée ouvrir un espace. Elle se change par
 * l'accueil (choix par défaut, à confirmer en recette).
 *
 * Module pur : le formulaire, l'action et les tests s'en servent.
 */

export { NAME_PART_MAX } from './prenom-nom.ts'
export { PHONE_FORMAT_HINT }

export type ProfileField = 'firstName' | 'lastName' | 'phone'

export const profileFieldLabels: Record<ProfileField, string> = {
  firstName: 'Prénom',
  lastName: 'Nom',
  phone: 'Téléphone',
}

/** Ce que le formulaire a reçu, tel quel : réaffiché après un refus. */
export type ProfileValues = { firstName: string; lastName: string; phone: string }

/** Ce qui est écrit, une fois validé et mis en forme ; le nom complet est recomposé. */
export type ProfileInput = { firstName: string; lastName: string; fullName: string; phone: string | null }

export type ProfileErrors = Partial<Record<ProfileField, string>>

type FormLike = { get(name: string): FormDataEntryValue | null }

const text = (form: FormLike, key: string) => {
  const value = form.get(key)
  return typeof value === 'string' ? value : ''
}

export function readProfileForm(
  form: FormLike,
): { values: ProfileValues; input: ProfileInput; errors?: undefined } | { values: ProfileValues; input?: undefined; errors: ProfileErrors } {
  const values: ProfileValues = { firstName: text(form, 'firstName'), lastName: text(form, 'lastName'), phone: text(form, 'phone') }
  const errors: ProfileErrors = nameErrors(values)

  const phone = normalisePhone(values.phone)
  if (phone.error) errors.phone = phone.error

  if (Object.keys(errors).length > 0) return { values, errors }
  const firstName = tidyNamePart(values.firstName)
  const lastName = tidyNamePart(values.lastName)
  return { values, input: { firstName, lastName, fullName: joinName({ firstName, lastName }), phone: phone.phone } }
}
