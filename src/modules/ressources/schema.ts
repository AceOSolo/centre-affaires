import { sql } from 'drizzle-orm'
import {
  char,
  check,
  date,
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  smallint,
  text,
  time,
  tinyint,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { deletedAt, instant, primaryKeyId, timestamps } from '../../db/columns.ts'
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
export const resourceTypeEnum = (name: string) => mysqlEnum(name, resourceTypes)

/**
 * `active` : réservable. `maintenance` : indisponible temporairement.
 * `retired` : sorti du parc, conservé pour l'historique des réservations.
 */
export const resourceStatuses = ['active', 'maintenance', 'retired'] as const
export type ResourceStatus = (typeof resourceStatuses)[number]
export const resourceStatusEnum = (name: string) => mysqlEnum(name, resourceStatuses)

/**
 * Réservation par un client connecté à son espace (R23, ADR 016 décision D4,
 * ADR 036) : un réglage par ressource.
 *
 * - `instant` : confirmée d'emblée, sans l'accueil — à condition que le devis
 *   soit figé sur la réservation ; sans devis, elle attend l'accueil ;
 * - `approval` : demande, confirmée par l'accueil (valeur par défaut, la plus
 *   prudente : rien ne s'engage sans l'équipe, comme une demande publique) ;
 * - `closed` : pas de réservation depuis l'espace client (casier, boîte aux
 *   lettres : ils se louent par contrat).
 *
 * Appliqué par la base (trigger `bookings_apply_client_booking_mode`) à toute
 * réservation qui porte `booked_by_member_id` : le statut est posé selon la
 * ressource, `closed` est refusé (SQLSTATE `CA009`). La page publique anonyme
 * reste une demande validée par l'équipe (ADR 005) : elle ne pose pas de
 * membre, ce réglage ne la concerne pas.
 */
export const clientBookingModes = ['instant', 'approval', 'closed'] as const
export type ClientBookingMode = (typeof clientBookingModes)[number]
export const clientBookingModeEnum = (name: string) => mysqlEnum(name, clientBookingModes)

/** Champs propres à chaque type, stockés en JSON. */
export type ResourceAttributes = {
  salle: { superficieM2?: number; equipements?: string[] }
  bureau: { superficieM2?: number; postes?: number }
  /** `numero` : celui peint sur la porte, unique parmi les casiers vivants du centre. */
  casier: { numero?: string; taille?: 'S' | 'M' | 'L' }
  vehicule: { immatriculation?: string; kilometrage?: number; places?: number }
  boite_aux_lettres: Record<string, never>
}

export const resources = mysqlTable(
  'resources',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    resourceType: resourceTypeEnum('resource_type').notNull(),
    /** Référence interne affichée au staff (« S-101 », « VH-2 »). */
    code: varchar('code', { length: 64 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    /** Nombre de personnes ; nul pour un casier ou une boîte aux lettres. */
    capacity: int('capacity'),
    status: resourceStatusEnum('status').notNull().default('active'),
    /** Réservation depuis l'espace client (R23, ADR 036) : voir `clientBookingModes`. */
    clientBookingMode: clientBookingModeEnum('client_booking_mode').notNull().default('approval'),
    /**
     * Photo de l'espace, servie par l'application — jamais une URL externe, pour
     * la même raison que le logo du centre (ADR 004).
     *
     * Colonne et non `attributes` : une photo n'est pas un champ propre à un
     * type, tous les types en ont une. `attributes` est réservé à ce qui ne vaut
     * que pour un type (décision 2).
     */
    photoPath: varchar('photo_path', { length: 512 }),
    attributes: json('attributes')
      .$type<ResourceAttributes[ResourceType]>()
      .notNull()
      .default(sql`(JSON_OBJECT())`),
    ...timestamps(),
    deletedAt: deletedAt(),
    /**
     * Colonnes générées qui remplacent les index partiels de PostgreSQL : un
     * index unique MySQL ignore les `NULL`, donc une ligne qui sort de la
     * condition (archivée) rend son code et son numéro.
     */
    live: tinyint('live').generatedAlwaysAs(sql`if(deleted_at is null, 1, null)`, {
      mode: 'virtual',
    }),
    /**
     * Numéro de casier en minuscules tant que le casier est vivant, sinon
     * `NULL` (R01). `nullif(…, 'null')` : un `null` JSON explicite ne compte pas.
     */
    lockerNumeroKey: varchar('locker_numero_key', { length: 100 }).generatedAlwaysAs(
      sql`if(resource_type = 'casier' and deleted_at is null, lower(nullif(json_unquote(json_extract(attributes, '$.numero')), 'null')), null)`,
      { mode: 'virtual' },
    ),
  },
  (table) => [
    // Cible de la clé étrangère composite de `bookings` : une réservation ne
    // peut pas pointer sur une ressource d'un autre centre.
    // Contrainte et non index : elle doit exister avant la clé étrangère qui la
    // référence, et Drizzle émet les contraintes dans le CREATE TABLE alors que
    // les index viennent après.
    unique('resources_tenant_id_id_key').on(table.tenantId, table.id),
    // Le code est unique dans le centre, mais réutilisable après archivage.
    uniqueIndex('resources_tenant_code_key').on(table.tenantId, table.code, table.live),
    index('resources_tenant_type_idx').on(table.tenantId, table.resourceType),
    // Deux casiers vivants ne portent pas le même numéro, à la casse près (R01).
    // L'index tranche, y compris entre deux saisies simultanées ; un casier
    // archivé rend son numéro.
    uniqueIndex('resources_tenant_locker_numero_key').on(table.tenantId, table.lockerNumeroKey),
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
 * `weekday` suit ISO 8601 : 1 = lundi … 7 = dimanche, comme `WEEKDAY() + 1` de MySQL.
 *
 * Les heures sont en `time`, pas en `datetime` UTC : « ouvre à 9h00 » est une
 * heure murale qui ne bouge pas aux changements d'heure, contrairement à
 * l'instant qu'elle désigne (décision 4, voir aussi ADR 010).
 */
export const openingHours = mysqlTable(
  'opening_hours',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    resourceId: char('resource_id', { length: 36 }),
    weekday: smallint('weekday').notNull(),
    opensAt: time('opens_at').notNull(),
    closesAt: time('closes_at').notNull(),
    ...timestamps(),
    /** Plage du centre (`resource_id` nul) ramenée à une valeur comparable par l'index unique. */
    resourceKey: char('resource_key', { length: 36 }).generatedAlwaysAs(
      sql`coalesce(resource_id, '00000000-0000-0000-0000-000000000000')`,
      { mode: 'virtual' },
    ),
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
      table.resourceKey,
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
export const closures = mysqlTable(
  'closures',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    /** Nul : tout le centre est fermé. */
    resourceId: char('resource_id', { length: 36 }),
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
export const listings = mysqlTable(
  'listings',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    resourceId: char('resource_id', { length: 36 }).notNull(),
    slug: varchar('slug', { length: 191 }).notNull(),
    /** Titre de l'annonce, distinct du nom interne de la ressource. */
    headline: varchar('headline', { length: 255 }).notNull(),
    description: text('description'),
    /** Points forts, affichés en liste courte. */
    highlights: json('highlights').$type<string[]>().notNull().default(sql`(JSON_ARRAY())`),
    /** Clés de stockage des photos, dans l'ordre d'affichage. */
    photos: json('photos').$type<string[]>().notNull().default(sql`(JSON_ARRAY())`),
    /** Nul : brouillon, invisible du public. */
    publishedAt: instant('published_at'),
    ...timestamps(),
    deletedAt: deletedAt(),
    live: tinyint('live').generatedAlwaysAs(sql`if(deleted_at is null, 1, null)`, {
      mode: 'virtual',
    }),
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
    uniqueIndex('listings_tenant_slug_key').on(table.tenantId, table.slug, table.live),
    index('listings_tenant_published_idx').on(table.tenantId, table.publishedAt),
  ],
)

export type Listing = typeof listings.$inferSelect
export type NewListing = typeof listings.$inferInsert
