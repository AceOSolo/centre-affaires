import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
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
 * Ce fichier porte le catalogue : grilles, services, offres groupées. Il ne
 * dépend ni des contrats ni des réservations, qui l'importent. Les factures,
 * qui dépendent de tout, sont dans `schema-factures.ts` (ADR 026).
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
    // Une seule grille par défaut **un jour donné** : deux rendraient le tarif
    // appliqué dépendant de l'ordre de lecture. Des grilles par défaut dont
    // les dates de validité se suivent sont permises — celle de l'an prochain
    // se prépare d'avance (ADR 035). La contrainte d'exclusion
    // `rate_plans_default_no_overlap` (migration 0038) le tient : Drizzle ne
    // sait pas la décrire.
    check(
      'rate_plans_validity_ordered',
      sql`${table.validTo} is null or ${table.validFrom} is null or ${table.validTo} >= ${table.validFrom}`,
    ),
  ],
)

/**
 * Période de facturation d'un contrat, ou proposée par une offre : les
 * périodes sont des mois, trimestres ou années civils (ADR 006).
 */
export const billingPeriods = ['monthly', 'quarterly', 'yearly'] as const
export type BillingPeriod = (typeof billingPeriods)[number]
export const billingPeriodEnum = pgEnum('billing_period', billingPeriods)

/**
 * Unité facturée. `unit` couvre le forfait : un casier au mois, une prestation.
 *
 * `half_day` n'est pas une demi-`day` : le centre vend la demi-journée 90 € et
 * la journée 130 €, pas 180 €. Une unité qui ne se déduit pas d'une autre par
 * un calcul doit exister par elle-même (ADR 009). Même raison pour `week`
 * (R08, ADR 023) : la semaine se vend moins de sept journées.
 *
 * L'ordre est celui de l'énumération en base, de la plus fine à la plus large.
 */
export const rateUnits = ['hour', 'half_day', 'day', 'week', 'month', 'unit'] as const
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
    // Cible de la clé étrangère composite du devis d'une réservation (R11).
    unique('rate_plan_items_tenant_id_id_key').on(table.tenantId, table.id),
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

/*
 * Remises (R10, ADR 023). Partout où une remise se pose — ligne d'offre, ligne
 * de contrat, souscription, ligne de facture, devis d'une réservation — elle
 * prend l'une de deux formes, jamais les deux :
 *
 * - `discount_bp` : un pourcentage en points de base, 1000 = 10 % ;
 * - `discount_amount_cents` : un montant par période, en centimes.
 *
 * Le montant net d'une ligne est calculé par la base, par une seule règle
 * d'arrondi : `line_net_amount_cents()` (migration 0029, ADR 023), dont
 * `lineNetAmountCents()` (`montants.ts`) est le jumeau éprouvé contre elle.
 */

/**
 * Expression SQL du montant net d'une ligne, pour une colonne générée.
 * Les arguments sont des noms de colonnes (ou `NULL`), jamais une saisie.
 */
export function lineNetAmountSql(columns: {
  quantity: string
  unitPrice: string
  discountBp?: string
  discountCents?: string
  prorataNumerator?: string
  prorataDenominator?: string
}) {
  const args = [
    columns.quantity,
    columns.unitPrice,
    columns.discountBp ?? 'NULL',
    columns.discountCents ?? 'NULL',
    columns.prorataNumerator ?? 'NULL',
    columns.prorataDenominator ?? 'NULL',
  ]
  return sql.raw(`line_net_amount_cents(${args.join(', ')})`)
}

/**
 * Nature d'un service du catalogue (R18) :
 *
 * - `package` : forfait, dû par période (standard téléphonique, assistante) ;
 * - `act` : acte, dû à chaque exécution (ouverture d'un pli, réexpédition).
 */
export const serviceNatures = ['package', 'act'] as const
export type ServiceNature = (typeof serviceNatures)[number]
export const serviceNatureEnum = pgEnum('service_nature', serviceNatures)

/**
 * Codes stables des services que le code retrouve sans passer par l'écran
 * (ADR 024). Les actes du courrier sont valorisés par ces services : la
 * facturation cherche `services.code`, jamais un nom.
 *
 * Le centre crée ces services et en fixe le prix : aucun prix n'est inventé
 * ici (ADR 009). Sans service vivant pour un code, l'acte n'est pas valorisé
 * et le lot de facturation le signale.
 */
export const serviceCodes = {
  /** Ouverture et numérisation d'un pli (ADR 015 : les deux ne font qu'un acte). */
  mailOpening: 'courrier.ouverture',
  /** Réexpédition d'un pli (R21, ADR 037) : l'acte, hors frais d'affranchissement. */
  mailForwarding: 'courrier.reexpedition',
  /** Numérisation seule d'un pli déjà ouvert, sur demande (R21, ADR 037). */
  mailScan: 'courrier.numerisation',
} as const

/**
 * Catalogue de services (R18, R14, ADR 024) : ce que le centre vend et qui
 * n'est pas une ressource réservable — forfaits et actes.
 *
 * Distinct des grilles tarifaires : une ligne de grille est liée à un type de
 * ressource (ADR 009), un service non (D7).
 */
export const services = pgTable(
  'services',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    /**
     * Code stable, pour les services que le code doit retrouver (`serviceCodes`).
     * Nul pour un service saisi à l'écran que rien ne cherche par son code.
     */
    code: text('code'),
    name: text('name').notNull(),
    description: text('description'),
    nature: serviceNatureEnum('nature').notNull(),
    /** Unité de facturation : `month` pour un forfait mensuel, `unit` pour un acte. */
    unit: rateUnitEnum('unit').notNull(),
    /** Prix unitaire HT en centimes (décision 5). */
    unitPriceCents: integer('unit_price_cents').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    /** Taux de TVA en points de base : 2000 = 20 %. */
    vatRateBp: integer('vat_rate_bp').notNull().default(2000),
    /** Proposé à la souscription. Un service inactif reste facturé à ceux qui l'ont. */
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (table) => [
    unique('services_tenant_id_id_key').on(table.tenantId, table.id),
    // Un code ne désigne qu'un service vivant : sinon la facturation
    // choisirait selon l'ordre de lecture. Un service archivé rend son code.
    uniqueIndex('services_tenant_code_key')
      .on(table.tenantId, table.code)
      .where(sql`code is not null and deleted_at is null`),
    check(
      'services_code_format',
      sql`${table.code} is null or ${table.code} ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'`,
    ),
    check('services_name_not_blank', sql`btrim(${table.name}) <> ''`),
    check('services_unit_price_positive', sql`${table.unitPriceCents} >= 0`),
    check('services_vat_rate_valid', sql`${table.vatRateBp} between 0 and 10000`),
    // Un acte se compte à l'unité : c'est ce que le relevé des plis produit.
    check('services_act_per_unit', sql`${table.nature} <> 'act' or ${table.unit} = 'unit'`),
    index('services_tenant_nature_idx').on(table.tenantId, table.nature),
  ],
)

export type Service = typeof services.$inferSelect
export type NewService = typeof services.$inferInsert

/**
 * Offres groupées (R09, ADR 024) : un modèle commercial — « Domiciliation
 * Premium : boîte aux lettres, réexpédition, dix numérisations par mois ».
 *
 * Une offre ne facture rien : un contrat en est tiré, qui copie ses lignes
 * (`contract_lines`) et garde le lien (`contracts.offer_id`). Modifier ou
 * archiver l'offre ne change aucun contrat signé.
 *
 * Active tant que `deleted_at` est nul, archivée ensuite (décision 6).
 */
export const offers = pgTable(
  'offers',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    description: text('description'),
    /** Période de facturation proposée pour le contrat qui en sera tiré. */
    billingPeriod: billingPeriodEnum('billing_period').notNull().default('monthly'),
    /** Durée d'engagement proposée, en mois. Nulle : sans engagement. */
    commitmentMonths: integer('commitment_months'),
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    /**
     * Présentée dans l'espace client (R23, ADR 036) : le client la voit, avec
     * son prix (`priceOffer`), et la demande à l'accueil, qui en tire le
     * contrat (ADR 028). Faux par défaut : une offre se prépare avant d'être
     * montrée.
     */
    clientVisible: boolean('client_visible').notNull().default(false),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (table) => [
    unique('offers_tenant_id_id_key').on(table.tenantId, table.id),
    check('offers_name_not_blank', sql`btrim(${table.name}) <> ''`),
    check(
      'offers_commitment_valid',
      sql`${table.commitmentMonths} is null or ${table.commitmentMonths} between 1 and 120`,
    ),
  ],
)

export type Offer = typeof offers.$inferSelect
export type NewOffer = typeof offers.$inferInsert

/**
 * Ligne d'une offre : un type de ressource, une ressource précise ou un
 * service — exactement l'un des trois — avec une quantité, et au plus l'un
 * de : un prix forfaitaire, une remise en pourcentage, une remise en montant.
 * Aucun des trois : le prix du catalogue (grille ou service) s'applique.
 *
 * Pour un service de nature `act`, la quantité est la quantité incluse par
 * période (dix numérisations par mois) : le contrat tiré de l'offre la porte
 * sur une souscription (`subscribed_services.included_quantity`, ADR 024).
 */
export const offerItems = pgTable(
  'offer_items',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    offerId: uuid('offer_id').notNull(),
    resourceType: resourceTypeEnum('resource_type'),
    resourceId: uuid('resource_id'),
    serviceId: uuid('service_id'),
    quantity: integer('quantity').notNull().default(1),
    /** Unité dans laquelle la quantité et le prix s'expriment. */
    unit: rateUnitEnum('unit').notNull().default('month'),
    /** Prix forfaitaire HT par unité, en centimes. */
    priceCents: integer('price_cents'),
    discountBp: integer('discount_bp'),
    discountAmountCents: integer('discount_amount_cents'),
    /** Taux de TVA imposé ; nul : celui du service, ou celui du centre. */
    vatRateBp: integer('vat_rate_bp'),
    /** Ordre d'affichage dans l'offre. */
    position: smallint('position').notNull().default(0),
    /**
     * Désignation commerciale de la ligne (ADR 036, manque reporté par
     * l'ADR 035) : « Bureau fermé de 12 m² », « Dix numérisations par mois ».
     * Nulle : le nom du service, de la ressource ou du type.
     */
    label: text('label'),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (table) => [
    unique('offer_items_tenant_id_id_key').on(table.tenantId, table.id),
    check(
      'offer_items_label_not_blank',
      sql`${table.label} is null or btrim(${table.label}) <> ''`,
    ),
    foreignKey({
      name: 'offer_items_offer_fk',
      columns: [table.tenantId, table.offerId],
      foreignColumns: [offers.tenantId, offers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'offer_items_resource_fk',
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [resources.tenantId, resources.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'offer_items_service_fk',
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }).onDelete('restrict'),
    check(
      'offer_items_one_target',
      sql`num_nonnulls(${table.resourceType}, ${table.resourceId}, ${table.serviceId}) = 1`,
    ),
    check(
      'offer_items_one_pricing',
      sql`num_nonnulls(${table.priceCents}, ${table.discountBp}, ${table.discountAmountCents}) <= 1`,
    ),
    check('offer_items_quantity_positive', sql`${table.quantity} > 0`),
    check(
      'offer_items_amounts_valid',
      sql`(${table.priceCents} is null or ${table.priceCents} >= 0) and (${table.discountBp} is null or ${table.discountBp} between 0 and 10000) and (${table.discountAmountCents} is null or ${table.discountAmountCents} >= 0) and (${table.vatRateBp} is null or ${table.vatRateBp} between 0 and 10000)`,
    ),
    index('offer_items_offer_idx').on(table.tenantId, table.offerId),
  ],
)

export type OfferItem = typeof offerItems.$inferSelect
export type NewOfferItem = typeof offerItems.$inferInsert
