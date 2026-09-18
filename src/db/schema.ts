/**
 * Point d'entrée unique du schéma pour drizzle-kit et pour le client DB.
 * Chaque domaine définit ses tables dans son module, ce fichier les rassemble.
 */
export * from './tenants'
export * from '@/modules/ressources/schema'
export * from '@/modules/reservations/schema'
