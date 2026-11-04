import type { MailCategory } from './categories.ts'
import { mailCategoryLabels } from './labels.ts'

/**
 * Catégories personnelles du courrier côté client (ADR 060) : celles qu'une
 * personne crée, renomme et supprime dans son espace, et qui se mêlent à la
 * liste de départ (`categories.ts`). Sans base ni framework, éprouvé seul
 * (`categories-perso-regles.test.ts`).
 */

/** Vingt catégories par personne et par entreprise : assez pour ranger, pas pour noyer les rubriques. */
export const MAX_CUSTOM_CATEGORIES = 20
/** Le nom tient dans la colonne des rubriques, au téléphone comme à l'écran. */
export const MAX_CUSTOM_CATEGORY_LENGTH = 40

/** Identifiant d'une catégorie personnelle : un UUID, ce qui la distingue d'une clé de départ. */
export type CustomCategoryId = `${string}-${string}-${string}-${string}-${string}`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isCustomCategoryId(value: string | undefined | null): value is CustomCategoryId {
  return typeof value === 'string' && UUID.test(value)
}

/** Une catégorie personnelle, telle que l'espace client la montre. */
export type CustomCategory = {
  id: string
  /** Entreprise de l'accès qui la porte : une personne de deux sociétés a deux listes. */
  clientId: string
  name: string
}

/** Espaces resserrés, sans blanc autour : la forme enregistrée. */
export function cleanCategoryName(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

/** Même nom, à la casse près : la règle de la base (collation insensible à la casse, pas aux accents). */
export function sameCategoryName(a: string, b: string): boolean {
  return cleanCategoryName(a).toLocaleLowerCase('fr') === cleanCategoryName(b).toLocaleLowerCase('fr')
}

/** Noms réservés : ceux de la liste de départ, et « Non classé ». */
const reservedNames: readonly string[] = [
  ...(Object.values(mailCategoryLabels) as string[]),
  'Non classé',
  'Non classe',
]

/**
 * Le nom saisi, nettoyé, ou l'erreur à afficher : vide, trop long, déjà pris
 * par la liste de départ ou par une autre catégorie de la personne. `exceptId`
 * : la catégorie que l'on renomme, qui peut garder son nom (changer sa casse).
 */
export function validateCategoryName(
  input: string,
  existing: readonly Pick<CustomCategory, 'id' | 'name'>[],
  exceptId?: string,
): { name: string; error?: undefined } | { name?: undefined; error: string } {
  const name = cleanCategoryName(input)
  if (name === '') return { error: 'Saisissez le nom de la catégorie.' }
  if (name.length > MAX_CUSTOM_CATEGORY_LENGTH) {
    return { error: `Le nom tient en ${MAX_CUSTOM_CATEGORY_LENGTH} caractères au plus (${name.length}).` }
  }
  const reserved = reservedNames.find((other) => sameCategoryName(other, name))
  if (reserved) return { error: `« ${reserved} » fait déjà partie des catégories proposées.` }
  const taken = existing.find((other) => other.id !== exceptId && sameCategoryName(other.name, name))
  if (taken) return { error: `Vous avez déjà une catégorie « ${taken.name} ».` }
  return { name }
}

/** Peut-on en créer une de plus ? */
export function canCreateCategory(count: number): boolean {
  return count < MAX_CUSTOM_CATEGORIES
}

/** Nom d'une rubrique : catégorie de départ, catégorie personnelle, ou rien. */
export function categoryName(
  classification: { category: MailCategory | null; customCategoryId: string | null },
  custom: readonly Pick<CustomCategory, 'id' | 'name'>[],
): string | null {
  if (classification.category) return mailCategoryLabels[classification.category]
  if (classification.customCategoryId) {
    return custom.find((entry) => entry.id === classification.customCategoryId)?.name ?? null
  }
  return null
}
