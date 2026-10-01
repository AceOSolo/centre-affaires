import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  char,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core'

import { deletedAt, primaryKeyId, timestamps } from './columns.ts'

/*
 * Énumérations des paramètres du centre (ADR 023, 026, 027). Déclarées ici et
 * non dans `facturation` : `tenants` les porte, et `facturation` importe déjà
 * ce fichier — l'inverse ferait une boucle d'imports.
 */

/**
 * Règle de prorata d'une période partielle (ADR 023, amende l'ADR 006).
 *
 * - `calendar_days` : jours couverts sur jours réels de la période civile,
 *   bornes comprises (règle de l'ADR 006, par défaut) ;
 * - `thirty_day_month` : mois commercial de 30 jours (base 30) ;
 * - `none` : pas de prorata, une période entamée est due en entier.
 */
export const prorataRules = ['calendar_days', 'thirty_day_month', 'none'] as const
export type ProrataRule = (typeof prorataRules)[number]
export const prorataRuleEnum = pgEnum('prorata_rule', prorataRules)

/**
 * Moment où le récurrent (loyers, forfaits) est facturé (ADR 026) : à échoir,
 * la période qui commence, ou échu, la période écoulée. Les réservations et
 * les actes sont toujours facturés échus.
 */
export const recurringBillingTimings = ['in_advance', 'in_arrears'] as const
export type RecurringBillingTiming = (typeof recurringBillingTimings)[number]
export const recurringBillingTimingEnum = pgEnum(
  'recurring_billing_timing',
  recurringBillingTimings,
)

/**
 * Mode de paiement (ADR 016, ADR 027) : suivi à la main, sans prestataire.
 * `direct_debit` est le prélèvement SEPA, sur mandat (`sepa_mandates`).
 */
export const paymentMethods = ['transfer', 'direct_debit', 'other'] as const
export type PaymentMethod = (typeof paymentMethods)[number]
export const paymentMethodEnum = pgEnum('payment_method', paymentMethods)

/** Mention de pénalités de retard par défaut (art. L. 441-10 du Code de commerce). */
export const DEFAULT_LATE_PAYMENT_PENALTY_TEXT =
  'Pénalités de retard : taux d’intérêt appliqué par la Banque centrale européenne à son opération de refinancement la plus récente, majoré de 10 points de pourcentage (art. L. 441-10 du Code de commerce).'

export const DEFAULT_EARLY_PAYMENT_DISCOUNT_TEXT = 'Pas d’escompte pour paiement anticipé.'

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

  /*
   * Durées de conservation du courrier (RGPD, ADR 015), en mois. Par centre :
   * elles s'écrivent dans le contrat de domiciliation, et deux centres n'ont
   * pas forcément le même. Douze mois par défaut, à confirmer par le centre.
   */
  /** Numérisations, comptées depuis leur dépôt. Le fichier est effacé, la ligne reste. */
  mailScanRetentionMonths: integer('mail_scan_retention_months').notNull().default(12),
  /** Journal des consultations. */
  mailAccessLogRetentionMonths: integer('mail_access_log_retention_months').notNull().default(12),
  /**
   * Coordonnées des demandeurs de la page publique (ADR 005, ADR 020), en mois
   * comptés depuis la fin du créneau demandé — ou son annulation, si elle est
   * antérieure. Au terme, `anonymize_expired_public_requests()` les efface ; la
   * réservation reste.
   */
  publicRequestRetentionMonths: integer('public_request_retention_months').notNull().default(12),

  /*
   * Identité légale du vendeur, figée dans chaque facture émise (mentions
   * obligatoires, ADR 026). `legal_name` et l'adresse sont plus haut.
   */
  /** Forme juridique : « SAS », « SARL ». */
  legalForm: text('legal_form'),
  /** Capital social, en centimes. `bigint` : 21,5 M€ dépassent un `integer`. */
  shareCapitalCents: bigint('share_capital_cents', { mode: 'number' }),
  /** Neuf chiffres, sans espace. */
  siren: text('siren'),
  /** Quatorze chiffres, sans espace ; commence par le SIREN. */
  siret: text('siret'),
  /** Numéro de TVA intracommunautaire, sans espace : `FR12345678901`. */
  vatNumber: text('vat_number'),
  /** Ville du greffe d'immatriculation : « RCS Vienne ». */
  rcsCity: text('rcs_city'),

  /*
   * Règlement (ADR 027). L'IBAN du centre est imprimé sur chaque facture payée
   * par virement : c'est une coordonnée publique du vendeur, stockée en clair.
   * Celui d'un client (mandat SEPA) est chiffré, jamais en clair.
   */
  /** IBAN du compte du centre, en majuscules sans espace. */
  bankIban: text('bank_iban'),
  bankBic: text('bank_bic'),
  /** Identifiant créancier SEPA (ICS) : `FR12ZZZ123456`. */
  sepaCreditorId: text('sepa_creditor_id'),
  /** Mode de paiement attendu d'un client sans mandat de prélèvement actif. */
  defaultPaymentMethod: paymentMethodEnum('default_payment_method').notNull().default('transfer'),

  /*
   * Règles tarifaires du centre (R10, ADR 023, amende les ADR 006 et 009) :
   * en base pour se régler par centre (D5). Valeurs par défaut = conventions
   * des ADR 006 et 009, à valider par le centre.
   */
  prorataRule: prorataRuleEnum('prorata_rule').notNull().default('calendar_days'),
  /**
   * Tolérance avant qu'une unité entamée ne soit due, en minutes. 0 : toute
   * unité entamée est due (ADR 006) ; 10 : une réunion de 1 h 10 compte 1 h.
   */
  startedUnitToleranceMinutes: integer('started_unit_tolerance_minutes').notNull().default(0),
  /** Durée d'une demi-journée vendue, en minutes (240 : ADR 009). */
  halfDayMinutes: integer('half_day_minutes').notNull().default(240),
  /** Taux de TVA par défaut, en points de base : 2000 = 20 %. */
  defaultVatRateBp: integer('default_vat_rate_bp').notNull().default(2000),

  /* Facturation (ADR 026). */
  /** Échéance par défaut d'une facture, en jours après son émission. */
  invoicePaymentTermsDays: integer('invoice_payment_terms_days').notNull().default(30),
  recurringBillingTiming: recurringBillingTimingEnum('recurring_billing_timing')
    .notNull()
    .default('in_advance'),
  /**
   * Option pour le paiement de la TVA d'après les débits (prestations de
   * services) : la mention figure alors sur les factures. Faux : TVA exigible
   * à l'encaissement, régime par défaut des services.
   */
  vatOnDebits: boolean('vat_on_debits').notNull().default(false),
  latePaymentPenaltyText: text('late_payment_penalty_text')
    .notNull()
    .default(DEFAULT_LATE_PAYMENT_PENALTY_TEXT),
  /** Indemnité forfaitaire pour frais de recouvrement, en centimes (40 € : art. D. 441-5). */
  recoveryIndemnityCents: integer('recovery_indemnity_cents').notNull().default(4000),
  earlyPaymentDiscountText: text('early_payment_discount_text')
    .notNull()
    .default(DEFAULT_EARLY_PAYMENT_DISCOUNT_TEXT),
  /** Mentions complémentaires imprimées au pied des factures. */
  invoiceFooterText: text('invoice_footer_text'),

  /* Export comptable (ADR 027) : codes des journaux. Les comptes sont dans `accounting_accounts`. */
  accountingSalesJournal: text('accounting_sales_journal').notNull().default('VE'),
  accountingBankJournal: text('accounting_bank_journal').notNull().default('BQ'),

  ...timestamps(),
  deletedAt: deletedAt(),
}, (table) => [
  check('tenants_booking_delays_valid', sql`${table.bookingLeadHours} >= 0 and ${table.bookingHorizonDays} between 1 and 365 and ${table.bookingLeadHours} < ${table.bookingHorizonDays} * 24`),
  check(
    'tenants_mail_retention_valid',
    sql`${table.mailScanRetentionMonths} between 1 and 120 and ${table.mailAccessLogRetentionMonths} between 1 and 120`,
  ),
  check(
    'tenants_public_request_retention_valid',
    sql`${table.publicRequestRetentionMonths} between 1 and 120`,
  ),
  check('tenants_siren_format', sql`${table.siren} is null or ${table.siren} ~ '^[0-9]{9}$'`),
  check(
    'tenants_siret_format',
    sql`${table.siret} is null or (${table.siret} ~ '^[0-9]{14}$' and (${table.siren} is null or left(${table.siret}, 9) = ${table.siren}))`,
  ),
  check(
    'tenants_vat_number_format',
    sql`${table.vatNumber} is null or ${table.vatNumber} ~ '^[A-Z]{2}[0-9A-Z]{2,13}$'`,
  ),
  check(
    'tenants_share_capital_positive',
    sql`${table.shareCapitalCents} is null or ${table.shareCapitalCents} >= 0`,
  ),
  check(
    'tenants_bank_iban_format',
    sql`${table.bankIban} is null or ${table.bankIban} ~ '^[A-Z]{2}[0-9]{2}[0-9A-Z]{11,30}$'`,
  ),
  check(
    'tenants_bank_bic_format',
    sql`${table.bankBic} is null or ${table.bankBic} ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'`,
  ),
  check(
    'tenants_sepa_creditor_id_format',
    sql`${table.sepaCreditorId} is null or ${table.sepaCreditorId} ~ '^[A-Z]{2}[0-9]{2}[0-9A-Z]{1,31}$'`,
  ),
  check(
    'tenants_pricing_rules_valid',
    sql`${table.startedUnitToleranceMinutes} between 0 and 59 and ${table.halfDayMinutes} between 60 and 720 and ${table.defaultVatRateBp} between 0 and 10000`,
  ),
  // 60 jours au plus après l'émission : plafond légal (art. L. 441-10).
  check(
    'tenants_invoicing_rules_valid',
    sql`${table.invoicePaymentTermsDays} between 0 and 60 and ${table.recoveryIndemnityCents} >= 0 and btrim(${table.latePaymentPenaltyText}) <> '' and btrim(${table.earlyPaymentDiscountText}) <> ''`,
  ),
  check(
    'tenants_accounting_journals_valid',
    sql`${table.accountingSalesJournal} ~ '^[0-9A-Z]{1,8}$' and ${table.accountingBankJournal} ~ '^[0-9A-Z]{1,8}$'`,
  ),
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
