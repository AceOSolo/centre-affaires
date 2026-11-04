import { sql } from 'drizzle-orm'
import {
  char,
  check,
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  tinyint,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { instant, primaryKeyId, timestamps } from '../../db/columns.ts'
import { tenantId } from '../../db/tenants.ts'
import { clients } from '../clients/schema.ts'
import { rateUnitEnum } from '../facturation/schema.ts'

/**
 * Registre des consommations facturables (ADR 066) : ce que le centre a fait
 * pour un client et que le CRM facturera — **le site ne facture rien**
 * (`CLAUDE.md`, Facturation). Une consommation est une donnée transmise : le
 * CRM vient la chercher, puis en accuse réception, comme un devis (ADR 043).
 *
 * Natures (une par source, `consommations.ts`) :
 *
 * - `booking` : une réservation hors devis, de toute ressource — salle,
 *   bureau, camion, matériel… (`bookings.id`) ;
 * - `mail_opening` : l'ouverture et la numérisation d'un pli (`mail_items.id`) ;
 * - `mail_pages` : les pages numérisées au-delà de celles comprises dans
 *   l'ouverture (`mail_scans.id`) ;
 * - `mail_scan` : la numérisation demandée d'un pli déjà ouvert (`mail_requests.id`) ;
 * - `mail_forward` : la réexpédition d'un pli, et ses frais d'affranchissement
 *   (`mail_requests.id`).
 *
 * Chaque ligne est un **instantané** pris quand la consommation ne peut plus
 * changer (réservation terminée, mois du courrier clos) : il ne se réécrit
 * pas (`58-consommations.sql`, `CA018`). Une source qui change ensuite annule
 * la consommation et en fait une autre ; une source annulée l'annule.
 *
 * Au plus une consommation vivante par source (`crm_consumptions_source_key`) :
 * aucun doublon, quel que soit le nombre de passages du CRM.
 *
 * Pas de suppression (décision 6) : une consommation annulée reste, avec son
 * motif, et le CRM la lit dans la liste des annulées.
 */
export const consumptionNatures = ['booking', 'mail_opening', 'mail_pages', 'mail_scan', 'mail_forward'] as const
export type ConsumptionNature = (typeof consumptionNatures)[number]

/**
 * `ready` : prête, le CRM vient la chercher ; `sent` : reprise par le CRM, qui
 * l'a enregistrée sous `crm_id` ; `cancelled` : à ne pas (ou plus) facturer.
 */
export const consumptionStatuses = ['ready', 'sent', 'cancelled'] as const
export type ConsumptionStatus = (typeof consumptionStatuses)[number]

export const crmConsumptions = mysqlTable(
  'crm_consumptions',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    nature: mysqlEnum('nature', consumptionNatures).notNull(),
    /** La ligne d'où vient la consommation, dans la table de sa nature. */
    sourceId: char('source_id', { length: 36 }).notNull(),
    clientId: char('client_id', { length: 36 }).notNull(),
    /** Instant de la prestation : début de la réservation, ouverture du pli, demande faite. */
    occurredAt: instant('occurred_at').notNull(),
    quantity: int('quantity').notNull(),
    /** Unité de la quantité ; nulle pour une réservation sans devis figé, que le CRM chiffrera. */
    unit: rateUnitEnum('unit'),
    /** Référence du produit dans le CRM (ADR 049) : `courrier.ouverture`, `tarif.salle.journee`. */
    productRef: varchar('product_ref', { length: 100 }),
    /** Désignation, en clair, dans le fuseau du centre. */
    description: varchar('description', { length: 500 }).notNull(),
    /*
     * Prix annoncé au client, quand le site en a un : le devis figé de la
     * réservation (ADR 023). Nul pour les actes du courrier : leur prix, et ce
     * que le contrat en comprend, sont tenus par le CRM.
     */
    unitPriceCents: int('unit_price_cents'),
    discountBp: int('discount_bp'),
    discountAmountCents: int('discount_amount_cents'),
    vatRateBp: int('vat_rate_bp'),
    amountCents: int('amount_cents'),
    /** Frais refacturés au centime : l'affranchissement d'une réexpédition (ADR 037). */
    feesCents: int('fees_cents'),
    currency: char('currency', { length: 3 }),
    /** Le détail de la source au moment de l'instantané : ressource et période, pli et demande. */
    details: json('details').$type<Record<string, unknown>>().notNull(),
    /** Empreinte de ce qui, dans la source, fait la consommation : un écart l'annule. */
    fingerprint: char('fingerprint', { length: 64 }).notNull(),
    status: mysqlEnum('status', consumptionStatuses).notNull().default('ready'),
    /** Reprise par le CRM : son identifiant et sa référence (ligne de facture, facture…). */
    crmId: varchar('crm_id', { length: 64 }),
    crmRef: varchar('crm_ref', { length: 64 }),
    /** Posées par la base (`58-consommations.sql`). */
    sentAt: instant('sent_at'),
    cancelledAt: instant('cancelled_at'),
    cancellationReason: varchar('cancellation_reason', { length: 255 }),
    ...timestamps(),
    /** `1` tant que la consommation n'est pas annulée, `NULL` ensuite : unicité par source. */
    live: tinyint('live').generatedAlwaysAs(sql`if(status <> 'cancelled', 1, null)`, { mode: 'virtual' }),
  },
  (table) => [
    foreignKey({
      name: 'crm_consumptions_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    uniqueIndex('crm_consumptions_source_key').on(table.tenantId, table.nature, table.sourceId, table.live),
    // Liste du CRM : par statut, de la plus ancienne modification à la plus récente.
    index('crm_consumptions_status_idx').on(table.tenantId, table.status, table.updatedAt),
    index('crm_consumptions_client_idx').on(table.tenantId, table.clientId, table.occurredAt),
    check('crm_consumptions_quantity_positive', sql`${table.quantity} > 0`),
    check(
      'crm_consumptions_amounts_valid',
      sql`(${table.unitPriceCents} is null or ${table.unitPriceCents} >= 0) and (${table.amountCents} is null or ${table.amountCents} >= 0) and (${table.feesCents} is null or ${table.feesCents} >= 0) and (${table.vatRateBp} is null or ${table.vatRateBp} between 0 and 10000)`,
    ),
    // Chaque état a ses traces, et seulement elles. Une consommation annulée
    // après sa reprise garde la référence du CRM.
    check(
      'crm_consumptions_status_consistent',
      sql`(${table.status} = 'ready' and ${table.crmId} is null and ${table.sentAt} is null and ${table.cancelledAt} is null)
        or (${table.status} = 'sent' and ${table.crmId} is not null and ${table.sentAt} is not null and ${table.cancelledAt} is null)
        or (${table.status} = 'cancelled' and ${table.cancelledAt} is not null and (${table.crmId} is null) = (${table.sentAt} is null))`,
    ),
    check('crm_consumptions_fingerprint_format', sql`REGEXP_LIKE(${table.fingerprint}, '^[0-9a-f]{64}$', 'c')`),
  ],
)

export type CrmConsumption = typeof crmConsumptions.$inferSelect
export type NewCrmConsumption = typeof crmConsumptions.$inferInsert
