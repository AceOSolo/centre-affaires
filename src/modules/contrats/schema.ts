import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
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
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { deletedAt, primaryKeyId, timestamps } from '../../db/columns.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenantId } from '../../db/tenants.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import {
  billingPeriodEnum,
  billingPeriods,
  lineNetAmountSql,
  offerItems,
  offers,
  rateUnitEnum,
  ratePlans,
  services,
  type BillingPeriod,
} from '../facturation/schema.ts'
import { resourceTypeEnum, resources } from '../ressources/schema.ts'

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

// Déclarée avec le catalogue (`facturation/schema.ts`), dont les offres
// proposent une période : la redéclarer ici ferait deux énumérations du même nom.
export { billingPeriodEnum, billingPeriods, type BillingPeriod }

export const contracts = pgTable(
  'contracts',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    clientId: uuid('client_id').notNull(),
    /**
     * Référence lisible portée sur les documents.
     *
     * Omise à l'insertion, elle est attribuée par la base : `CT-2026-0001`, la
     * suivante de la série du centre pour l'année en cours (ADR 021). Une
     * référence saisie à la main reste acceptée — les contrats repris d'avant
     * l'application gardent la leur. Passer une chaîne vide est refusé : il
     * faut omettre la valeur (`undefined`) pour obtenir un numéro.
     */
    reference: text('reference').notNull().default(sql`next_contract_reference()`),
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
    /**
     * Montant HT par période de la version initiale, en centimes (décision 5).
     *
     * Quand le contrat a des lignes (`contract_lines` sans avenant), la base le
     * tient égal à la somme de leurs montants nets récurrents : la valeur écrite
     * est alors ignorée (ADR 025). Sans ligne, c'est le loyer, à la TVA
     * `vat_rate_bp`. Figé dès que le contrat n'est plus un brouillon : un prix
     * qui change passe par un avenant (SQLSTATE `CA004`).
     */
    amountCents: integer('amount_cents').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    /** Taux de TVA de `amount_cents` pour un contrat sans ligne, en points de base. */
    vatRateBp: integer('vat_rate_bp').notNull().default(2000),
    /** Offre dont le contrat est tiré (R09, R12) ; ses lignes en sont copiées. */
    offerId: uuid('offer_id'),
    /**
     * Durée d'engagement, en mois (R10, ADR 023). Nulle : sans engagement.
     * Figée hors brouillon, comme le prix.
     */
    commitmentMonths: integer('commitment_months'),
    /**
     * Dernier jour de l'engagement, calculé par la base : de date à date, le
     * premier jour plus la durée, moins un jour (du 10 mars au 9 mars suivant
     * pour douze mois). Nul sans engagement.
     */
    commitmentEndsOn: date('commitment_ends_on', { mode: 'string' }).generatedAlwaysAs(
      sql`CASE WHEN commitment_months IS NULL THEN NULL ELSE (starts_on + make_interval(months => commitment_months))::date - 1 END`,
    ),
    /**
     * Reconduction tacite : au terme (`ends_on`), le contrat se prolonge de
     * `renewal_months` sauf préavis (`notice_days`). La prolongation est
     * écrite par le code (nouvel `ends_on`), la règle est ici.
     */
    tacitRenewal: boolean('tacit_renewal').notNull().default(false),
    renewalMonths: integer('renewal_months'),
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
    // Cible de la clé étrangère composite de `bookings.contract_id` : une
    // réservation ne peut pas se rattacher au contrat d'un autre centre.
    unique('contracts_tenant_id_id_key').on(table.tenantId, table.id),
    // Cible des clés étrangères qui exigent le même client que le contrat :
    // une souscription rattachée à un contrat est celle de son client.
    unique('contracts_tenant_id_client_key').on(table.tenantId, table.id, table.clientId),
    foreignKey({
      name: 'contracts_offer_fk',
      columns: [table.tenantId, table.offerId],
      foreignColumns: [offers.tenantId, offers.id],
    }).onDelete('restrict'),
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

    check('contracts_reference_not_blank', sql`btrim(${table.reference}) <> ''`),
    check('contracts_amount_positive', sql`${table.amountCents} >= 0`),
    check('contracts_notice_positive', sql`${table.noticeDays} >= 0`),
    check('contracts_vat_rate_valid', sql`${table.vatRateBp} between 0 and 10000`),
    check(
      'contracts_commitment_valid',
      sql`${table.commitmentMonths} is null or ${table.commitmentMonths} between 1 and 120`,
    ),
    check(
      'contracts_renewal_consistent',
      sql`${table.tacitRenewal} = (${table.renewalMonths} is not null) and (${table.renewalMonths} is null or ${table.renewalMonths} between 1 and 120)`,
    ),
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

/**
 * Demande d'une offre groupée depuis l'espace client (R23, R24 ; ADR 036,
 * ADR 041) :
 *
 * - `requested` : transmise à l'accueil, à traiter ;
 * - `contracted` : un contrat en a été tiré pour ce client (`contract_id`) ;
 * - `dismissed` : écartée par l'accueil, avec un motif montré au client.
 *
 * La trace de la demande, que le client retrouve dans son historique : elle
 * ne vit plus dans le journal des envois, purgé au terme de sa durée.
 */
export const offerRequestStatuses = ['requested', 'contracted', 'dismissed'] as const
export type OfferRequestStatus = (typeof offerRequestStatuses)[number]
export const offerRequestStatusEnum = pgEnum('offer_request_status', offerRequestStatuses)

/**
 * Garanties tenues par la base (migration 0044, `CA013`) : datée par elle,
 * jamais supprimée ; client, offre, auteur et date figés ; une seule demande
 * à traiter par entreprise et par offre ; sous portée client, seulement le
 * dépôt d'une offre présentée dans l'espace ; un contrat tiré de cette offre
 * pour ce client, ou un refus de l'accueil, la clôt.
 */
export const offerRequests = pgTable(
  'offer_requests',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    clientId: uuid('client_id').notNull(),
    offerId: uuid('offer_id').notNull(),
    /** La personne de l'entreprise qui l'a déposée depuis son espace. */
    requestedByMemberId: uuid('requested_by_member_id').notNull(),
    /** Posée par la base à l'insertion. */
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    status: offerRequestStatusEnum('status').notNull().default('requested'),
    /** Contrat tiré de l'offre pour ce client, qui clôt la demande. */
    contractId: uuid('contract_id'),
    /** Clôture : date posée par la base, auteur par le code. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedByStaffId: uuid('closed_by_staff_id').references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
    /** Motif d'une demande écartée, montré au client. */
    dismissalReason: text('dismissal_reason'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'offer_requests_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'offer_requests_offer_fk',
      columns: [table.tenantId, table.offerId],
      foreignColumns: [offers.tenantId, offers.id],
    }).onDelete('restrict'),
    // La personne est de l'entreprise de la demande.
    foreignKey({
      name: 'offer_requests_requested_by_member_fk',
      columns: [table.tenantId, table.clientId, table.requestedByMemberId],
      foreignColumns: [clientMembers.tenantId, clientMembers.clientId, clientMembers.id],
    }).onDelete('restrict'),
    // Le contrat est celui de l'entreprise de la demande.
    foreignKey({
      name: 'offer_requests_contract_fk',
      columns: [table.tenantId, table.contractId, table.clientId],
      foreignColumns: [contracts.tenantId, contracts.id, contracts.clientId],
    }).onDelete('restrict'),
    // Une seule demande à traiter par entreprise et par offre : deux clics,
    // deux personnes de l'entreprise, une seule demande.
    uniqueIndex('offer_requests_open_key')
      .on(table.tenantId, table.clientId, table.offerId)
      .where(sql`status = 'requested'`),
    index('offer_requests_client_idx').on(table.tenantId, table.clientId, table.requestedAt),
    check(
      'offer_requests_status_consistent',
      sql`case ${table.status}
        when 'requested' then num_nonnulls(${table.contractId}, ${table.closedAt}, ${table.closedByStaffId}, ${table.dismissalReason}) = 0
        when 'contracted' then ${table.contractId} is not null and ${table.closedAt} is not null and ${table.dismissalReason} is null
        else ${table.contractId} is null and ${table.closedAt} is not null
      end`,
    ),
    check(
      'offer_requests_dismissal_reason_length',
      sql`${table.dismissalReason} is null or char_length(${table.dismissalReason}) <= 500`,
    ),
  ],
)

export type OfferRequest = typeof offerRequests.$inferSelect
export type NewOfferRequest = typeof offerRequests.$inferInsert

/**
 * `draft` : préparé, n'engage rien, se modifie et s'abandonne (`deleted_at`).
 * `signed` : signé, figé ; il compte pour l'échéancier et l'occupation.
 */
export const amendmentStatuses = ['draft', 'signed'] as const
export type AmendmentStatus = (typeof amendmentStatuses)[number]
export const amendmentStatusEnum = pgEnum('contract_amendment_status', amendmentStatuses)

/**
 * Avenants d'un contrat en cours (R12, ADR 025, amende les ADR 006 et 018).
 *
 * Un contrat est une suite de versions : la version initiale (le contrat et
 * ses lignes sans avenant), puis une par avenant signé, à sa date d'effet.
 *
 * - **Prix** : un avenant qui porte des lignes, ou un `amount_cents`, remplace
 *   le prix à partir de sa date d'effet ; sinon le prix précédent continue.
 *   `contract_price_versions(contract_id)` rend les versions de prix.
 * - **Ressource** : `changes_resource` vrai, la ressource devient `resource_id`
 *   (nul : retirée) à partir de la date d'effet. L'occupation suit par
 *   segments : l'ancienne ressource jusqu'à la veille, la nouvelle ensuite
 *   (`contract_segments(contract)`, ADR 025).
 *
 * Signé, un avenant ne change plus (SQLSTATE `CA004`). La signature est
 * refusée (`CA005`) sur un contrat qui n'est pas en cours, une date d'effet
 * qui n'est pas strictement après le début du contrat et après le dernier
 * avenant signé, ou postérieure à son dernier jour. Le numéro est attribué par
 * la base à la création : 1, 2, 3… par contrat.
 */
export const contractAmendments = pgTable(
  'contract_amendments',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    contractId: uuid('contract_id').notNull(),
    /** Attribué par la base (le suivant du contrat) : la valeur écrite est ignorée. */
    number: integer('number').notNull().default(0),
    /** Premier jour de la nouvelle version, jour civil du centre. */
    effectiveOn: date('effective_on', { mode: 'string' }).notNull(),
    status: amendmentStatusEnum('status').notNull().default('draft'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    /** Objet de l'avenant, porté sur le document : « Passage au bureau 12 ». */
    reason: text('reason'),
    changesResource: boolean('changes_resource').notNull().default(false),
    /** Nouvelle ressource quand `changes_resource` ; nulle : la ressource est retirée. */
    resourceId: uuid('resource_id'),
    /**
     * Nouveau montant HT par période. Nul : le prix ne change pas. Tenu par la
     * base égal à la somme des lignes nettes récurrentes de l'avenant quand il
     * en a.
     */
    amountCents: integer('amount_cents'),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (table) => [
    unique('contract_amendments_tenant_id_id_key').on(table.tenantId, table.id),
    // Cible des clés étrangères qui exigent un avenant du même contrat.
    unique('contract_amendments_tenant_contract_id_key').on(
      table.tenantId,
      table.contractId,
      table.id,
    ),
    foreignKey({
      name: 'contract_amendments_contract_fk',
      columns: [table.tenantId, table.contractId],
      foreignColumns: [contracts.tenantId, contracts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contract_amendments_resource_fk',
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [resources.tenantId, resources.id],
    }).onDelete('restrict'),
    uniqueIndex('contract_amendments_number_key').on(table.contractId, table.number),
    check('contract_amendments_number_positive', sql`${table.number} > 0`),
    check(
      'contract_amendments_signed_consistent',
      sql`(${table.status} = 'signed') = (${table.signedAt} is not null)`,
    ),
    check(
      'contract_amendments_resource_consistent',
      sql`${table.changesResource} or ${table.resourceId} is null`,
    ),
    check(
      'contract_amendments_amount_positive',
      sql`${table.amountCents} is null or ${table.amountCents} >= 0`,
    ),
    index('contract_amendments_contract_idx').on(
      table.tenantId,
      table.contractId,
      table.effectiveOn,
    ),
  ],
)

export type ContractAmendment = typeof contractAmendments.$inferSelect
export type NewContractAmendment = typeof contractAmendments.$inferInsert

/**
 * Lignes d'un contrat (R12, ADR 025) : ce que la version facture à chaque
 * période — un bureau, un poste de coworking (type de ressource), un forfait
 * de service, une offre entière — ou une seule fois (`is_recurring` faux :
 * frais de dossier).
 *
 * `amendment_id` nul : ligne de la version initiale ; sinon, ligne de
 * l'avenant, qui remplace toutes les lignes précédentes à sa date d'effet.
 *
 * Seules les lignes d'un brouillon (contrat ou avenant) se modifient ; un
 * contrat engagé change par avenant (SQLSTATE `CA004`). Une ligne retirée d'un
 * brouillon prend `deleted_at`.
 *
 * Les actes inclus (dix numérisations par mois) ne sont pas des lignes de
 * contrat : ils vivent sur une souscription (`subscribed_services`), seule
 * source que la facturation des actes consulte (ADR 024).
 */
export const contractLines = pgTable(
  'contract_lines',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    contractId: uuid('contract_id').notNull(),
    amendmentId: uuid('amendment_id'),
    /* Cible : au plus une des quatre ; aucune pour une ligne libre. */
    resourceId: uuid('resource_id'),
    resourceType: resourceTypeEnum('resource_type'),
    serviceId: uuid('service_id'),
    offerId: uuid('offer_id'),
    /** Ligne d'offre dont celle-ci est copiée, pour la traçabilité. */
    offerItemId: uuid('offer_item_id'),
    /** Désignation portée sur la facture. */
    description: text('description').notNull(),
    quantity: integer('quantity').notNull().default(1),
    unit: rateUnitEnum('unit').notNull().default('month'),
    /** Prix unitaire HT par période, en centimes. */
    unitPriceCents: integer('unit_price_cents').notNull(),
    discountBp: integer('discount_bp'),
    discountAmountCents: integer('discount_amount_cents'),
    vatRateBp: integer('vat_rate_bp').notNull().default(2000),
    /** Montant net HT d'une période entière, calculé par la base (ADR 023). */
    netAmountCents: integer('net_amount_cents').generatedAlwaysAs(
      lineNetAmountSql({
        quantity: 'quantity',
        unitPrice: 'unit_price_cents',
        discountBp: 'discount_bp',
        discountCents: 'discount_amount_cents',
      }),
    ),
    isRecurring: boolean('is_recurring').notNull().default(true),
    position: smallint('position').notNull().default(0),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (table) => [
    unique('contract_lines_tenant_id_id_key').on(table.tenantId, table.id),
    unique('contract_lines_tenant_contract_id_key').on(table.tenantId, table.contractId, table.id),
    foreignKey({
      name: 'contract_lines_contract_fk',
      columns: [table.tenantId, table.contractId],
      foreignColumns: [contracts.tenantId, contracts.id],
    }).onDelete('restrict'),
    // L'avenant est celui du même contrat. `amendment_id` nul : non vérifiée.
    foreignKey({
      name: 'contract_lines_amendment_fk',
      columns: [table.tenantId, table.contractId, table.amendmentId],
      foreignColumns: [
        contractAmendments.tenantId,
        contractAmendments.contractId,
        contractAmendments.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contract_lines_resource_fk',
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [resources.tenantId, resources.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contract_lines_service_fk',
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contract_lines_offer_fk',
      columns: [table.tenantId, table.offerId],
      foreignColumns: [offers.tenantId, offers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contract_lines_offer_item_fk',
      columns: [table.tenantId, table.offerItemId],
      foreignColumns: [offerItems.tenantId, offerItems.id],
    }).onDelete('restrict'),
    check(
      'contract_lines_one_target',
      sql`num_nonnulls(${table.resourceId}, ${table.resourceType}, ${table.serviceId}, ${table.offerId}) <= 1`,
    ),
    check('contract_lines_description_not_blank', sql`btrim(${table.description}) <> ''`),
    check('contract_lines_quantity_positive', sql`${table.quantity} > 0`),
    check('contract_lines_unit_price_positive', sql`${table.unitPriceCents} >= 0`),
    check(
      'contract_lines_discount_valid',
      sql`num_nonnulls(${table.discountBp}, ${table.discountAmountCents}) <= 1 and (${table.discountBp} is null or ${table.discountBp} between 0 and 10000) and (${table.discountAmountCents} is null or ${table.discountAmountCents} >= 0)`,
    ),
    check('contract_lines_vat_rate_valid', sql`${table.vatRateBp} between 0 and 10000`),
    // Une remise ne rend jamais une ligne négative : ce serait un avoir déguisé.
    check('contract_lines_net_positive', sql`${table.netAmountCents} >= 0`),
    index('contract_lines_contract_idx').on(table.tenantId, table.contractId),
  ],
)

export type ContractLine = typeof contractLines.$inferSelect
export type NewContractLine = typeof contractLines.$inferInsert

/**
 * Documents d'un contrat (R12, ADR 025) : chaque version remise au client —
 * le contrat, puis chaque avenant — figée en données structurées. Le PDF n'en
 * est qu'une vue, rendue depuis `snapshot`.
 *
 * Ni modifiable ni supprimable par l'application (droits retirés au rôle
 * applicatif) : un document remis ne se réécrit pas.
 *
 * `version` est attribuée par la base (1, 2, 3… par contrat) et `sha256` est
 * calculée par la base sur la forme canonique de `snapshot`
 * (`snapshot::text`, UTF-8) : les valeurs écrites sont ignorées.
 */
export const contractDocuments = pgTable(
  'contract_documents',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    contractId: uuid('contract_id').notNull(),
    /** Avenant que le document constate ; nul pour le contrat initial. */
    amendmentId: uuid('amendment_id'),
    version: integer('version').notNull().default(0),
    /**
     * Instantané structuré : contrat, parties, lignes, ressource, conditions,
     * tels qu'ils ont été remis. Sa forme est décrite par le module contrats.
     */
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    /** Empreinte SHA-256 de `snapshot::text`, en hexadécimal minuscule. */
    sha256: text('sha256').notNull().default(''),
    /** Membre de l'équipe qui a établi le document ; nul pour un script. */
    generatedBy: uuid('generated_by').references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'contract_documents_contract_fk',
      columns: [table.tenantId, table.contractId],
      foreignColumns: [contracts.tenantId, contracts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contract_documents_amendment_fk',
      columns: [table.tenantId, table.contractId, table.amendmentId],
      foreignColumns: [
        contractAmendments.tenantId,
        contractAmendments.contractId,
        contractAmendments.id,
      ],
    }).onDelete('restrict'),
    uniqueIndex('contract_documents_version_key').on(
      table.tenantId,
      table.contractId,
      table.version,
    ),
    check('contract_documents_version_positive', sql`${table.version} > 0`),
    check('contract_documents_sha256_format', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
)

export type ContractDocument = typeof contractDocuments.$inferSelect
export type NewContractDocument = typeof contractDocuments.$inferInsert

/**
 * Journal des reconductions tacites (R10, ADR 023, ADR 033) : chaque fois que
 * la tâche nocturne prolonge un contrat (`ends_on`), faute de préavis donné à
 * temps, l'ancien et le nouveau terme. Écrit par la tâche seule, jamais
 * modifié ni supprimé : il dit pourquoi un terme a bougé.
 */
export const contractRenewals = pgTable(
  'contract_renewals',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    contractId: uuid('contract_id').notNull(),
    /** Terme avant la reconduction, compris. */
    previousEndsOn: date('previous_ends_on', { mode: 'string' }).notNull(),
    /** Nouveau terme, compris. */
    newEndsOn: date('new_ends_on', { mode: 'string' }).notNull(),
    /** Jour du centre où la reconduction a été inscrite. */
    renewedOn: date('renewed_on', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'contract_renewals_contract_fk',
      columns: [table.tenantId, table.contractId],
      foreignColumns: [contracts.tenantId, contracts.id],
    }).onDelete('restrict'),
    check('contract_renewals_extends', sql`${table.newEndsOn} > ${table.previousEndsOn}`),
    index('contract_renewals_contract_idx').on(table.tenantId, table.contractId),
  ],
)

export type ContractRenewal = typeof contractRenewals.$inferSelect
export type NewContractRenewal = typeof contractRenewals.$inferInsert
