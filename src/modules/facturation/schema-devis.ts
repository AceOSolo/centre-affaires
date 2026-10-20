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
  text,
  tinyint,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { deletedAt, instant, primaryKeyId, timestamps } from '../../db/columns.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenantId } from '../../db/tenants.ts'
import { clients } from '../clients/schema.ts'
import { bookingChannelEnum, bookings } from '../reservations/schema.ts'
import { resources } from '../ressources/schema.ts'
import { lineNetAmountSql, rateUnitEnum, ratePlanItems, services } from './schema.ts'

/**
 * Ce que le demandeur veut louer (ADR 043) : chaque produit a ses questions
 * (`reservations/questionnaires.ts`) et son chemin.
 *
 * - `espace` : salle de réunion ou bureau, sur un créneau du calendrier ;
 * - `vehicule` : camion ou utilitaire, sur un créneau, au temps comme une salle ;
 * - `domiciliation` : adresse et courrier, sans calendrier, par contrat.
 */
export const proposalProducts = ['espace', 'vehicule', 'domiciliation'] as const
export type ProposalProduct = (typeof proposalProducts)[number]
export const proposalProductEnum = (name: string) => mysqlEnum(name, proposalProducts)

/**
 * Cycle d'un devis (ADR 043) :
 *
 * - `draft` : à compléter par l'accueil (prix à établir, réponses à vérifier) ;
 * - `ready` : validé, en attente de reprise par Dolibarr ;
 * - `sent` : repris par Dolibarr, qui l'a enregistré sous `dolibarr_ref` ;
 * - `accepted` / `refused` : issue rapportée par Dolibarr ;
 * - `cancelled` : abandonné (demande refusée, réservation annulée, doublon).
 *
 * La base tient les passages permis (`52-devis.sql`, `CA016`).
 */
export const proposalStatuses = ['draft', 'ready', 'sent', 'accepted', 'refused', 'cancelled'] as const
export type ProposalStatus = (typeof proposalStatuses)[number]
export const proposalStatusEnum = (name: string) => mysqlEnum(name, proposalStatuses)

/**
 * Devis commercial (ADR 043) : la proposition transmise à Dolibarr, qui en
 * fait sa « proposition commerciale » puis sa facture.
 *
 * Données structurées, jamais un PDF (CLAUDE.md, Facturation) : Dolibarr
 * rend le document. Le numéro `DV-2026-0001` est celui du centre ; Dolibarr
 * pose le sien (`dolibarr_ref`), les deux se répondent.
 *
 * Pas de `deleted_at` : un devis abandonné passe à `cancelled` et reste
 * consultable, comme une réservation (décision 6).
 */
export const proposals = mysqlTable(
  'proposals',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    /** `DV-AAAA-NNNN`, par `next_document_number('proposal')`, à la création. */
    number: varchar('number', { length: 32 }).notNull(),
    product: proposalProductEnum('product').notNull(),
    status: proposalStatusEnum('status').notNull().default('draft'),
    /** Par où la demande est arrivée : mêmes valeurs que la réservation. */
    channel: bookingChannelEnum('channel').notNull(),
    /** Entreprise déjà cliente ; nulle pour un prospect de la page publique. */
    clientId: char('client_id', { length: 36 }),
    /**
     * Le demandeur, tel qu'il s'est présenté. Un prospect n'a pas de fiche
     * client (ADR 005) : Dolibarr crée son tiers à partir de ces champs.
     */
    requesterName: text('requester_name'),
    requesterEmail: varchar('requester_email', { length: 320 }),
    requesterPhone: varchar('requester_phone', { length: 40 }),
    requesterCompany: text('requester_company'),
    /** Créneau tenu pour un espace ou un véhicule ; nul pour une domiciliation. */
    bookingId: char('booking_id', { length: 36 }),
    /**
     * Réponses au questionnaire du produit, validées par le code
     * (`parseAnswers`) : `{ participants: 8, usage: 'reunion' }`.
     */
    answers: json('answers').$type<Record<string, string | number | boolean | string[]>>().notNull(),
    /** Message libre du demandeur. */
    message: text('message'),
    /** Note de l'accueil, transmise à Dolibarr avec le devis. */
    staffNote: text('staff_note'),
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    /** Validation par l'accueil (ou par la règle du produit : `validated_by_staff_id` nul). */
    validatedAt: instant('validated_at'),
    validatedByStaffId: char('validated_by_staff_id', { length: 36 }).references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
    /** Reprise par Dolibarr : son identifiant et sa référence (`PR2610-0001`). */
    dolibarrId: varchar('dolibarr_id', { length: 64 }),
    dolibarrRef: varchar('dolibarr_ref', { length: 64 }),
    sentAt: instant('sent_at'),
    /** Issue rapportée par Dolibarr (signé ou refusé). */
    outcomeAt: instant('outcome_at'),
    cancelledAt: instant('cancelled_at'),
    cancellationReason: text('cancellation_reason'),
    ...timestamps(),
    /**
     * Colonne générée : `1` tant que le devis n'est pas annulé, `NULL`
     * ensuite. MySQL n'a pas d'index unique partiel : l'unicité « un devis
     * vivant par réservation » se fait en l'incluant dans l'index (un index
     * unique ignore les `NULL`, `docs/migration-mysql/conventions.md` §3.1).
     * Jamais écrite.
     */
    live: tinyint('live').generatedAlwaysAs(sql`if(status <> 'cancelled', 1, null)`, { mode: 'virtual' }),
  },
  (table) => [
    unique('proposals_tenant_id_id_key').on(table.tenantId, table.id),
    uniqueIndex('proposals_tenant_number_key').on(table.tenantId, table.number),
    // Un créneau, un devis vivant : la réservation et son devis se suivent.
    // Un devis annulé ne compte plus — la réservation déplacée après la
    // transmission se refait ainsi d'un nouveau devis (ADR 043).
    uniqueIndex('proposals_tenant_booking_live_key').on(table.tenantId, table.bookingId, table.live),
    foreignKey({
      name: 'proposals_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'proposals_booking_fk',
      columns: [table.tenantId, table.bookingId],
      foreignColumns: [bookings.tenantId, bookings.id],
    }).onDelete('restrict'),
    // Un espace ou un véhicule se loue sur un créneau ; une domiciliation non.
    check(
      'proposals_booking_matches_product',
      sql`(${table.product} = 'domiciliation') = (${table.bookingId} is null)`,
    ),
    // Quelqu'un à qui répondre : une entreprise connue ou une adresse.
    check(
      'proposals_has_recipient',
      sql`${table.clientId} is not null or (${table.requesterEmail} is not null and trim(${table.requesterEmail}) <> '')`,
    ),
    check('proposals_sent_has_reference', sql`${table.sentAt} is null or ${table.dolibarrId} is not null`),
    check(
      'proposals_status_dates',
      sql`(${table.status} in ('draft') or ${table.validatedAt} is not null or ${table.status} = 'cancelled')
        and (${table.status} not in ('sent', 'accepted', 'refused') or ${table.sentAt} is not null)
        and ((${table.status} in ('accepted', 'refused')) = (${table.outcomeAt} is not null))
        and ((${table.status} = 'cancelled') = (${table.cancelledAt} is not null))`,
    ),
    index('proposals_tenant_status_idx').on(table.tenantId, table.status, table.updatedAt),
  ],
)

export type Proposal = typeof proposals.$inferSelect
export type NewProposal = typeof proposals.$inferInsert

/**
 * D'où vient une ligne de devis : le prix figé d'une réservation (ADR 023),
 * un service du catalogue (ADR 024), ou une saisie de l'accueil.
 */
export const proposalLineSources = ['booking', 'service', 'manual'] as const
export type ProposalLineSource = (typeof proposalLineSources)[number]
export const proposalLineSourceEnum = (name: string) => mysqlEnum(name, proposalLineSources)

/**
 * Ligne de devis : ce que Dolibarr reprend en ligne de proposition
 * (désignation, quantité, prix unitaire HT, remise, TVA).
 *
 * Le montant HT est calculé par la base, par la règle d'arrondi unique
 * (ADR 023) : le devis, et demain la facture Dolibarr, tombent au même
 * centime que ce que l'écran a annoncé.
 *
 * Figée dès que le devis quitte `draft` (`CA016`). Retirée d'un brouillon par
 * `deleted_at`.
 */
export const proposalLines = mysqlTable(
  'proposal_lines',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    proposalId: char('proposal_id', { length: 36 }).notNull(),
    position: int('position').notNull(),
    source: proposalLineSourceEnum('source').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    unit: rateUnitEnum('unit').notNull(),
    quantity: int('quantity').notNull(),
    /** Prix unitaire HT en centimes (décision 5). */
    unitPriceCents: int('unit_price_cents').notNull(),
    discountBp: int('discount_bp'),
    discountAmountCents: int('discount_amount_cents'),
    amountCents: int('amount_cents').generatedAlwaysAs(
      lineNetAmountSql({
        quantity: 'quantity',
        unitPrice: 'unit_price_cents',
        discountBp: 'discount_bp',
        discountCents: 'discount_amount_cents',
      }),
      { mode: 'stored' },
    ),
    vatRateBp: int('vat_rate_bp').notNull(),
    /** Repères pour Dolibarr : la ressource, le service, la ligne de grille. */
    resourceId: char('resource_id', { length: 36 }),
    serviceId: char('service_id', { length: 36 }),
    ratePlanItemId: char('rate_plan_item_id', { length: 36 }),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (table) => [
    foreignKey({
      name: 'proposal_lines_proposal_fk',
      columns: [table.tenantId, table.proposalId],
      foreignColumns: [proposals.tenantId, proposals.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'proposal_lines_resource_fk',
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [resources.tenantId, resources.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'proposal_lines_service_fk',
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'proposal_lines_rate_plan_item_fk',
      columns: [table.tenantId, table.ratePlanItemId],
      foreignColumns: [ratePlanItems.tenantId, ratePlanItems.id],
    }).onDelete('restrict'),
    check('proposal_lines_label_not_blank', sql`trim(${table.label}) <> ''`),
    check(
      'proposal_lines_values_valid',
      sql`${table.quantity} > 0 and ${table.unitPriceCents} >= 0 and ${table.vatRateBp} between 0 and 10000
        and (${table.discountBp} is not null) + (${table.discountAmountCents} is not null) <= 1
        and (${table.discountBp} is null or ${table.discountBp} between 0 and 10000)
        and (${table.discountAmountCents} is null or ${table.discountAmountCents} >= 0)
        and ${table.amountCents} >= 0`,
    ),
    check('proposal_lines_service_source', sql`(${table.source} = 'service') = (${table.serviceId} is not null)`),
    index('proposal_lines_proposal_idx').on(table.tenantId, table.proposalId, table.position),
  ],
)

export type ProposalLine = typeof proposalLines.$inferSelect
export type NewProposalLine = typeof proposalLines.$inferInsert
