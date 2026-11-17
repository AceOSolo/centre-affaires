import { PHONE_FORMAT_HINT, normalisePhone } from './contacts-regles.ts'

/**
 * « Mon compte » dans l'espace client (ADR 077) : ce que la personne dit
 * d'elle-même — son nom et son téléphone —, séparé de ses notifications.
 *
 * L'adresse électronique ne se change pas ici : c'est l'identifiant du compte
 * **et** la clé qui le rattache aux entreprises (`client_members.email`,
 * ADR 015). La changer depuis l'espace détacherait la personne de ses accès,
 * ou laisserait une adresse non vérifiée ouvrir un espace. Elle se change par
 * l'accueil (choix par défaut, à confirmer en recette).
 *
 * Module pur : le formulaire, l'action et les tests s'en servent.
 */

export const PROFILE_NAME_MAX = 120

export { PHONE_FORMAT_HINT }

export type ProfileField = 'fullName' | 'phone'

export const profileFieldLabels: Record<ProfileField, string> = {
  fullName: 'Prénom et nom',
  phone: 'Téléphone',
}

/** Ce que le formulaire a reçu, tel quel : réaffiché après un refus. */
export type ProfileValues = { fullName: string; phone: string }

/** Ce qui est écrit, une fois validé et mis en forme. */
export type ProfileInput = { fullName: string; phone: string | null }

export type ProfileErrors = Partial<Record<ProfileField, string>>

type FormLike = { get(name: string): FormDataEntryValue | null }

const text = (form: FormLike, key: string) => {
  const value = form.get(key)
  return typeof value === 'string' ? value : ''
}

export function readProfileForm(
  form: FormLike,
): { values: ProfileValues; input: ProfileInput; errors?: undefined } | { values: ProfileValues; input?: undefined; errors: ProfileErrors } {
  const values: ProfileValues = { fullName: text(form, 'fullName'), phone: text(form, 'phone') }
  const errors: ProfileErrors = {}

  const fullName = values.fullName.trim().replace(/\s+/g, ' ')
  if (!fullName) errors.fullName = 'Saisissez votre prénom et votre nom.'
  else if (fullName.length > PROFILE_NAME_MAX) errors.fullName = `${PROFILE_NAME_MAX} caractères au plus.`

  const phone = normalisePhone(values.phone)
  if (phone.error) errors.phone = phone.error

  if (Object.keys(errors).length > 0) return { values, errors }
  return { values, input: { fullName, phone: phone.phone } }
}
