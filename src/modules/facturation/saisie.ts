import { addDaysToIsoDate, isCalendarDate } from '../../lib/dates.ts'
import {
  basisPointsToInput,
  centsToInput,
  formatBasisPoints,
  parsePercentToBasisPoints,
} from './tarifs.ts'

/**
 * Lecture des saisies d'argent, de taux et de dates des formulaires de la
 * facturation : catalogue de services, offres groupées, souscriptions.
 *
 * Tout ce qui entre en base est entier — centimes, points de base, quantités
 * (décision 5, ADR 023). La conversion se fait ici, par les chaînes, jamais par
 * un flottant : « 19,99 » × 100 ne doit pas devenir 1998,9999.
 *
 * Module pur, sans Next ni base : les actions serveur, les formulaires et les
 * tests passent par les mêmes fonctions.
 */

/** Plafond d'une colonne `integer` : au-delà, la base lèverait une erreur brute. */
export const MAX_INTEGER = 2_147_483_647

/** Points de base d'un taux de 100 % : 10 000. */
export const BASIS_POINTS_PER_UNIT = 10_000

/**
 * Lit un pourcentage saisi et le rend en points de base : « 20 » → 2000,
 * « 5,5 » → 550, « 12,25 % » → 1225. Deux décimales au plus : un point de
 * base est la plus petite unité que la base connaisse.
 *
 * Rend `undefined` sur une saisie illisible ou hors de 0 à 100 %.
 */
export const parsePercentToBp = parsePercentToBasisPoints

/** 2000 → « 20 », 550 → « 5,5 », 1225 → « 12,25 » : la forme de saisie. */
export const bpToPercentInput = basisPointsToInput

/** 2000 → « 20 % », 550 → « 5,5 % » : affichage d'un taux. */
export const formatBp = (bp: number): string => formatBasisPoints(bp)

/** 1999 → « 19,99 » : un montant en centimes rendu au format de saisie. */
export const centsToAmountInput = centsToInput

/**
 * Lit une quantité entière : « 3 » → 3. Rend `undefined` pour une saisie qui
 * n'est pas un entier, ou qui sort de `[min, MAX_INTEGER]`.
 */
export function parseInteger(input: string, min = 0): number | undefined {
  const cleaned = input.replace(/\s| /g, '')
  if (!/^\d+$/.test(cleaned)) return undefined
  const value = Number(cleaned)
  if (!Number.isSafeInteger(value) || value < min || value > MAX_INTEGER) return undefined
  return value
}

/** Une date de calendrier qui existe : « 2026-02-30 » est refusé ici, pas en base. */
export const isIsoDate = isCalendarDate

/** Décale un jour ISO, sans fuseau : arithmétique de calendrier pure. */
export const shiftIsoDate = addDaysToIsoDate

/** « 1 oct. 2026 » : affichage d'une date de calendrier, sans fuseau. */
export function formatCalendarDay(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day, 12)))
}

/** Ce qu'il faut d'un formulaire pour le lire : `FormData` ou un équivalent de test. */
export type FormLike = { get(name: string): FormDataEntryValue | null }

/** Valeur texte d'un champ, sans espaces en bord. */
export function field(form: FormLike, key: string): string {
  const value = form.get(key)
  return typeof value === 'string' ? value.trim() : ''
}

/** Une case cochée est envoyée, une case décochée est absente du formulaire. */
export function checked(form: FormLike, key: string): boolean {
  return form.get(key) !== null
}
