import { sql } from 'drizzle-orm'
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
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
  /** `numero` : celui peint sur la porte, unique parmi les casiers vivants du centre. */
  casier: { numero?: string; taille?: 'S' | 'M' | 'L' }
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
    /**
     * Photo de l'espace, servie par l'application — jamais une URL externe, pour
     * la même raison que le logo du centre (ADR 004).
     *
     * Colonne et non `attributes` : une photo n'est pas un champ propre à un
     * type, tous les types en ont une. `attributes` est réservé à ce qui ne vaut
     * que pour un type (décision 2).
     */
    photoPath: text('photo_path'),
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
    // Deux casiers vivants ne portent pas le même numéro, à la casse près (R01).
    // L'index tranche, y compris entre deux saisies simultanées ; un casier
    // archivé rend son numéro.
    uniqueIndex('resources_tenant_locker_numero_key')
      .on(table.tenantId, sql`lower(attributes ->> 'numero')`)
      .where(sql`resource_type = 'casier' and deleted_at is null`),
  ],
)

export type Resource = typeof resources.$inferSelect
export type NewResource = typeof resources.$inferInsert

/**
 * Horaires d'ouverture.
 *
 * Une ligne par plage et par jour de semaine : deux lignes pour une journée
 * coupée à midi. `resource_id` nul vaut pour tout le centre ; une ressource qui
 * a ses propres lignes remplace entièrement celles du centre plutôt que de s'y
 * ajouter — voir `rulesForResource()`. Une salle ouverte le samedi dans un
 * centre fermé le samedi doit être exprimable.
 *
 * `weekday` suit ISO 8601 : 1 = lundi … 7 = dimanche, comme `extract(isodow)`.
 *
 * Les heures sont en `time`, pas en `timestamptz` : « ouvre à 9h00 » est une
 * heure murale qui ne bouge pas aux changements d'heure, contrairement à
 * l'instant qu'elle désigne (décision 4, voir aussi ADR 010).
 */
export const openingHours = pgTable(
  'opening_hours',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    resourceId: uuid('resource_id'),
    weekday: smallint('weekday').notNull(),
    opensAt: time('opens_at').notNull(),
    closesAt: time('closes_at').notNull(),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'opening_hours_resource_fk',
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [resources.tenantId, resources.id],
    }).onDelete('cascade'),
    check('opening_hours_weekday_valid', sql`${table.weekday} between 1 and 7`),
    check('opening_hours_range_not_empty', sql`${table.closesAt} > ${table.opensAt}`),
    // Deux plages identiques le même jour sont une saisie en double, pas une
    // intention. Les plages qui se chevauchent, elles, sont fusionnées à la
    // lecture : c'est la seule interprétation raisonnable.
    uniqueIndex('opening_hours_slot_key').on(
      table.tenantId,
      sql`coalesce(resource_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
      table.weekday,
      table.opensAt,
    ),
    index('opening_hours_tenant_weekday_idx').on(table.tenantId, table.weekday),
  ],
)

/**
 * Fermetures exceptionnelles : jours fériés, congés, travaux.
 *
 * Journées entières, bornes comprises. Une indisponibilité partielle relève du
 * statut de la ressource (`maintenance`) ou d'une réservation de blocage — pas
 * d'un troisième mécanisme.
 */
export const closures = pgTable(
  'closures',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    /** Nul : tout le centre est fermé. */
    resourceId: uuid('resource_id'),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    reason: text('reason'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'closures_resource_fk',
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [resources.tenantId, resources.id],
    }).onDelete('cascade'),
    check('closures_period_ordered', sql`${table.endsOn} >= ${table.startsOn}`),
    index('closures_tenant_period_idx').on(table.tenantId, table.startsOn, table.endsOn),
  ],
)

export type OpeningHour = typeof openingHours.$inferSelect
export type NewOpeningHour = typeof openingHours.$inferInsert
export type Closure = typeof closures.$inferSelect
export type NewClosure = typeof closures.$inferInsert

/**
 * Annonces : la face publique d'une ressource.
 *
 * Table séparée et non colonnes sur `resources`, parce que les deux objets
 * changent à des rythmes différents et par des mains différentes — la capacité
 * et le statut relèvent de l'exploitation, le titre et le texte de la vitrine.
 * Toutes les ressources ne sont pas annoncées : un casier ne l'est jamais.
 *
 * Le `slug` est stocké et non calculé : il paraît dans l'URL publique et dans
 * les moteurs de recherche, il doit survivre à un renommage de la ressource.
 */
export const listings = pgTable(
  'listings',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    resourceId: uuid('resource_id').notNull(),
    slug: text('slug').notNull(),
    /** Titre de l'annonce, distinct du nom interne de la ressource. */
    headline: text('headline').notNull(),
    description: text('description'),
    /** Points forts, affichés en liste courte. */
    highlights: jsonb('highlights').$type<string[]>().notNull().default([]),
    /** Clés de stockage des photos, dans l'ordre d'affichage. */
    photos: jsonb('photos').$type<string[]>().notNull().default([]),
    /** Nul : brouillon, invisible du public. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (table) => [
    foreignKey({
      name: 'listings_resource_fk',
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [resources.tenantId, resources.id],
    }).onDelete('cascade'),
    // Une annonce par ressource : deux vitrines pour la même salle donneraient
    // deux disponibilités à tenir d'accord.
    unique('listings_tenant_resource_key').on(table.tenantId, table.resourceId),
    uniqueIndex('listings_tenant_slug_key')
      .on(table.tenantId, table.slug)
      .where(sql`deleted_at is null`),
    index('listings_tenant_published_idx').on(table.tenantId, table.publishedAt),
  ],
)

export type Listing = typeof listings.$inferSelect
export type NewListing = typeof listings.$inferInsert
