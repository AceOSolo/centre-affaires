/**
 * Catégories du classement côté client (ADR 044), comme les rubriques d'un
 * espace bancaire. Module sans dépendance : les composants du navigateur le
 * chargent sans tirer le schéma de la base.
 */
export const mailCategories = [
  'impots',
  'social',
  'banque',
  'assurances',
  'fournisseurs',
  'clients',
  'juridique',
  'administration',
  'publicite',
  'autre',
] as const
export type MailCategory = (typeof mailCategories)[number]
