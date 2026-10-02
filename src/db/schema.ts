/**
 * Point d'entrée unique du schéma pour drizzle-kit et pour le client DB.
 * Chaque domaine définit ses tables dans son module, ce fichier les rassemble.
 */
export * from './tenants.ts'
export * from './staff.ts'
export * from './numerotation.ts'
export * from '../modules/ressources/schema.ts'
export * from '../modules/reservations/schema.ts'
export * from '../modules/clients/schema.ts'
export * from '../modules/facturation/schema.ts'
export * from '../modules/facturation/schema-factures.ts'
export * from '../modules/contrats/schema.ts'
export * from '../modules/courrier/schema.ts'
export * from '../modules/notifications/schema.ts'
export * from '../modules/etats-des-lieux/schema.ts'
