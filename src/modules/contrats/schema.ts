import { sql } from 'drizzle-orm'
import {
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { deletedAt, primaryKeyId, timestamps } from '../../db/columns.ts'
import { tenantId } from '../../db/tenants.ts'
import { clients } from '../clients/schema.ts'
import { ratePlans } from '../facturation/schema.ts'
import { resources } from '../ressources/schema.ts'

export const contractTypes = ['domiciliation', 'bureau', 'coworking', 'autre'] as const
export type ContractType = (typeof contractTypes)[number]
export const contractTypeEnum = pgEnum('contract_type', contractTypes)

/**
 * `draft` : négocié, pas encore engageant.
 * `active` : en cours, facturable.
 * `terminated` : résilié ou arrivé à terme, conservé (décision 6).
 */
export const contractStatuses = ['draft', 'active', 'terminated'] as const
export type ContractStatus = (typeof contractStatuses)[number]
export const contractStatusEnum = pgEnum('contract_status', contractStatuses)

export const billingPeriods = ['monthly', 'quarterly', 'yearly'] as const
export type BillingPeriod = (typeof billingPeriods)[number]
export const billingPeriodEnum = pgEnum('billing_period', billingPeriods)

export const contracts = pgTable(
  'contracts',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    clientId: uuid('client_id').notNull(),
    /** Référence lisible portée sur les documents : « DOM-2026-014 ». */
    reference: text('reference').notNull(),
    contractType: contractTypeEnum('contract_type').notNull(),
    status: contractStatusEnum('status').notNull().default('draft'),

    /**
     * Dates de calendrier, en `date` et non `timestamptz`.
     *
     * La décision 4 vise les instants — un créneau de réservation existe à une
     * seconde près. Un contrat court « du 1er mars au 28 février » : c'est une
     * borne de calendrier, identique quel que soit le fuseau. La stocker en
     * instant obligerait à choisir un minuit, et ce minuit se déplacerait.
     */
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    /** Nul : durée indéterminée, jusqu'à résiliation. */
    endsOn: date('ends_on', { mode: 'string' }),

    billingPeriod: billingPeriodEnum('billing_period').notNull().default('monthly'),
    /** Montant par période, en centimes (décision 5). */
    amountCents: integer('amount_cents').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    /** Grille appliquée aux prestations hors forfait : salles, véhicules. */
    ratePlanId: uuid('rate_plan_id'),
    /** Bureau ou boîte aux lettres attribué, quand le contrat en réserve un. */
    resourceId: uuid('resource_id'),
    /** Préavis de résiliation, en jours. */
    noticeDays: integer('notice_days').notNull().default(90),

    terminatedOn: date('terminated_on', { mode: 'string' }),
    terminationReason: text('termination_reason'),
    notes: text('notes'),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (table) => [
    foreignKey({
      name: 'contracts_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contracts_rate_plan_fk',
      columns: [table.tenantId, table.ratePlanId],
      foreignColumns: [ratePlans.tenantId, ratePlans.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contracts_resource_fk',
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [resources.tenantId, resources.id],
    }).onDelete('restrict'),

    check('contracts_amount_positive', sql`${table.amountCents} >= 0`),
    check('contracts_notice_positive', sql`${table.noticeDays} >= 0`),
    check(
      'contracts_period_ordered',
      sql`${table.endsOn} is null or ${table.endsOn} >= ${table.startsOn}`,
    ),
    // Même invariant que sur les réservations annulées : l'état et sa date ne
    // peuvent pas se contredire.
    check(
      'contracts_terminated_on_consistent',
      sql`(${table.status} = 'terminated') = (${table.terminatedOn} is not null)`,
    ),

    uniqueIndex('contracts_tenant_reference_key')
      .on(table.tenantId, table.reference)
      .where(sql`deleted_at is null`),
    index('contracts_tenant_client_idx').on(table.tenantId, table.clientId),
    index('contracts_tenant_status_idx').on(table.tenantId, table.status),
  ],
)

export type Contract = typeof contracts.$inferSelect
export type NewContract = typeof contracts.$inferInsert
