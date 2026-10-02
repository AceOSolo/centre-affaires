import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { deletedAt, primaryKeyId, timestamps } from '../../db/columns.ts'
import { tenantId } from '../../db/tenants.ts'
import { resourceTypeEnum, resources } from '../ressources/schema.ts'

/**
 * Grilles tarifaires.
 *
 * Placées ici et non dans `contrats` parce que deux domaines s'en servent : un
 * contrat pour son loyer récurrent, une réservation pour le prix d'une salle à
 * l'heure. Les loger dans l'un des deux ferait dépendre l'autre de son voisin ;
 * la facturation est le domaine de l'argent, c'est sa place. Voir ADR 006.
 *
 * Aucune émission de facture ici : la V1 s'arrête aux tarifs (CLAUDE.md).
 */
export const ratePlans = pgTable(
  'rate_plans',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    /** ISO 4217. Accompagne les montants, stockés en centimes (décision 5). */
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    /** Grille appliquée quand un contrat n'en désigne aucune. */
    isDefault: boolean('is_default').notNull().default(false),
    /** Dates de calendrier, pas des instants : une grille change à une date. */
    validFrom: date('valid_from', { mode: 'string' }),
    validTo: date('valid_to', { mode: 'string' }),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (table) => [
    unique('rate_plans_tenant_id_id_key').on(table.tenantId, table.id),
    // Une seule grille par défaut à la fois : deux rendraient le tarif appliqué
    // dépendant de l'ordre de lecture.
    uniqueIndex('rate_plans_tenant_default_key')
      .on(table.tenantId)
      .where(sql`is_default and deleted_at is null`),
    check(
      'rate_plans_validity_ordered',
      sql`${table.validTo} is null or ${table.validFrom} is null or ${table.validTo} >= ${table.validFrom}`,
    ),
  ],
)

/**
 * Unité facturée. `unit` couvre le forfait : un casier au mois, une prestation.
 *
 * `half_day` n'est pas une demi-`day` : le centre vend la demi-journée 90 € et
 * la journée 130 €, pas 180 €. Une unité qui ne se déduit pas d'une autre par
 * un calcul doit exister par elle-même (ADR 009).
 */
export const rateUnits = ['hour', 'half_day', 'day', 'month', 'unit'] as const
export type RateUnit = (typeof rateUnits)[number]
export const rateUnitEnum = pgEnum('rate_unit', rateUnits)

/**
 * Ligne de grille : un prix pour un type de ressource, ou pour une ressource
 * précise quand elle mérite son propre tarif. La ligne nominative l'emporte sur
 * la ligne de type — voir `resolveRate()`.
 */
export const ratePlanItems = pgTable(
  'rate_plan_items',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    ratePlanId: uuid('rate_plan_id').notNull(),
    resourceType: resourceTypeEnum('resource_type').notNull(),
    /** Nul : le tarif vaut pour tout le type. */
    resourceId: uuid('resource_id'),
    unit: rateUnitEnum('unit').notNull(),
    /** Centimes, entier. Jamais de flottant pour de l'argent (décision 5). */
    amountCents: integer('amount_cents').notNull(),
    ...timestamps(),
    /**
     * Retrait d'un prix de la grille (décision 6) : il cesse de s'appliquer,
     * la ligne reste pour expliquer un montant déjà calculé avec lui.
     */
    deletedAt: deletedAt(),
  },
  (table) => [
    foreignKey({
      name: 'rate_plan_items_plan_fk',
      columns: [table.tenantId, table.ratePlanId],
      foreignColumns: [ratePlans.tenantId, ratePlans.id],
    }).onDelete('cascade'),
    // `resource_id` nul laisse passer la contrainte (MATCH SIMPLE) : c'est le
    // cas du tarif par type.
    foreignKey({
      name: 'rate_plan_items_resource_fk',
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [resources.tenantId, resources.id],
    }).onDelete('restrict'),
    check('rate_plan_items_amount_positive', sql`${table.amountCents} >= 0`),
    // Un seul prix actif par (grille, type, unité) et par (grille, ressource,
    // unité) : sinon le tarif appliqué dépendrait de l'ordre de lecture. Un prix
    // retiré libère sa place pour celui qui le remplace.
    uniqueIndex('rate_plan_items_type_key')
      .on(table.ratePlanId, table.resourceType, table.unit)
      .where(sql`resource_id is null and deleted_at is null`),
    uniqueIndex('rate_plan_items_resource_key')
      .on(table.ratePlanId, table.resourceId, table.unit)
      .where(sql`resource_id is not null and deleted_at is null`),
  ],
)

export type RatePlan = typeof ratePlans.$inferSelect
export type NewRatePlan = typeof ratePlans.$inferInsert
export type RatePlanItem = typeof ratePlanItems.$inferSelect
export type NewRatePlanItem = typeof ratePlanItems.$inferInsert
