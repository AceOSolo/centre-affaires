import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

import { deletedAt, primaryKeyId, timestamps } from '../../db/columns.ts'
import { tenantId } from '../../db/tenants.ts'

/**
 * Une seule table pour tous les types de ressources (décision 2). Le calendrier,
 * les réservations et la facturation sont communs à tous les types ; les champs
 * qui ne le sont pas vivent dans `attributes`.
 */
export const resourceTypes = [
  'salle',
  'bureau',
  'casier',
  'vehicule',
  'boite_aux_lettres',
] as const
export type ResourceType = (typeof resourceTypes)[number]
export const resourceTypeEnum = pgEnum('resource_type', resourceTypes)

/**
 * `active` : réservable. `maintenance` : indisponible temporairement.
 * `retired` : sorti du parc, conservé pour l'historique des réservations.
 */
export const resourceStatuses = ['active', 'maintenance', 'retired'] as const
export type ResourceStatus = (typeof resourceStatuses)[number]
export const resourceStatusEnum = pgEnum('resource_status', resourceStatuses)

/** Champs propres à chaque type, stockés en JSONB. */
export type ResourceAttributes = {
  salle: { superficieM2?: number; equipements?: string[] }
  bureau: { superficieM2?: number; postes?: number }
  casier: { taille?: 'S' | 'M' | 'L' }
  vehicule: { immatriculation?: string; kilometrage?: number; places?: number }
  boite_aux_lettres: Record<string, never>
}

export const resources = pgTable(
  'resources',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    resourceType: resourceTypeEnum('resource_type').notNull(),
    /** Référence interne affichée au staff (« S-101 », « VH-2 »). */
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Nombre de personnes ; nul pour un casier ou une boîte aux lettres. */
    capacity: integer('capacity'),
    status: resourceStatusEnum('status').notNull().default('active'),
    attributes: jsonb('attributes')
      .$type<ResourceAttributes[ResourceType]>()
      .notNull()
      .default({}),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (table) => [
    // Cible de la clé étrangère composite de `bookings` : une réservation ne
    // peut pas pointer sur une ressource d'un autre centre.
    // Contrainte et non index : Postgres exige qu'elle existe avant la clé
    // étrangère qui la référence, et Drizzle émet les contraintes dans le
    // CREATE TABLE alors que les index viennent après.
    unique('resources_tenant_id_id_key').on(table.tenantId, table.id),
    // Le code est unique dans le centre, mais réutilisable après archivage.
    uniqueIndex('resources_tenant_code_key')
      .on(table.tenantId, table.code)
      .where(sql`deleted_at is null`),
    index('resources_tenant_type_idx').on(table.tenantId, table.resourceType),
  ],
)

export type Resource = typeof resources.$inferSelect
export type NewResource = typeof resources.$inferInsert
