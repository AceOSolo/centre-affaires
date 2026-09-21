import { sql } from 'drizzle-orm'
import { char, check, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'

import { deletedAt, primaryKeyId, timestamps } from './columns.ts'

/**
 * Centre unique tant que le produit est mono-centre. Cet identifiant est aussi
 * écrit en dur dans la migration 0002 (création de la ligne) et dans la
 * fonction `tenant_id_default()` : les trois doivent rester synchronisés.
 */
export const DEFAULT_TENANT_ID = '01999f00-0000-7000-8000-000000000001'

export const tenants = pgTable('tenants', {
  id: primaryKeyId(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  /** Fuseau d'affichage du centre (IANA), la base reste en UTC. */
  timezone: text('timezone').notNull().default('Europe/Paris'),
  /** ISO 4217, accompagne les montants stockés en centimes. */
  currency: char('currency', { length: 3 }).notNull().default('EUR'),
  bookingLeadHours: integer('booking_lead_hours').notNull().default(0),
  bookingHorizonDays: integer('booking_horizon_days').notNull().default(90),

  /*
   * Identité publique du centre.
   *
   * En base et non en dur dans la page : c'est ce qui change d'un centre à
   * l'autre, et la décision 1 veut que le passage au multi-centres ne demande
   * pas de reprise. Un second centre aura son nom, son adresse et son logo sans
   * qu'on touche au code.
   */
  /** Signature affichée sous le nom — « Cultivateur de relations ». */
  tagline: text('tagline'),
  /** Personne morale qui exploite le centre, pour les mentions légales. */
  legalName: text('legal_name'),
  addressLine1: text('address_line1'),
  /** Complément : bâtiment, pavillon, étage. */
  addressLine2: text('address_line2'),
  postalCode: text('postal_code'),
  city: text('city'),
  /** ISO 3166-1 alpha-2, comme sur `clients`. */
  country: char('country', { length: 2 }).notNull().default('FR'),
  phone: text('phone'),
  email: text('email'),
  websiteUrl: text('website_url'),
  /**
   * Chemin du logo servi par l'application, jamais une URL externe : une image
   * appelée chez un tiers lui livrerait l'adresse IP de chaque visiteur, ce que
   * l'ADR 004 refuse déjà pour les polices.
   */
  logoPath: text('logo_path'),
  /**
   * Variante du logo pour fond sombre. La charte interdit de recolorer le logo :
   * il faut donc le fichier prévu pour ça, pas un filtre CSS.
   */
  logoLightPath: text('logo_light_path'),
  /** Photo d'en-tête du site public, servie depuis notre domaine elle aussi. */
  heroImagePath: text('hero_image_path'),
  /**
   * Réseaux du centre : `[{ label, url }]`.
   *
   * En JSONB plutôt qu'une colonne par réseau — ils vont et viennent, et leur
   * liste n'est jamais interrogée, seulement affichée.
   */
  socialLinks: jsonb('social_links')
    .$type<{ label: string; url: string }[]>()
    .notNull()
    .default([]),

  ...timestamps(),
  deletedAt: deletedAt(),
}, (table) => [
  check('tenants_booking_delays_valid', sql`${table.bookingLeadHours} >= 0 and ${table.bookingHorizonDays} between 1 and 365 and ${table.bookingLeadHours} < ${table.bookingHorizonDays} * 24`),
])

/**
 * Colonne `tenant_id` de toutes les tables métier.
 *
 * Valeur par défaut : le tenant du contexte de session, ou le centre unique.
 * L'isolation réelle est assurée par les politiques RLS (migration 0003), qui
 * exigent un `app.tenant_id` explicite et ne renvoient rien sans lui.
 */
export const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(sql`tenant_id_default()`)
    .references(() => tenants.id, { onDelete: 'restrict' })

export type Tenant = typeof tenants.$inferSelect
export type NewTenant = typeof tenants.$inferInsert
