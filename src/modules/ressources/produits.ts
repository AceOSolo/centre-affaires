import type { ResourceType } from './schema.ts'

/**
 * Les produits du centre, tels que l'accueil les vend (ADR 046) : c'est par
 * eux que le back-office est rangé. Un produit regroupe un ou plusieurs types
 * de ressource ; tous les types en font partie, une seule fois.
 *
 * Le type reste la valeur stockée (décision 2, une seule table) : le produit
 * n'est qu'un regroupement d'affichage, il ne s'écrit jamais en base.
 */
export const products = [
  { key: 'salles', label: 'Salles', types: ['salle'] },
  { key: 'bureaux', label: 'Bureaux', types: ['bureau', 'casier'] },
  { key: 'domiciliation', label: 'Domiciliation', types: ['boite_aux_lettres'] },
  { key: 'vehicules', label: 'Camion', types: ['vehicule'] },
] as const satisfies readonly { key: string; label: string; types: readonly ResourceType[] }[]

export type ProductKey = (typeof products)[number]['key']

export type Product = (typeof products)[number]

/**
 * Produit lu dans l'URL (`?produit=bureaux`). Une valeur inconnue est ignorée :
 * un lien ancien ou bricolé affiche la liste complète plutôt qu'une erreur.
 */
export function parseProduct(value: string | string[] | undefined): Product | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return products.find((product) => product.key === raw)
}

/** Types de ressource d'un produit, sous la forme qu'attend un `inArray`. */
export function typesOf(product: Product): ResourceType[] {
  return [...product.types]
}

/** Produit auquel appartient un type de ressource. */
export function productOf(type: ResourceType): (typeof products)[number] {
  const product = products.find((candidate) => (candidate.types as readonly ResourceType[]).includes(type))
  // Inatteignable tant que le test de couverture des types passe.
  if (!product) throw new Error(`Type de ressource sans produit : ${type}`)
  return product
}
