/**
 * Règles de saisie d'un contact d'entreprise cliente (R07).
 *
 * Sans dépendance à Next ni à la base : le formulaire du back-office et les
 * tests passent par les mêmes fonctions. L'unicité du contact principal, elle,
 * est tenue par la base (`client_contacts_primary_key`) et par
 * `contacts-queries.ts`, qui transfère le rôle.
 */

/** Ce que le formulaire a reçu, tel quel : réaffiché après un refus. */
export type ContactValues = {
  fullName: string
  jobTitle: string
  email: string
  phone: string
  isPrimary: boolean
  isBilling: boolean
  notes: string
}

/** Ce qui est écrit en base, une fois validé et normalisé. */
export type ContactInput = {
  fullName: string
  jobTitle: string | null
  email: string | null
  phone: string | null
  isPrimary: boolean
  isBilling: boolean
  notes: string | null
}

export type ContactField = 'fullName' | 'email' | 'phone'
export type ContactFieldErrors = Partial<Record<ContactField, string>>

/** Libellés du résumé d'erreurs : ceux des champs, pour que le lien se lise seul. */
export const contactFieldLabels: Record<ContactField, string> = {
  fullName: 'Nom',
  email: 'Courriel',
  phone: 'Téléphone',
}

/**
 * Même contrôle que pour les accès à l'espace client (`comptes-actions.ts`) :
 * une forme plausible, pas une vérification. Une adresse se vérifie en y
 * écrivant, pas avec une expression régulière.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Longueur maximale d'une adresse électronique (RFC 5321). */
const EMAIL_MAX_LENGTH = 254

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase()
}

export function isValidEmail(value: string): boolean {
  return value.length <= EMAIL_MAX_LENGTH && EMAIL.test(value)
}

/** Séparateurs tolérés à la saisie d'un numéro : espace, point, tiret, barre, parenthèses. */
const PHONE_CHARACTERS = /^\+?[\d\s.\-/()]+$/

export const PHONE_FORMAT_HINT =
  '10 chiffres (01 23 45 67 89), ou format international (+32 2 123 45 67).'

/** « 0123456789 » → « 01 23 45 67 89 ». */
function groupByPairs(digits: string): string {
  return digits.replace(/(\d{2})(?=\d)/g, '$1 ')
}

/**
 * Valide et met en forme un numéro de téléphone.
 *
 * - Vide : pas de numéro, ce n'est pas une erreur.
 * - Sans indicatif : un numéro français à 10 chiffres commençant par 0. Un
 *   numéro étranger sans indicatif serait ambigu ; il se saisit en `+`.
 * - Avec indicatif (`+` ou `00`) : 8 à 15 chiffres, la limite de la norme E.164.
 *   Un numéro en `+33` doit avoir ses 9 chiffres ; le 0 de la notation
 *   « +33 (0)1… » est retiré.
 *
 * Un numéro français est rangé sous une forme unique, « 01 23 45 67 89 » ou
 * « +33 1 23 45 67 89 ». Un numéro étranger garde le découpage saisi, les
 * séparateurs ramenés à une espace : chaque pays groupe ses chiffres à sa façon.
 */
export function normalisePhone(raw: string): { phone: string | null; error?: string } {
  const value = raw.trim()
  if (!value) return { phone: null }

  if (!PHONE_CHARACTERS.test(value)) {
    return {
      phone: null,
      error: 'Le numéro ne peut contenir que des chiffres, des espaces, des points ou des tirets, et un + en tête.',
    }
  }

  // « +33 (0)1 23 45 67 89 » : le 0 entre parenthèses ne se compose pas.
  const withoutTrunk = value.replace(/^((?:\+|00)\d{1,3})\s*\(0\)\s*/, '$1 ')
  let digits = withoutTrunk.replace(/\D/g, '')
  // Ce qui suit le préfixe international, « + » ou « 00 », avec son découpage.
  let body = withoutTrunk.slice(1)
  let international = withoutTrunk.startsWith('+')
  if (!international && digits.startsWith('00')) {
    international = true
    digits = digits.slice(2)
    body = withoutTrunk.replace(/^\D*0\D*0/, '')
  }

  const invalid = { phone: null, error: `Numéro incomplet ou trop long : ${PHONE_FORMAT_HINT}` }

  if (!international) {
    if (!/^0\d{9}$/.test(digits)) return invalid
    return { phone: groupByPairs(digits) }
  }

  if (digits.startsWith('33')) {
    // « +33 01 23 45 67 89 » : le 0 national ajouté par habitude.
    let national = digits.slice(2)
    if (national.length === 10 && national.startsWith('0')) national = national.slice(1)
    if (!/^[1-9]\d{8}$/.test(national)) return invalid
    return { phone: `+33 ${national[0]} ${groupByPairs(national.slice(1))}` }
  }

  if (digits.length < 8 || digits.length > 15) return invalid
  const grouped = body
    .split(/[\s.\-/()]+/)
    .filter(Boolean)
    .join(' ')
  return { phone: `+${grouped}` }
}

/** Lien `tel:` d'un numéro rangé par `normalisePhone` : chiffres et `+` seulement. */
export function phoneHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`
}

type FormLike = { get(name: string): FormDataEntryValue | null }

function text(form: FormLike, key: string): string {
  const value = form.get(key)
  return typeof value === 'string' ? value.trim() : ''
}

/** Une case cochée est envoyée, une case décochée est absente du formulaire. */
function checked(form: FormLike, key: string): boolean {
  return form.get(key) !== null
}

/**
 * Lecture du formulaire de contact. Rend les erreurs de tous les champs d'un
 * coup : corriger un champ pour en découvrir un second au renvoi suivant est
 * le défaut que le résumé d'erreurs doit éviter.
 */
export function readContactForm(
  form: FormLike,
): { values: ContactValues; input: ContactInput; fieldErrors?: undefined } | { values: ContactValues; fieldErrors: ContactFieldErrors } {
  const values: ContactValues = {
    fullName: text(form, 'fullName').replace(/\s+/g, ' '),
    jobTitle: text(form, 'jobTitle'),
    email: text(form, 'email'),
    phone: text(form, 'phone'),
    isPrimary: checked(form, 'isPrimary'),
    isBilling: checked(form, 'isBilling'),
    notes: text(form, 'notes'),
  }

  const fieldErrors: ContactFieldErrors = {}
  if (!values.fullName) fieldErrors.fullName = 'Saisissez le nom du contact.'

  const email = normaliseEmail(values.email)
  if (email && !isValidEmail(email)) {
    fieldErrors.email = 'Saisissez une adresse électronique valide, comme nom@entreprise.fr.'
  }

  const phone = normalisePhone(values.phone)
  if (phone.error) fieldErrors.phone = phone.error

  if (Object.keys(fieldErrors).length > 0) return { values, fieldErrors }

  return {
    values,
    input: {
      fullName: values.fullName,
      jobTitle: values.jobTitle || null,
      email: email || null,
      phone: phone.phone,
      isPrimary: values.isPrimary,
      isBilling: values.isBilling,
      notes: values.notes || null,
    },
  }
}
