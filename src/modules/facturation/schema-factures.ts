import { sql } from 'drizzle-orm'
import {
  char,
  check,
  customType,
  date,
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  smallint,
  text,
  tinyint,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { deletedAt, instant, primaryKeyId, timestamps } from '../../db/columns.ts'
import { tenantContext } from '../../db/contexte.ts'
import { staffMembers } from '../../db/staff.ts'
import { DEFAULT_TENANT_ID, paymentMethodEnum, tenantId, tenants } from '../../db/tenants.ts'
import { clients } from '../clients/schema.ts'
import { contractLines, contracts } from '../contrats/schema.ts'
import { mailItems, mailRequests, mailScans } from '../courrier/schema.ts'
import { bookings } from '../reservations/schema.ts'
import { resources } from '../ressources/schema.ts'
import { lineNetAmountSql, rateUnitEnum, services } from './schema.ts'

/**
 * Facturation (R13 à R16, ADR 026 et 027) : souscriptions, factures et avoirs,
 * lots de facturation, paiements, mandats SEPA, export comptable.
 *
 * À part du catalogue (`schema.ts`) parce que ces tables dépendent des
 * contrats, des réservations et du courrier, qui eux importent le catalogue :
 * les réunir ferait une boucle d'imports.
 *
 * Les garanties sont en base (`src/db/regles/50-facturation.sql`) : une
 * facture émise ne change plus (`CA002`), son numéro vient de
 * `issue_invoice()`, une source n'est facturée qu'une fois hors avoir, les
 * totaux se recalculent depuis les lignes (`invoice_refresh_amounts()`), le
 * statut de paiement se déduit des paiements.
 */

/**
 * Binaire : `varbinary(512)` (un IBAN scellé en tient largement), rendu en
 * `Buffer` par le pilote. Drizzle n'a pas de type binaire utilisable en `Buffer`.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'varbinary(512)'
  },
})

/**
 * Services souscrits par un client (R18, R07, ADR 024) : un forfait payé par
 * période, ou un acte dont une quantité est incluse par période.
 *
 * Le prix et la TVA sont figés à la souscription : changer le catalogue ne
 * change rien aux souscriptions en cours. Un acte souscrit est facturé à ce
 * prix au-delà de `included_quantity` ; sans souscription, au prix du
 * catalogue.
 *
 * Une même souscription ne se chevauche pas elle-même : un client ne souscrit
 * pas deux fois le même service, pour le même contrat, sur des périodes qui se
 * recouvrent (contrainte d'exclusion `subscribed_services_no_overlap`). Pour
 * deux lignes de standard, on souscrit une quantité de deux. MySQL n'a pas de
 * contrainte d'exclusion : les triggers `subscribed_services_before_insert` /
 * `_update` (`src/db/regles/50-facturation.sql`, `CA000`) la tiennent.
 */
export const subscribedServices = mysqlTable(
  'subscribed_services',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    clientId: char('client_id', { length: 36 }).notNull(),
    /** Contrat dans le cadre duquel le service est souscrit, du même client. */
    contractId: char('contract_id', { length: 36 }),
    serviceId: char('service_id', { length: 36 }).notNull(),
    quantity: int('quantity').notNull().default(1),
    /** Unité du service à la souscription, figée avec le prix. */
    unit: rateUnitEnum('unit').notNull(),
    /** Prix unitaire HT figé à la souscription, en centimes. */
    unitPriceCents: int('unit_price_cents').notNull(),
    discountBp: int('discount_bp'),
    discountAmountCents: int('discount_amount_cents'),
    /** Montant net HT par période (forfait), calculé par la base. */
    netAmountCents: int('net_amount_cents').generatedAlwaysAs(
      lineNetAmountSql({
        quantity: 'quantity',
        unitPrice: 'unit_price_cents',
        discountBp: 'discount_bp',
        discountCents: 'discount_amount_cents',
      }),
      { mode: 'stored' },
    ),
    /** Taux de TVA figé à la souscription, en points de base. */
    vatRateBp: int('vat_rate_bp').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    /** Actes inclus par période de facturation ; nul pour un forfait. */
    includedQuantity: int('included_quantity'),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    /** Dernier jour, compris. Nul : jusqu'à résiliation. */
    endsOn: date('ends_on', { mode: 'string' }),
    notes: text('notes'),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (table) => [
    unique('subscribed_services_tenant_id_id_key').on(table.tenantId, table.id),
    foreignKey({
      name: 'subscribed_services_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    // Le contrat est celui du même client. `contract_id` nul : non vérifiée.
    foreignKey({
      name: 'subscribed_services_contract_fk',
      columns: [table.tenantId, table.contractId, table.clientId],
      foreignColumns: [contracts.tenantId, contracts.id, contracts.clientId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'subscribed_services_service_fk',
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }).onDelete('restrict'),
    check('subscribed_services_quantity_positive', sql`${table.quantity} > 0`),
    check('subscribed_services_unit_price_positive', sql`${table.unitPriceCents} >= 0`),
    check(
      'subscribed_services_discount_valid',
      sql`((${table.discountBp} is not null) + (${table.discountAmountCents} is not null)) <= 1 and (${table.discountBp} is null or ${table.discountBp} between 0 and 10000) and (${table.discountAmountCents} is null or ${table.discountAmountCents} >= 0)`,
    ),
    check('subscribed_services_net_positive', sql`${table.netAmountCents} >= 0`),
    check('subscribed_services_vat_rate_valid', sql`${table.vatRateBp} between 0 and 10000`),
    check(
      'subscribed_services_included_positive',
      sql`${table.includedQuantity} is null or ${table.includedQuantity} >= 0`,
    ),
    check(
      'subscribed_services_period_ordered',
      sql`${table.endsOn} is null or ${table.endsOn} >= ${table.startsOn}`,
    ),
    index('subscribed_services_client_idx').on(table.tenantId, table.clientId),
    index('subscribed_services_service_idx').on(table.tenantId, table.serviceId),
    index('subscribed_services_contract_idx').on(table.tenantId, table.contractId),
  ],
)

export type SubscribedService = typeof subscribedServices.$inferSelect
export type NewSubscribedService = typeof subscribedServices.$inferInsert

/** `running` : en cours (un seul à la fois par centre) ; puis `completed` ou `failed`. */
export const invoiceRunStatuses = ['running', 'completed', 'failed'] as const
export type InvoiceRunStatus = (typeof invoiceRunStatuses)[number]
export const invoiceRunStatusEnum = (name: string) => mysqlEnum(name, invoiceRunStatuses)

/** Bilan d'un lot, écrit par le code qui le déroule. */
export type InvoiceRunResult = {
  /** Factures créées en brouillon par le lot. */
  invoicesCreated?: number
  /** Brouillons du lot déjà présents, complétés par un lot rejoué. */
  invoicesUpdated?: number
  /** Lignes écrites par le lot. */
  linesCreated?: number
  /** Clients sans rien à facturer sur la période. */
  clientsSkipped?: number
  /** Ce que le lot n'a pas pu valoriser, à reprendre à la main. */
  warnings?: { clientId?: string; message: string }[]
  /** Cause d'un échec. */
  error?: string
}

/**
 * Lots de facturation périodique (R13, ADR 026) : une génération de
 * brouillons pour une période, par un membre de l'équipe ou par la tâche
 * planifiée du serveur (ADR 033), et son bilan.
 *
 * Un seul lot `running` à la fois par centre (index unique partiel) : deux
 * générations simultanées se refusent au lieu de se marcher dessus. Rejouer un
 * lot sur la même période ne crée pas de doublon : une facture de lot est
 * unique par client et par période (`invoices_run_period_key`), et chaque
 * source n'est facturée qu'une fois.
 */
export const invoiceRuns = mysqlTable(
  'invoice_runs',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    /** Période facturée, jours civils du centre, bornes comprises. */
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    status: invoiceRunStatusEnum('status').notNull().default('running'),
    startedAt: instant('started_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    finishedAt: instant('finished_at'),
    /** Membre de l'équipe qui l'a lancé ; nul : la tâche planifiée du serveur (ADR 033). */
    createdBy: char('created_by', { length: 36 }).references(() => staffMembers.id, { onDelete: 'restrict' }),
    result: json('result').$type<InvoiceRunResult>().notNull().default(sql`(JSON_OBJECT())`),
    ...timestamps(),
    /** `1` tant que le lot tourne, `NULL` ensuite : sert l'unicité du lot en cours. */
    runningLive: tinyint('running_live').generatedAlwaysAs(sql`if(status = 'running', 1, null)`, {
      mode: 'virtual',
    }),
  },
  (table) => [
    unique('invoice_runs_tenant_id_id_key').on(table.tenantId, table.id),
    uniqueIndex('invoice_runs_one_running_key').on(table.tenantId, table.runningLive),
    check('invoice_runs_period_ordered', sql`${table.periodEnd} >= ${table.periodStart}`),
    check(
      'invoice_runs_finished_consistent',
      sql`(${table.status} = 'running') = (${table.finishedAt} is null)`,
    ),
    index('invoice_runs_tenant_period_idx').on(table.tenantId, table.periodStart),
  ],
)

export type InvoiceRun = typeof invoiceRuns.$inferSelect
export type NewInvoiceRun = typeof invoiceRuns.$inferInsert

/** Mandat pour des prélèvements répétés, ou pour un seul (SEPA : RCUR, OOFF). */
export const sepaSequenceTypes = ['recurrent', 'one_off'] as const
export type SepaSequenceType = (typeof sepaSequenceTypes)[number]
export const sepaSequenceTypeEnum = (name: string) => mysqlEnum(name, sepaSequenceTypes)

/**
 * `active` : utilisable ; `revoked` : révoqué par le client ou le centre ;
 * `expired` : caduc, 36 mois sans prélèvement (règlement SEPA).
 */
export const sepaMandateStatuses = ['active', 'revoked', 'expired'] as const
export type SepaMandateStatus = (typeof sepaMandateStatuses)[number]
export const sepaMandateStatusEnum = (name: string) => mysqlEnum(name, sepaMandateStatuses)

/**
 * Mandats de prélèvement SEPA (R16, ADR 016, ADR 027).
 *
 * **L'IBAN n'est jamais en clair en base.** Il est chiffré par l'application
 * avant l'écriture — `sealIban()` (`iban.ts`), AES-256-GCM avec la clé des
 * documents (ADR 020) — et lié au mandat par ses données associées (centre et
 * RUM) : un chiffré recopié sur un autre mandat ne se déchiffre pas. La base
 * refuse tout ce qui n'a pas l'en-tête du format chiffré
 * (`sepa_mandates_iban_sealed`). Seuls les quatre derniers caractères restent
 * lisibles, pour l'affichage.
 *
 * La RUM (référence unique de mandat) n'est jamais réattribuée dans un
 * centre, même après révocation, et elle ne change pas, pas plus que le
 * client (SQLSTATE `CA007`). Un mandat actif au plus par client.
 */
export const sepaMandates = mysqlTable(
  'sepa_mandates',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    clientId: char('client_id', { length: 36 }).notNull(),
    /** RUM : 35 caractères au plus. */
    reference: varchar('reference', { length: 35 }).notNull(),
    /** Titulaire du compte débité. */
    debtorName: text('debtor_name').notNull(),
    /** IBAN chiffré (`sealIban`), jamais en clair. */
    ibanCiphertext: bytea('iban_ciphertext').notNull(),
    /** Version de la clé des documents qui l'a chiffré (ADR 020). */
    ibanKeyVersion: smallint('iban_key_version').notNull(),
    /** Quatre derniers caractères de l'IBAN, pour l'affichage masqué. */
    ibanLast4: char('iban_last4', { length: 4 }).notNull(),
    bic: varchar('bic', { length: 11 }),
    signedOn: date('signed_on', { mode: 'string' }).notNull(),
    sequenceType: sepaSequenceTypeEnum('sequence_type').notNull().default('recurrent'),
    status: sepaMandateStatusEnum('status').notNull().default('active'),
    revokedOn: date('revoked_on', { mode: 'string' }),
    /** Dernier prélèvement : un mandat inutilisé 36 mois devient caduc. */
    lastCollectedOn: date('last_collected_on', { mode: 'string' }),
    ...timestamps(),
    deletedAt: deletedAt(),
    /** `1` pour le mandat actif non archivé, `NULL` sinon : un seul par client. */
    activeLive: tinyint('active_live').generatedAlwaysAs(
      sql`if(status = 'active' and deleted_at is null, 1, null)`,
      { mode: 'virtual' },
    ),
  },
  (table) => [
    unique('sepa_mandates_tenant_id_id_key').on(table.tenantId, table.id),
    // Cible de la clé étrangère des factures : le mandat est celui du client.
    unique('sepa_mandates_tenant_id_client_key').on(table.tenantId, table.id, table.clientId),
    // Une RUM n'est jamais réattribuée dans un centre, archivée comprise.
    unique('sepa_mandates_tenant_reference_key').on(table.tenantId, table.reference),
    foreignKey({
      name: 'sepa_mandates_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    uniqueIndex('sepa_mandates_one_active_key').on(table.tenantId, table.clientId, table.activeLive),
    // `'c'` : la collation est insensible à la casse, la classe de caractères non.
    check(
      'sepa_mandates_reference_format',
      sql`REGEXP_LIKE(${table.reference}, '^[A-Za-z0-9+?/:().,'' -]{1,35}$', 'c') and trim(${table.reference}) <> ''`,
    ),
    check('sepa_mandates_debtor_not_blank', sql`trim(${table.debtorName}) <> ''`),
    // L'en-tête « CAD1 » du format chiffré (`chiffrement-documents.ts`), et au
    // moins la place d'un IBAN de 15 caractères : un IBAN en clair est refusé.
    check(
      'sepa_mandates_iban_sealed',
      sql`substring(${table.ibanCiphertext}, 1, 4) = x'43414431' and octet_length(${table.ibanCiphertext}) >= 49`,
    ),
    check('sepa_mandates_key_version_positive', sql`${table.ibanKeyVersion} > 0`),
    check('sepa_mandates_last4_format', sql`REGEXP_LIKE(${table.ibanLast4}, '^[0-9A-Z]{4}$', 'c')`),
    check(
      'sepa_mandates_bic_format',
      sql`${table.bic} is null or REGEXP_LIKE(${table.bic}, '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$', 'c')`,
    ),
    check(
      'sepa_mandates_revoked_consistent',
      sql`(${table.status} = 'revoked') = (${table.revokedOn} is not null)`,
    ),
    index('sepa_mandates_client_idx').on(table.tenantId, table.clientId),
  ],
)

export type SepaMandate = typeof sepaMandates.$inferSelect
export type NewSepaMandate = typeof sepaMandates.$inferInsert

/**
 * Nature du document (EN 16931, BT-3) : `invoice` (code 380) ou `credit_note`
 * (avoir, code 381). Les montants d'un avoir sont positifs : c'est sa nature
 * qui dit qu'il vient en déduction.
 */
export const invoiceKinds = ['invoice', 'credit_note'] as const
export type InvoiceKind = (typeof invoiceKinds)[number]
export const invoiceKindEnum = (name: string) => mysqlEnum(name, invoiceKinds)

/**
 * Statut d'une facture (ADR 026) :
 *
 * - `draft` : brouillon, sans numéro, modifiable ;
 * - `issued` : émise, numérotée, figée, rien de payé ;
 * - `partially_paid` / `paid` : déduits des paiements et des avoirs ;
 * - `cancelled` : annulée par avoir, entièrement créditée.
 *
 * Hors brouillon, le statut est **déduit** par la base
 * (`invoice_payment_status()`), jamais écrit par le code. Un avoir n'a que
 * `draft` et `issued`.
 */
export const invoiceStatuses = ['draft', 'issued', 'partially_paid', 'paid', 'cancelled'] as const
export type InvoiceStatus = (typeof invoiceStatuses)[number]
export const invoiceStatusEnum = (name: string) => mysqlEnum(name, invoiceStatuses)

/** Vendeur, figé à l'émission depuis `tenants` (mentions obligatoires). */
export type InvoiceSellerSnapshot = {
  legalName: string
  legalForm: string | null
  shareCapitalCents: number | null
  siren: string
  siret: string | null
  vatNumber: string
  rcsCity: string | null
  addressLine1: string
  addressLine2: string | null
  postalCode: string
  city: string
  country: string
  email: string | null
  phone: string | null
  websiteUrl: string | null
  bankIban: string | null
  bankBic: string | null
  sepaCreditorId: string | null
}

/** Acheteur, figé à l'émission depuis `clients`. */
export type InvoiceBuyerSnapshot = {
  name: string
  legalForm: string | null
  siret: string | null
  /** Les neuf premiers chiffres du SIRET, ou nul. */
  siren: string | null
  vatNumber: string | null
  addressLine1: string
  addressLine2: string | null
  postalCode: string
  city: string
  country: string
  email: string | null
  accountingCode: string | null
}

/** Mentions figées à l'émission (ADR 026). */
export type InvoiceLegalMentions = {
  paymentTermsDays: number
  latePaymentPenaltyText: string
  recoveryIndemnityCents: number
  earlyPaymentDiscountText: string
  /** Option pour la TVA d'après les débits : la mention est imprimée. */
  vatOnDebits: boolean
  /** Catégorie de l'opération (réforme de la facturation électronique). */
  operationCategory: 'services'
  footerText: string | null
  /** Numéro de la facture d'origine, pour un avoir. */
  creditedInvoiceNumber: string | null
}

/**
 * Factures et avoirs (R13, R15, R16, ADR 026), en données structurées
 * compatibles EN 16931 : le PDF n'est qu'une vue.
 *
 * **Brouillon** : sans numéro ni date d'émission, il se modifie. La TVA
 * provisoire de chaque ligne est posée par la base à l'écriture ; la
 * répartition par taux et les totaux du brouillon se recalculent par
 * `select invoice_refresh_amounts(id)`, à appeler après les écritures de
 * lignes (MySQL n'a pas de trigger d'instruction). On l'abandonne par
 * `deleted_at` (ses lignes libèrent leurs sources).
 *
 * **Émission** : `select issue_invoice(id, staff_id)`, et rien d'autre. La
 * fonction vérifie les mentions obligatoires, recalcule la TVA par taux, prend
 * le numéro (`next_document_number`), date la facture du jour du centre,
 * calcule l'échéance et fige le vendeur, l'acheteur et les mentions.
 *
 * **Émise** : plus rien ne change (SQLSTATE `CA002`), sauf ce que la base
 * déduit des paiements et des avoirs : `paid_cents`, `credited_cents`,
 * `status`. Toute correction passe par un avoir.
 *
 * Une facture par client et par période pour un lot (`invoice_run_id`) : elle
 * réunit loyers, réservations, forfaits et actes (R15).
 */
export const invoices = mysqlTable(
  'invoices',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    kind: invoiceKindEnum('kind').notNull().default('invoice'),
    /** `FA-2026-0001` ou `AV-2026-0001`, attribué à l'émission. Nul en brouillon. */
    number: varchar('number', { length: 32 }),
    status: invoiceStatusEnum('status').notNull().default('draft'),
    clientId: char('client_id', { length: 36 }).notNull(),
    /** Pour un avoir : la facture qu'il corrige, du même client. */
    creditedInvoiceId: char('credited_invoice_id', { length: 36 }),
    /** Lot qui a créé le brouillon ; nul pour une facture saisie à la main. */
    invoiceRunId: char('invoice_run_id', { length: 36 }),
    /** Période facturée (date des prestations), jours civils du centre. */
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    /** Jour d'émission dans le fuseau du centre, posé par `issue_invoice()`. */
    issueDate: date('issue_date', { mode: 'string' }),
    issuedAt: instant('issued_at'),
    issuedBy: char('issued_by', { length: 36 }).references(() => staffMembers.id, { onDelete: 'restrict' }),
    /** Délai de paiement en jours. Nul en brouillon : celui du centre à l'émission. */
    paymentTermsDays: int('payment_terms_days'),
    /** Échéance : `issue_date + payment_terms_days`, posée à l'émission. */
    dueDate: date('due_date', { mode: 'string' }),
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    /* Totaux tenus par la base depuis les lignes, en centimes. */
    totalExclTaxCents: int('total_excl_tax_cents').notNull().default(0),
    totalTaxCents: int('total_tax_cents').notNull().default(0),
    totalInclTaxCents: int('total_incl_tax_cents').notNull().default(0),
    /** Somme des paiements non annulés, tenue par la base. */
    paidCents: int('paid_cents').notNull().default(0),
    /** Somme TTC des avoirs émis sur cette facture, tenue par la base. */
    creditedCents: int('credited_cents').notNull().default(0),
    expectedPaymentMethod: paymentMethodEnum('expected_payment_method')
      .notNull()
      .default('transfer'),
    /** Mandat de prélèvement du client, pour `direct_debit`. */
    sepaMandateId: char('sepa_mandate_id', { length: 36 }),
    /** RUM du mandat, figée à l'émission. */
    mandateReference: varchar('mandate_reference', { length: 35 }),
    /** Référence de l'acheteur (EN 16931, BT-10) : bon de commande, service. */
    buyerReference: text('buyer_reference'),
    /** Texte libre imprimé sur la facture ; motif d'un avoir. */
    notes: text('notes'),
    sellerSnapshot: json('seller_snapshot').$type<InvoiceSellerSnapshot>(),
    buyerSnapshot: json('buyer_snapshot').$type<InvoiceBuyerSnapshot>(),
    legalMentions: json('legal_mentions').$type<InvoiceLegalMentions>(),
    ...timestamps(),
    /** Abandon d'un brouillon. Une facture émise ne s'efface jamais. */
    deletedAt: deletedAt(),
    /**
     * `1` pour une facture de lot vivante et non annulée : sert l'unicité par
     * client et par période. `NULL` pour tout le reste.
     */
    runPeriodLive: tinyint('run_period_live').generatedAlwaysAs(
      sql`if(kind = 'invoice' and invoice_run_id is not null and deleted_at is null and status <> 'cancelled', 1, null)`,
      { mode: 'virtual' },
    ),
  },
  (table) => [
    unique('invoices_tenant_id_id_key').on(table.tenantId, table.id),
    // Cible de la clé étrangère des avoirs : même client que la facture corrigée.
    unique('invoices_tenant_id_client_key').on(table.tenantId, table.id, table.clientId),
    foreignKey({
      name: 'invoices_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoices_credited_invoice_fk',
      columns: [table.tenantId, table.creditedInvoiceId, table.clientId],
      foreignColumns: [table.tenantId, table.id, table.clientId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoices_run_fk',
      columns: [table.tenantId, table.invoiceRunId],
      foreignColumns: [invoiceRuns.tenantId, invoiceRuns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoices_sepa_mandate_fk',
      columns: [table.tenantId, table.sepaMandateId, table.clientId],
      foreignColumns: [sepaMandates.tenantId, sepaMandates.id, sepaMandates.clientId],
    }).onDelete('restrict'),
    // `number` nul (brouillon) ne se heurte jamais : plusieurs `NULL` permis.
    uniqueIndex('invoices_tenant_number_key').on(table.tenantId, table.number),
    // Une facture de lot par client et par période. Une facture annulée par
    // avoir, ou un brouillon abandonné, laisse la place à la facture corrigée.
    uniqueIndex('invoices_run_period_key').on(
      table.tenantId,
      table.clientId,
      table.periodStart,
      table.periodEnd,
      table.runPeriodLive,
    ),
    check(
      'invoices_number_on_issue',
      sql`(${table.status} = 'draft') = (${table.number} is null)`,
    ),
    check(
      'invoices_issued_complete',
      sql`${table.status} = 'draft' or ((${table.issueDate} is null) + (${table.issuedAt} is null) + (${table.paymentTermsDays} is null) + (${table.dueDate} is null) + (${table.sellerSnapshot} is null) + (${table.buyerSnapshot} is null) + (${table.legalMentions} is null)) = 0`,
    ),
    check(
      'invoices_draft_unsettled',
      sql`${table.status} <> 'draft' or (${table.paidCents} = 0 and ${table.creditedCents} = 0)`,
    ),
    check(
      'invoices_draft_not_issued',
      sql`${table.status} <> 'draft' or ((${table.issueDate} is not null) + (${table.issuedAt} is not null) + (${table.dueDate} is not null) + (${table.sellerSnapshot} is not null) + (${table.buyerSnapshot} is not null) + (${table.legalMentions} is not null) + (${table.mandateReference} is not null)) = 0`,
    ),
    check(
      'invoices_totals_consistent',
      sql`${table.totalInclTaxCents} = ${table.totalExclTaxCents} + ${table.totalTaxCents}`,
    ),
    check(
      'invoices_credit_note_link',
      sql`(${table.kind} = 'credit_note') = (${table.creditedInvoiceId} is not null) and not (${table.creditedInvoiceId} <=> ${table.id})`,
    ),
    check(
      'invoices_credit_note_status',
      sql`${table.kind} = 'invoice' or (${table.status} in ('draft', 'issued') and ${table.paidCents} = 0 and ${table.creditedCents} = 0)`,
    ),
    check('invoices_period_ordered', sql`${table.periodEnd} >= ${table.periodStart}`),
    check(
      'invoices_payment_terms_valid',
      sql`${table.paymentTermsDays} is null or ${table.paymentTermsDays} between 0 and 60`,
    ),
    check(
      'invoices_mandate_for_direct_debit',
      sql`${table.sepaMandateId} is null or ${table.expectedPaymentMethod} = 'direct_debit'`,
    ),
    check('invoices_credited_positive', sql`${table.creditedCents} >= 0`),
    // Hors brouillon, le statut est une fonction des montants (R16, ADR 026) :
    // même règle que `invoice_payment_status()`, écrite en ligne parce qu'un
    // `CHECK` MySQL n'appelle pas de fonction stockée.
    check(
      'invoices_status_derived',
      sql`${table.status} = 'draft' or ${table.status} = (case
        when ${table.kind} = 'credit_note' then 'issued'
        when ${table.totalInclTaxCents} > 0 and ${table.creditedCents} >= ${table.totalInclTaxCents} then 'cancelled'
        when ${table.totalInclTaxCents} - ${table.creditedCents} - ${table.paidCents} <= 0 then 'paid'
        when ${table.paidCents} > 0 then 'partially_paid'
        else 'issued'
      end)`,
    ),
    index('invoices_client_idx').on(table.tenantId, table.clientId, table.periodStart),
    index('invoices_tenant_issue_date_idx').on(table.tenantId, table.issueDate),
    index('invoices_credited_invoice_idx').on(table.tenantId, table.creditedInvoiceId),
    index('invoices_run_idx').on(table.tenantId, table.invoiceRunId),
  ],
)

export type Invoice = typeof invoices.$inferSelect
export type NewInvoice = typeof invoices.$inferInsert

/**
 * Nature d'une ligne (R15) : `rent` (loyer d'un contrat), `booking`
 * (réservation ponctuelle), `package` (forfait souscrit ou ligne de service
 * d'un contrat), `act` (acte : ouverture d'un pli), `discount` (remise portée
 * en ligne, négative), `other` (ligne libre).
 */
export const invoiceLineKinds = ['rent', 'booking', 'package', 'act', 'discount', 'other'] as const
export type InvoiceLineKind = (typeof invoiceLineKinds)[number]
export const invoiceLineKindEnum = (name: string) => mysqlEnum(name, invoiceLineKinds)

/**
 * Catégorie de TVA (EN 16931, BT-151, liste UNCL5305) : `S` taux normal ou
 * réduit, `Z` taux zéro, `E` exonéré, `AE` autoliquidation, `K` livraison
 * intracommunautaire, `G` export, `O` hors champ. Toute autre que `S` a un
 * taux nul ; toute autre que `S` et `Z` appelle un motif
 * (`vat_exemption_reason`), exigé à l'émission (ADR 032).
 */
export const vatCategories = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O'] as const
export type VatCategory = (typeof vatCategories)[number]
export const vatCategoryEnum = (name: string) => mysqlEnum(name, vatCategories)

/**
 * Lignes d'une facture ou d'un avoir (R15, ADR 026).
 *
 * **Montants.** `net_amount_cents` est calculé par la base
 * (`line_net_amount_cents`) : quantité × prix unitaire, moins la remise, au
 * prorata `prorata_numerator / prorata_denominator` d'une période partielle,
 * arrondi une seule fois au centime. La TVA (`vat_amount_cents`) et le TTC
 * (`total_amount_cents`) sont tenus par la base : TVA calculée par taux sur la
 * somme des lignes (EN 16931), l'écart d'arrondi porté par la plus forte ligne
 * du taux. Les valeurs écrites par le code pour ces deux colonnes sont
 * ignorées.
 *
 * **Sources.** Une ligne de facture désigne ce qu'elle facture : contrat et
 * ligne de contrat (loyer, forfait), réservation, souscription, pli. Tant
 * qu'elle la tient (`deleted_at` et `released_at` nuls), aucune autre ligne
 * ne peut facturer la même source : même réservation, même pli, ou même ligne
 * de contrat ou souscription sur des jours qui se recouvrent (`23505` pour
 * une réservation, un pli ou une demande ; `CA000` pour des jours qui se
 * recouvrent). Une ligne entièrement créditée par un avoir émis libère sa
 * source (`released_at`), qui peut être refacturée.
 *
 * Une ligne d'avoir ne porte aucune source : elle désigne la ligne qu'elle
 * crédite (`credited_line_id`), ou rien pour un geste commercial.
 */
export const invoiceLines = mysqlTable(
  'invoice_lines',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    invoiceId: char('invoice_id', { length: 36 }).notNull(),
    /** Ordre d'affichage sur la facture. */
    position: smallint('position').notNull().default(0),
    kind: invoiceLineKindEnum('kind').notNull(),
    /** Désignation (EN 16931, BT-153). */
    description: text('description').notNull(),
    /** Période de la prestation, jours civils du centre, bornes comprises. */
    periodStart: date('period_start', { mode: 'string' }),
    periodEnd: date('period_end', { mode: 'string' }),
    quantity: int('quantity').notNull().default(1),
    unit: rateUnitEnum('unit'),
    /** Prix unitaire HT en centimes ; négatif seulement pour une remise. */
    unitPriceCents: int('unit_price_cents').notNull(),
    discountBp: int('discount_bp'),
    discountAmountCents: int('discount_amount_cents'),
    /** Prorata d'une période partielle : jours couverts / jours de la période. */
    prorataNumerator: int('prorata_numerator'),
    prorataDenominator: int('prorata_denominator'),
    netAmountCents: int('net_amount_cents').generatedAlwaysAs(
      lineNetAmountSql({
        quantity: 'quantity',
        unitPrice: 'unit_price_cents',
        discountBp: 'discount_bp',
        discountCents: 'discount_amount_cents',
        prorataNumerator: 'prorata_numerator',
        prorataDenominator: 'prorata_denominator',
      }),
      { mode: 'stored' },
    ),
    vatRateBp: int('vat_rate_bp').notNull(),
    vatCategory: vatCategoryEnum('vat_category').notNull().default('S'),
    /** Motif d'exonération (EN 16931, BT-120) pour une catégorie autre que `S`. */
    vatExemptionReason: text('vat_exemption_reason'),
    /** Tenue par la base. */
    vatAmountCents: int('vat_amount_cents').notNull().default(0),
    /** Tenue par la base : net + TVA. */
    totalAmountCents: int('total_amount_cents').notNull().default(0),

    /* Sources (lignes de facture seulement). */
    contractId: char('contract_id', { length: 36 }),
    contractLineId: char('contract_line_id', { length: 36 }),
    bookingId: char('booking_id', { length: 36 }),
    subscribedServiceId: char('subscribed_service_id', { length: 36 }),
    mailItemId: char('mail_item_id', { length: 36 }),
    /**
     * Demande de courrier faite (ADR 037) : numérisation seule ou réexpédition.
     * Une ligne `act` (le service `courrier.numerisation` ou
     * `courrier.reexpedition`) et, pour une réexpédition, une ligne `other`
     * des frais d'affranchissement relevés : au plus une de chaque, hors avoir
     * (`invoice_lines_mail_request_key`). L'ouverture demandée, elle, se
     * facture par le pli (`mail_item_id`), jamais par sa demande.
     */
    mailRequestId: char('mail_request_id', { length: 36 }),
    /**
     * Numérisation dont les pages au-delà de celles comprises dans l'ouverture
     * sont facturées (ADR 044) : une ligne `act` du service `courrier.page`,
     * en quantité de pages. Au plus une par numérisation, hors avoir
     * (`invoice_lines_mail_scan_key`).
     */
    mailScanId: char('mail_scan_id', { length: 36 }),
    /** Service du catalogue facturé (forfait, acte) : rentabilité des services (R31). */
    serviceId: char('service_id', { length: 36 }),
    /** Ressource facturée : revenu par ressource (R31). */
    resourceId: char('resource_id', { length: 36 }),
    /** Ligne d'avoir : la ligne de facture qu'elle crédite. */
    creditedLineId: char('credited_line_id', { length: 36 }),
    /**
     * Posé par la base quand la ligne est entièrement créditée par un avoir
     * émis : sa source est libérée et peut être refacturée.
     */
    releasedAt: instant('released_at'),
    ...timestamps(),
    /** Ligne retirée d'un brouillon, ou brouillon abandonné. */
    deletedAt: deletedAt(),
    /**
     * `1` tant que la ligne tient sa source (ni retirée ni libérée par un
     * avoir), `NULL` sinon : sert les index uniques de réservation, de pli et
     * de demande de courrier. Jamais écrite par le code.
     */
    heldLive: tinyint('held_live').generatedAlwaysAs(
      sql`if(deleted_at is null and released_at is null, 1, null)`,
      { mode: 'virtual' },
    ),
  },
  (table) => [
    unique('invoice_lines_tenant_id_id_key').on(table.tenantId, table.id),
    foreignKey({
      name: 'invoice_lines_invoice_fk',
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoice_lines_contract_fk',
      columns: [table.tenantId, table.contractId],
      foreignColumns: [contracts.tenantId, contracts.id],
    }).onDelete('restrict'),
    // La ligne de contrat est une ligne du contrat désigné.
    foreignKey({
      name: 'invoice_lines_contract_line_fk',
      columns: [table.tenantId, table.contractId, table.contractLineId],
      foreignColumns: [contractLines.tenantId, contractLines.contractId, contractLines.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoice_lines_booking_fk',
      columns: [table.tenantId, table.bookingId],
      foreignColumns: [bookings.tenantId, bookings.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoice_lines_subscribed_service_fk',
      columns: [table.tenantId, table.subscribedServiceId],
      foreignColumns: [subscribedServices.tenantId, subscribedServices.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoice_lines_mail_item_fk',
      columns: [table.tenantId, table.mailItemId],
      foreignColumns: [mailItems.tenantId, mailItems.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoice_lines_mail_request_fk',
      columns: [table.tenantId, table.mailRequestId],
      foreignColumns: [mailRequests.tenantId, mailRequests.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoice_lines_mail_scan_fk',
      columns: [table.tenantId, table.mailScanId],
      foreignColumns: [mailScans.tenantId, mailScans.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoice_lines_service_fk',
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoice_lines_resource_fk',
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [resources.tenantId, resources.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'invoice_lines_credited_line_fk',
      columns: [table.tenantId, table.creditedLineId],
      foreignColumns: [table.tenantId, table.id],
    }).onDelete('restrict'),
    // Une réservation, un pli : une seule ligne qui les tient.
    // La source nulle ne se heurte jamais (plusieurs `NULL` permis).
    uniqueIndex('invoice_lines_booking_key').on(table.tenantId, table.bookingId, table.heldLive),
    uniqueIndex('invoice_lines_mail_item_key').on(table.tenantId, table.mailItemId, table.heldLive),
    // Les pages d'une numérisation : une seule ligne qui les tient (ADR 044).
    uniqueIndex('invoice_lines_mail_scan_key').on(table.tenantId, table.mailScanId, table.heldLive),
    // Une demande faite : un acte, et des frais d'affranchissement au plus.
    uniqueIndex('invoice_lines_mail_request_key').on(
      table.tenantId,
      table.mailRequestId,
      table.kind,
      table.heldLive,
    ),
    // Les deux exclusions contre la double facturation d'un contrat ou d'une
    // souscription sur des jours qui se recouvrent n'ont pas d'équivalent
    // MySQL : le trigger `invoice_lines_before_insert` / `_update`
    // (`src/db/regles/50-facturation.sql`) les tient, `CA000`.
    // Un pli et une demande ne se facturent pas sur la même ligne : l'ouverture
    // est la source du pli, chaque demande la sienne.
    check(
      'invoice_lines_one_mail_source',
      sql`(${table.mailItemId} is not null) + (${table.mailRequestId} is not null) + (${table.mailScanId} is not null) <= 1`,
    ),
    check('invoice_lines_description_not_blank', sql`trim(${table.description}) <> ''`),
    check('invoice_lines_quantity_positive', sql`${table.quantity} > 0`),
    check(
      'invoice_lines_period_consistent',
      sql`(${table.periodStart} is null) = (${table.periodEnd} is null) and (${table.periodEnd} is null or ${table.periodEnd} >= ${table.periodStart})`,
    ),
    check(
      'invoice_lines_prorata_valid',
      sql`(${table.prorataNumerator} is null) = (${table.prorataDenominator} is null) and (${table.prorataNumerator} is null or (${table.prorataNumerator} > 0 and ${table.prorataDenominator} >= ${table.prorataNumerator}))`,
    ),
    check(
      'invoice_lines_discount_valid',
      sql`((${table.discountBp} is not null) + (${table.discountAmountCents} is not null)) <= 1 and (${table.discountBp} is null or ${table.discountBp} between 0 and 10000) and (${table.discountAmountCents} is null or ${table.discountAmountCents} >= 0)`,
    ),
    check(
      'invoice_lines_unit_price_sign',
      sql`(case when ${table.kind} = 'discount' then ${table.unitPriceCents} <= 0 else ${table.unitPriceCents} >= 0 end) = 1`,
    ),
    check('invoice_lines_vat_rate_valid', sql`${table.vatRateBp} between 0 and 10000`),
    check(
      'invoice_lines_vat_category_consistent',
      sql`(case when ${table.vatCategory} = 'S' then ${table.vatRateBp} > 0 else ${table.vatRateBp} = 0 end) = 1`,
    ),
    check(
      'invoice_lines_total_consistent',
      sql`${table.totalAmountCents} = ${table.netAmountCents} + ${table.vatAmountCents}`,
    ),
    check(
      'invoice_lines_contract_line_needs_contract',
      sql`${table.contractLineId} is null or ${table.contractId} is not null`,
    ),
    index('invoice_lines_invoice_idx').on(table.tenantId, table.invoiceId),
    index('invoice_lines_resource_idx').on(table.tenantId, table.resourceId),
    index('invoice_lines_service_idx').on(table.tenantId, table.serviceId),
    index('invoice_lines_credited_line_idx').on(table.tenantId, table.creditedLineId),
  ],
)

export type InvoiceLine = typeof invoiceLines.$inferSelect
export type NewInvoiceLine = typeof invoiceLines.$inferInsert

/**
 * Paiements reçus (R16, ADR 016, ADR 027) : pointés à la main, sans
 * prestataire. Un montant négatif est un remboursement.
 *
 * Seulement sur une facture émise (pas un brouillon, pas un avoir), dans sa
 * devise (SQLSTATE `CA006`). Un paiement ne se modifie ni ne s'efface : une
 * erreur de pointage s'annule (`cancelled_at`), la ligne reste. La base tient
 * `invoices.paid_cents` et en déduit le statut de la facture.
 */
export const payments = mysqlTable(
  'payments',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    invoiceId: char('invoice_id', { length: 36 }).notNull(),
    amountCents: int('amount_cents').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    /** Date de valeur du paiement, jour civil du centre. */
    paidOn: date('paid_on', { mode: 'string' }).notNull(),
    method: paymentMethodEnum('method').notNull(),
    /** Référence bancaire : libellé du virement, référence de remise. */
    reference: text('reference'),
    sepaMandateId: char('sepa_mandate_id', { length: 36 }),
    notes: text('notes'),
    recordedBy: char('recorded_by', { length: 36 })
      .notNull()
      .references(() => staffMembers.id, { onDelete: 'restrict' }),
    cancelledAt: instant('cancelled_at'),
    cancelledBy: char('cancelled_by', { length: 36 }).references(() => staffMembers.id, { onDelete: 'restrict' }),
    cancellationReason: text('cancellation_reason'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'payments_invoice_fk',
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payments_sepa_mandate_fk',
      columns: [table.tenantId, table.sepaMandateId],
      foreignColumns: [sepaMandates.tenantId, sepaMandates.id],
    }).onDelete('restrict'),
    check('payments_amount_not_zero', sql`${table.amountCents} <> 0`),
    check(
      'payments_cancelled_consistent',
      sql`(${table.cancelledAt} is null) = (${table.cancelledBy} is null)`,
    ),
    check(
      'payments_mandate_for_direct_debit',
      sql`${table.sepaMandateId} is null or ${table.method} = 'direct_debit'`,
    ),
    index('payments_invoice_idx').on(table.tenantId, table.invoiceId),
    index('payments_tenant_paid_on_idx').on(table.tenantId, table.paidOn),
  ],
)

export type Payment = typeof payments.$inferSelect
export type NewPayment = typeof payments.$inferInsert

/** Comment une relance est partie : par courriel depuis l'application, ou par courrier. */
export const reminderChannels = ['email', 'post'] as const
export type ReminderChannel = (typeof reminderChannels)[number]

/**
 * Journal des relances d'impayés (R16, ADR 030, ADR 034) : chaque relance
 * faite par l'équipe — envoyée par courriel depuis l'application, ou notée
 * comme partie par courrier —, avec son palier (1 relance amiable, 2 seconde
 * relance, 3 mise en demeure), le reste dû réclamé, ses destinataires et son
 * texte.
 *
 * Une preuve : jamais modifiée ni supprimée (trigger `invoice_reminders_before_update`
 * et `_delete`, `CA002`). Rien ne part sans un geste de l'équipe (ADR 030) : `sent_by` est
 * toujours un membre.
 */
export const invoiceReminders = mysqlTable(
  'invoice_reminders',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    invoiceId: char('invoice_id', { length: 36 }).notNull(),
    /** Palier de relance atteint ce jour-là (`dunningLevel`). */
    level: smallint('level').notNull(),
    channel: varchar('channel', { length: 16 }).$type<ReminderChannel>().notNull(),
    /** Adresses de courriel ; vide pour un courrier. */
    recipients: json('recipients').$type<string[]>().notNull().default(sql`(JSON_ARRAY())`),
    /** Reste dû réclamé par la relance, en centimes (décision 5). */
    amountDueCents: int('amount_due_cents').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    /** Objet et texte de la lettre, tels qu'ils sont partis. */
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    sentBy: char('sent_by', { length: 36 })
      .notNull()
      .references(() => staffMembers.id, { onDelete: 'restrict' }),
    sentAt: instant('sent_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    foreignKey({
      name: 'invoice_reminders_invoice_fk',
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }).onDelete('restrict'),
    check('invoice_reminders_level_valid', sql`${table.level} between 1 and 3`),
    check('invoice_reminders_channel_known', sql`${table.channel} in ('email', 'post')`),
    check(
      'invoice_reminders_recipients_consistent',
      sql`(${table.channel} = 'email') = (JSON_LENGTH(${table.recipients}) > 0)`,
    ),
    check('invoice_reminders_amount_positive', sql`${table.amountDueCents} > 0`),
    index('invoice_reminders_invoice_idx').on(table.tenantId, table.invoiceId, table.sentAt),
  ],
)

export type InvoiceReminder = typeof invoiceReminders.$inferSelect
export type NewInvoiceReminder = typeof invoiceReminders.$inferInsert

/**
 * Rôle d'un compte dans l'export comptable (ADR 027) :
 *
 * - `customers` : collectif clients (411) ;
 * - `bank` : banque (512), contrepartie des paiements ;
 * - `revenue` : ventes, un compte par nature de ligne (`line_kind`) ;
 * - `vat_collected` : TVA collectée, un compte par taux (`vat_rate_bp`).
 */
export const accountingPurposes = ['customers', 'bank', 'revenue', 'vat_collected'] as const
export type AccountingPurpose = (typeof accountingPurposes)[number]
export const accountingPurposeEnum = (name: string) => mysqlEnum(name, accountingPurposes)

/**
 * Plan de comptes de l'export, par centre (R16, ADR 027).
 *
 * Paramétrage, pas entité métier : une ligne se corrige en place. Posé par la
 * base pour chaque centre (`seed_accounting_accounts`, à la création du centre
 * et à l'installation) avec des comptes du plan comptable général, **à
 * valider par l'expert-comptable**. Un taux de TVA sans compte fait refuser
 * l'export plutôt que d'improviser.
 *
 * `tenant_id` en `ON DELETE CASCADE`, comme `document_sequences` : un plan de
 * comptes n'existe pas hors de son centre.
 */
export const accountingAccounts = mysqlTable(
  'accounting_accounts',
  {
    id: primaryKeyId(),
    tenantId: char('tenant_id', { length: 36 })
      .notNull()
      .default(DEFAULT_TENANT_ID)
      .$defaultFn(() => tenantContext.getStore() ?? DEFAULT_TENANT_ID)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    purpose: accountingPurposeEnum('purpose').notNull(),
    lineKind: invoiceLineKindEnum('line_kind'),
    vatRateBp: int('vat_rate_bp'),
    /** Numéro de compte : `706000`, `445711`, `411000`. */
    accountNumber: varchar('account_number', { length: 20 }).notNull(),
    label: text('label').notNull(),
    ...timestamps(),
    /**
     * Clés d'unicité **sans `NULL`** : `unique nulls not distinct` de
     * PostgreSQL n'existe pas en MySQL, où plusieurs `NULL` ne se heurtent
     * pas. Jamais écrites par le code.
     */
    lineKindKey: varchar('line_kind_key', { length: 16 }).generatedAlwaysAs(sql`ifnull(line_kind, '')`, {
      mode: 'virtual',
    }),
    vatRateKey: int('vat_rate_key').generatedAlwaysAs(sql`ifnull(vat_rate_bp, -1)`, { mode: 'virtual' }),
  },
  (table) => [
    unique('accounting_accounts_key').on(
      table.tenantId,
      table.purpose,
      table.lineKindKey,
      table.vatRateKey,
    ),
    check(
      'accounting_accounts_target_consistent',
      sql`(case ${table.purpose}
        when 'revenue' then ${table.lineKind} is not null and ${table.vatRateBp} is null
        when 'vat_collected' then ${table.vatRateBp} is not null and ${table.lineKind} is null
        else ${table.lineKind} is null and ${table.vatRateBp} is null
      end) = 1`,
    ),
    check(
      'accounting_accounts_vat_rate_valid',
      sql`${table.vatRateBp} is null or ${table.vatRateBp} between 1 and 10000`,
    ),
    check(
      'accounting_accounts_number_format',
      sql`REGEXP_LIKE(${table.accountNumber}, '^[0-9A-Z]{3,20}$', 'c')`,
    ),
    check('accounting_accounts_label_not_blank', sql`trim(${table.label}) <> ''`),
  ],
)

export type AccountingAccount = typeof accountingAccounts.$inferSelect
export type NewAccountingAccount = typeof accountingAccounts.$inferInsert

/**
 * Journal des exports comptables (R16, ADR 027) : chaque fichier remis à
 * l'expert-comptable, sa période, son auteur et son empreinte. On y ajoute,
 * on y lit, rien d'autre : un trigger refuse `UPDATE` et `DELETE` (`CA002`).
 *
 * Format retenu : `fec`, le fichier des écritures comptables (art. A47 A-1 du
 * livre des procédures fiscales), journaux des ventes et de banque.
 */
export const accountingExports = mysqlTable(
  'accounting_exports',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    format: varchar('format', { length: 16 }).$type<'fec'>().notNull().default('fec'),
    /** Période exportée, jours civils du centre, bornes comprises. */
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    /** SHA-256 du fichier remis, en hexadécimal minuscule. */
    fileSha256: char('file_sha256', { length: 64 }).notNull(),
    /** Nombre d'écritures (lignes du fichier, en-tête exclu). */
    entryCount: int('entry_count').notNull(),
    generatedBy: char('generated_by', { length: 36 })
      .notNull()
      .references(() => staffMembers.id, { onDelete: 'restrict' }),
    createdAt: instant('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    check('accounting_exports_format_known', sql`${table.format} in ('fec')`),
    check('accounting_exports_period_ordered', sql`${table.periodEnd} >= ${table.periodStart}`),
    check(
      'accounting_exports_sha256_format',
      sql`REGEXP_LIKE(${table.fileSha256}, '^[0-9a-f]{64}$', 'c')`,
    ),
    check('accounting_exports_entry_count_positive', sql`${table.entryCount} >= 0`),
    check('accounting_exports_file_name_not_blank', sql`trim(${table.fileName}) <> ''`),
    index('accounting_exports_tenant_period_idx').on(table.tenantId, table.periodStart),
  ],
)

export type AccountingExport = typeof accountingExports.$inferSelect
export type NewAccountingExport = typeof accountingExports.$inferInsert
