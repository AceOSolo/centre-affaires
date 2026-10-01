CREATE TYPE "public"."payment_method" AS ENUM('transfer', 'direct_debit', 'other');--> statement-breakpoint
CREATE TYPE "public"."prorata_rule" AS ENUM('calendar_days', 'thirty_day_month', 'none');--> statement-breakpoint
CREATE TYPE "public"."recurring_billing_timing" AS ENUM('in_advance', 'in_arrears');--> statement-breakpoint
CREATE TYPE "public"."service_nature" AS ENUM('package', 'act');--> statement-breakpoint
CREATE TYPE "public"."accounting_purpose" AS ENUM('customers', 'bank', 'revenue', 'vat_collected');--> statement-breakpoint
CREATE TYPE "public"."invoice_kind" AS ENUM('invoice', 'credit_note');--> statement-breakpoint
CREATE TYPE "public"."invoice_line_kind" AS ENUM('rent', 'booking', 'package', 'act', 'discount', 'other');--> statement-breakpoint
CREATE TYPE "public"."invoice_run_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'issued', 'partially_paid', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sepa_mandate_status" AS ENUM('active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."sepa_sequence_type" AS ENUM('recurrent', 'one_off');--> statement-breakpoint
CREATE TYPE "public"."vat_category" AS ENUM('S', 'Z', 'E', 'AE', 'K', 'G', 'O');--> statement-breakpoint
CREATE TYPE "public"."contract_amendment_status" AS ENUM('draft', 'signed');--> statement-breakpoint
ALTER TYPE "public"."rate_unit" ADD VALUE 'week' BEFORE 'month';--> statement-breakpoint
CREATE TABLE "offer_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"offer_id" uuid NOT NULL,
	"resource_type" "resource_type",
	"resource_id" uuid,
	"service_id" uuid,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit" "rate_unit" DEFAULT 'month' NOT NULL,
	"price_cents" integer,
	"discount_bp" integer,
	"discount_amount_cents" integer,
	"vat_rate_bp" integer,
	"position" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "offer_items_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "offer_items_one_target" CHECK (num_nonnulls("offer_items"."resource_type", "offer_items"."resource_id", "offer_items"."service_id") = 1),
	CONSTRAINT "offer_items_one_pricing" CHECK (num_nonnulls("offer_items"."price_cents", "offer_items"."discount_bp", "offer_items"."discount_amount_cents") <= 1),
	CONSTRAINT "offer_items_quantity_positive" CHECK ("offer_items"."quantity" > 0),
	CONSTRAINT "offer_items_amounts_valid" CHECK (("offer_items"."price_cents" is null or "offer_items"."price_cents" >= 0) and ("offer_items"."discount_bp" is null or "offer_items"."discount_bp" between 0 and 10000) and ("offer_items"."discount_amount_cents" is null or "offer_items"."discount_amount_cents" >= 0) and ("offer_items"."vat_rate_bp" is null or "offer_items"."vat_rate_bp" between 0 and 10000))
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"billing_period" "billing_period" DEFAULT 'monthly' NOT NULL,
	"commitment_months" integer,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "offers_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "offers_name_not_blank" CHECK (btrim("offers"."name") <> ''),
	CONSTRAINT "offers_commitment_valid" CHECK ("offers"."commitment_months" is null or "offers"."commitment_months" between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"description" text,
	"nature" "service_nature" NOT NULL,
	"unit" "rate_unit" NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"vat_rate_bp" integer DEFAULT 2000 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "services_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "services_code_format" CHECK ("services"."code" is null or "services"."code" ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'),
	CONSTRAINT "services_name_not_blank" CHECK (btrim("services"."name") <> ''),
	CONSTRAINT "services_unit_price_positive" CHECK ("services"."unit_price_cents" >= 0),
	CONSTRAINT "services_vat_rate_valid" CHECK ("services"."vat_rate_bp" between 0 and 10000),
	CONSTRAINT "services_act_per_unit" CHECK ("services"."nature" <> 'act' or "services"."unit" = 'unit')
);
--> statement-breakpoint
CREATE TABLE "accounting_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"purpose" "accounting_purpose" NOT NULL,
	"line_kind" "invoice_line_kind",
	"vat_rate_bp" integer,
	"account_number" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_accounts_key" UNIQUE NULLS NOT DISTINCT("tenant_id","purpose","line_kind","vat_rate_bp"),
	CONSTRAINT "accounting_accounts_target_consistent" CHECK (case "accounting_accounts"."purpose"
        when 'revenue' then "accounting_accounts"."line_kind" is not null and "accounting_accounts"."vat_rate_bp" is null
        when 'vat_collected' then "accounting_accounts"."vat_rate_bp" is not null and "accounting_accounts"."line_kind" is null
        else "accounting_accounts"."line_kind" is null and "accounting_accounts"."vat_rate_bp" is null
      end),
	CONSTRAINT "accounting_accounts_vat_rate_valid" CHECK ("accounting_accounts"."vat_rate_bp" is null or "accounting_accounts"."vat_rate_bp" between 1 and 10000),
	CONSTRAINT "accounting_accounts_number_format" CHECK ("accounting_accounts"."account_number" ~ '^[0-9A-Z]{3,20}$'),
	CONSTRAINT "accounting_accounts_label_not_blank" CHECK (btrim("accounting_accounts"."label") <> '')
);
--> statement-breakpoint
CREATE TABLE "accounting_exports" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"format" text DEFAULT 'fec' NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"entry_count" integer NOT NULL,
	"generated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_exports_format_known" CHECK ("accounting_exports"."format" in ('fec')),
	CONSTRAINT "accounting_exports_period_ordered" CHECK ("accounting_exports"."period_end" >= "accounting_exports"."period_start"),
	CONSTRAINT "accounting_exports_sha256_format" CHECK ("accounting_exports"."file_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "accounting_exports_entry_count_positive" CHECK ("accounting_exports"."entry_count" >= 0),
	CONSTRAINT "accounting_exports_file_name_not_blank" CHECK (btrim("accounting_exports"."file_name") <> '')
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"kind" "invoice_line_kind" NOT NULL,
	"description" text NOT NULL,
	"period_start" date,
	"period_end" date,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit" "rate_unit",
	"unit_price_cents" integer NOT NULL,
	"discount_bp" integer,
	"discount_amount_cents" integer,
	"prorata_numerator" integer,
	"prorata_denominator" integer,
	"net_amount_cents" integer GENERATED ALWAYS AS (line_net_amount_cents(quantity, unit_price_cents, discount_bp, discount_amount_cents, prorata_numerator, prorata_denominator)) STORED,
	"vat_rate_bp" integer NOT NULL,
	"vat_category" "vat_category" DEFAULT 'S' NOT NULL,
	"vat_exemption_reason" text,
	"vat_amount_cents" integer DEFAULT 0 NOT NULL,
	"total_amount_cents" integer DEFAULT 0 NOT NULL,
	"contract_id" uuid,
	"contract_line_id" uuid,
	"booking_id" uuid,
	"subscribed_service_id" uuid,
	"mail_item_id" uuid,
	"service_id" uuid,
	"resource_id" uuid,
	"credited_line_id" uuid,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "invoice_lines_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoice_lines_description_not_blank" CHECK (btrim("invoice_lines"."description") <> ''),
	CONSTRAINT "invoice_lines_quantity_positive" CHECK ("invoice_lines"."quantity" > 0),
	CONSTRAINT "invoice_lines_period_consistent" CHECK (("invoice_lines"."period_start" is null) = ("invoice_lines"."period_end" is null) and ("invoice_lines"."period_end" is null or "invoice_lines"."period_end" >= "invoice_lines"."period_start")),
	CONSTRAINT "invoice_lines_prorata_valid" CHECK (("invoice_lines"."prorata_numerator" is null) = ("invoice_lines"."prorata_denominator" is null) and ("invoice_lines"."prorata_numerator" is null or ("invoice_lines"."prorata_numerator" > 0 and "invoice_lines"."prorata_denominator" >= "invoice_lines"."prorata_numerator"))),
	CONSTRAINT "invoice_lines_discount_valid" CHECK (num_nonnulls("invoice_lines"."discount_bp", "invoice_lines"."discount_amount_cents") <= 1 and ("invoice_lines"."discount_bp" is null or "invoice_lines"."discount_bp" between 0 and 10000) and ("invoice_lines"."discount_amount_cents" is null or "invoice_lines"."discount_amount_cents" >= 0)),
	CONSTRAINT "invoice_lines_unit_price_sign" CHECK (case when "invoice_lines"."kind" = 'discount' then "invoice_lines"."unit_price_cents" <= 0 else "invoice_lines"."unit_price_cents" >= 0 end),
	CONSTRAINT "invoice_lines_vat_rate_valid" CHECK ("invoice_lines"."vat_rate_bp" between 0 and 10000),
	CONSTRAINT "invoice_lines_vat_category_consistent" CHECK (case when "invoice_lines"."vat_category" = 'S' then "invoice_lines"."vat_rate_bp" > 0 else "invoice_lines"."vat_rate_bp" = 0 end),
	CONSTRAINT "invoice_lines_total_consistent" CHECK ("invoice_lines"."total_amount_cents" = "invoice_lines"."net_amount_cents" + "invoice_lines"."vat_amount_cents"),
	CONSTRAINT "invoice_lines_contract_line_needs_contract" CHECK ("invoice_lines"."contract_line_id" is null or "invoice_lines"."contract_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "invoice_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" "invoice_run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_runs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoice_runs_period_ordered" CHECK ("invoice_runs"."period_end" >= "invoice_runs"."period_start"),
	CONSTRAINT "invoice_runs_finished_consistent" CHECK (("invoice_runs"."status" = 'running') = ("invoice_runs"."finished_at" is null))
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"kind" "invoice_kind" DEFAULT 'invoice' NOT NULL,
	"number" text,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"client_id" uuid NOT NULL,
	"credited_invoice_id" uuid,
	"invoice_run_id" uuid,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"issue_date" date,
	"issued_at" timestamp with time zone,
	"issued_by" uuid,
	"payment_terms_days" integer,
	"due_date" date,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"total_excl_tax_cents" integer DEFAULT 0 NOT NULL,
	"total_tax_cents" integer DEFAULT 0 NOT NULL,
	"total_incl_tax_cents" integer DEFAULT 0 NOT NULL,
	"paid_cents" integer DEFAULT 0 NOT NULL,
	"credited_cents" integer DEFAULT 0 NOT NULL,
	"expected_payment_method" "payment_method" DEFAULT 'transfer' NOT NULL,
	"sepa_mandate_id" uuid,
	"mandate_reference" text,
	"buyer_reference" text,
	"notes" text,
	"seller_snapshot" jsonb,
	"buyer_snapshot" jsonb,
	"legal_mentions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "invoices_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoices_tenant_id_client_key" UNIQUE("tenant_id","id","client_id"),
	CONSTRAINT "invoices_number_on_issue" CHECK (("invoices"."status" = 'draft') = ("invoices"."number" is null)),
	CONSTRAINT "invoices_issued_complete" CHECK ("invoices"."status" = 'draft' or num_nulls("invoices"."issue_date", "invoices"."issued_at", "invoices"."payment_terms_days", "invoices"."due_date", "invoices"."seller_snapshot", "invoices"."buyer_snapshot", "invoices"."legal_mentions") = 0),
	CONSTRAINT "invoices_draft_unsettled" CHECK ("invoices"."status" <> 'draft' or ("invoices"."paid_cents" = 0 and "invoices"."credited_cents" = 0)),
	CONSTRAINT "invoices_draft_not_issued" CHECK ("invoices"."status" <> 'draft' or num_nonnulls("invoices"."issue_date", "invoices"."issued_at", "invoices"."due_date", "invoices"."seller_snapshot", "invoices"."buyer_snapshot", "invoices"."legal_mentions", "invoices"."mandate_reference") = 0),
	CONSTRAINT "invoices_totals_consistent" CHECK ("invoices"."total_incl_tax_cents" = "invoices"."total_excl_tax_cents" + "invoices"."total_tax_cents"),
	CONSTRAINT "invoices_credit_note_link" CHECK (("invoices"."kind" = 'credit_note') = ("invoices"."credited_invoice_id" is not null) and "invoices"."credited_invoice_id" is distinct from "invoices"."id"),
	CONSTRAINT "invoices_credit_note_status" CHECK ("invoices"."kind" = 'invoice' or ("invoices"."status" in ('draft', 'issued') and "invoices"."paid_cents" = 0 and "invoices"."credited_cents" = 0)),
	CONSTRAINT "invoices_period_ordered" CHECK ("invoices"."period_end" >= "invoices"."period_start"),
	CONSTRAINT "invoices_payment_terms_valid" CHECK ("invoices"."payment_terms_days" is null or "invoices"."payment_terms_days" between 0 and 60),
	CONSTRAINT "invoices_mandate_for_direct_debit" CHECK ("invoices"."sepa_mandate_id" is null or "invoices"."expected_payment_method" = 'direct_debit'),
	CONSTRAINT "invoices_credited_positive" CHECK ("invoices"."credited_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"paid_on" date NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" text,
	"sepa_mandate_id" uuid,
	"notes" text,
	"recorded_by" uuid NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_not_zero" CHECK ("payments"."amount_cents" <> 0),
	CONSTRAINT "payments_cancelled_consistent" CHECK (("payments"."cancelled_at" is null) = ("payments"."cancelled_by" is null)),
	CONSTRAINT "payments_mandate_for_direct_debit" CHECK ("payments"."sepa_mandate_id" is null or "payments"."method" = 'direct_debit')
);
--> statement-breakpoint
CREATE TABLE "sepa_mandates" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"client_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"debtor_name" text NOT NULL,
	"iban_ciphertext" "bytea" NOT NULL,
	"iban_key_version" smallint NOT NULL,
	"iban_last4" char(4) NOT NULL,
	"bic" text,
	"signed_on" date NOT NULL,
	"sequence_type" "sepa_sequence_type" DEFAULT 'recurrent' NOT NULL,
	"status" "sepa_mandate_status" DEFAULT 'active' NOT NULL,
	"revoked_on" date,
	"last_collected_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sepa_mandates_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "sepa_mandates_tenant_id_client_key" UNIQUE("tenant_id","id","client_id"),
	CONSTRAINT "sepa_mandates_tenant_reference_key" UNIQUE("tenant_id","reference"),
	CONSTRAINT "sepa_mandates_reference_format" CHECK ("sepa_mandates"."reference" ~ '^[A-Za-z0-9+?/:().,'' -]{1,35}$' and btrim("sepa_mandates"."reference") <> ''),
	CONSTRAINT "sepa_mandates_debtor_not_blank" CHECK (btrim("sepa_mandates"."debtor_name") <> ''),
	CONSTRAINT "sepa_mandates_iban_sealed" CHECK (substring("sepa_mandates"."iban_ciphertext" from 1 for 4) = '\x43414431'::bytea and octet_length("sepa_mandates"."iban_ciphertext") >= 49),
	CONSTRAINT "sepa_mandates_key_version_positive" CHECK ("sepa_mandates"."iban_key_version" > 0),
	CONSTRAINT "sepa_mandates_last4_format" CHECK ("sepa_mandates"."iban_last4" ~ '^[0-9A-Z]{4}$'),
	CONSTRAINT "sepa_mandates_bic_format" CHECK ("sepa_mandates"."bic" is null or "sepa_mandates"."bic" ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
	CONSTRAINT "sepa_mandates_revoked_consistent" CHECK (("sepa_mandates"."status" = 'revoked') = ("sepa_mandates"."revoked_on" is not null))
);
--> statement-breakpoint
CREATE TABLE "subscribed_services" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"client_id" uuid NOT NULL,
	"contract_id" uuid,
	"service_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit" "rate_unit" NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"discount_bp" integer,
	"discount_amount_cents" integer,
	"net_amount_cents" integer GENERATED ALWAYS AS (line_net_amount_cents(quantity, unit_price_cents, discount_bp, discount_amount_cents, NULL, NULL)) STORED,
	"vat_rate_bp" integer NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"included_quantity" integer,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "subscribed_services_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "subscribed_services_quantity_positive" CHECK ("subscribed_services"."quantity" > 0),
	CONSTRAINT "subscribed_services_unit_price_positive" CHECK ("subscribed_services"."unit_price_cents" >= 0),
	CONSTRAINT "subscribed_services_discount_valid" CHECK (num_nonnulls("subscribed_services"."discount_bp", "subscribed_services"."discount_amount_cents") <= 1 and ("subscribed_services"."discount_bp" is null or "subscribed_services"."discount_bp" between 0 and 10000) and ("subscribed_services"."discount_amount_cents" is null or "subscribed_services"."discount_amount_cents" >= 0)),
	CONSTRAINT "subscribed_services_net_positive" CHECK ("subscribed_services"."net_amount_cents" >= 0),
	CONSTRAINT "subscribed_services_vat_rate_valid" CHECK ("subscribed_services"."vat_rate_bp" between 0 and 10000),
	CONSTRAINT "subscribed_services_included_positive" CHECK ("subscribed_services"."included_quantity" is null or "subscribed_services"."included_quantity" >= 0),
	CONSTRAINT "subscribed_services_period_ordered" CHECK ("subscribed_services"."ends_on" is null or "subscribed_services"."ends_on" >= "subscribed_services"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "contract_amendments" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"contract_id" uuid NOT NULL,
	"number" integer DEFAULT 0 NOT NULL,
	"effective_on" date NOT NULL,
	"status" "contract_amendment_status" DEFAULT 'draft' NOT NULL,
	"signed_at" timestamp with time zone,
	"reason" text,
	"changes_resource" boolean DEFAULT false NOT NULL,
	"resource_id" uuid,
	"amount_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "contract_amendments_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "contract_amendments_tenant_contract_id_key" UNIQUE("tenant_id","contract_id","id"),
	CONSTRAINT "contract_amendments_number_positive" CHECK ("contract_amendments"."number" > 0),
	CONSTRAINT "contract_amendments_signed_consistent" CHECK (("contract_amendments"."status" = 'signed') = ("contract_amendments"."signed_at" is not null)),
	CONSTRAINT "contract_amendments_resource_consistent" CHECK ("contract_amendments"."changes_resource" or "contract_amendments"."resource_id" is null),
	CONSTRAINT "contract_amendments_amount_positive" CHECK ("contract_amendments"."amount_cents" is null or "contract_amendments"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "contract_documents" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"contract_id" uuid NOT NULL,
	"amendment_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"snapshot" jsonb NOT NULL,
	"sha256" text DEFAULT '' NOT NULL,
	"generated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_documents_version_positive" CHECK ("contract_documents"."version" > 0),
	CONSTRAINT "contract_documents_sha256_format" CHECK ("contract_documents"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "contract_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"contract_id" uuid NOT NULL,
	"amendment_id" uuid,
	"resource_id" uuid,
	"resource_type" "resource_type",
	"service_id" uuid,
	"offer_id" uuid,
	"offer_item_id" uuid,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit" "rate_unit" DEFAULT 'month' NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"discount_bp" integer,
	"discount_amount_cents" integer,
	"vat_rate_bp" integer DEFAULT 2000 NOT NULL,
	"net_amount_cents" integer GENERATED ALWAYS AS (line_net_amount_cents(quantity, unit_price_cents, discount_bp, discount_amount_cents, NULL, NULL)) STORED,
	"is_recurring" boolean DEFAULT true NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "contract_lines_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "contract_lines_tenant_contract_id_key" UNIQUE("tenant_id","contract_id","id"),
	CONSTRAINT "contract_lines_one_target" CHECK (num_nonnulls("contract_lines"."resource_id", "contract_lines"."resource_type", "contract_lines"."service_id", "contract_lines"."offer_id") <= 1),
	CONSTRAINT "contract_lines_description_not_blank" CHECK (btrim("contract_lines"."description") <> ''),
	CONSTRAINT "contract_lines_quantity_positive" CHECK ("contract_lines"."quantity" > 0),
	CONSTRAINT "contract_lines_unit_price_positive" CHECK ("contract_lines"."unit_price_cents" >= 0),
	CONSTRAINT "contract_lines_discount_valid" CHECK (num_nonnulls("contract_lines"."discount_bp", "contract_lines"."discount_amount_cents") <= 1 and ("contract_lines"."discount_bp" is null or "contract_lines"."discount_bp" between 0 and 10000) and ("contract_lines"."discount_amount_cents" is null or "contract_lines"."discount_amount_cents" >= 0)),
	CONSTRAINT "contract_lines_vat_rate_valid" CHECK ("contract_lines"."vat_rate_bp" between 0 and 10000),
	CONSTRAINT "contract_lines_net_positive" CHECK ("contract_lines"."net_amount_cents" >= 0)
);
--> statement-breakpoint
DROP INDEX "bookings_contract_occupation_key";--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "rate_plan_items" ADD CONSTRAINT "rate_plan_items_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tenant_id_client_key" UNIQUE("tenant_id","id","client_id");--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "legal_form" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "share_capital_cents" bigint;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "siren" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "siret" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "vat_number" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "rcs_city" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "bank_iban" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "bank_bic" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "sepa_creditor_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "default_payment_method" "payment_method" DEFAULT 'transfer' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "prorata_rule" "prorata_rule" DEFAULT 'calendar_days' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "started_unit_tolerance_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "half_day_minutes" integer DEFAULT 240 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "default_vat_rate_bp" integer DEFAULT 2000 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "invoice_payment_terms_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "recurring_billing_timing" "recurring_billing_timing" DEFAULT 'in_advance' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "vat_on_debits" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "late_payment_penalty_text" text DEFAULT 'Pénalités de retard : taux d’intérêt appliqué par la Banque centrale européenne à son opération de refinancement la plus récente, majoré de 10 points de pourcentage (art. L. 441-10 du Code de commerce).' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "recovery_indemnity_cents" integer DEFAULT 4000 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "early_payment_discount_text" text DEFAULT 'Pas d’escompte pour paiement anticipé.' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "invoice_footer_text" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "accounting_sales_journal" text DEFAULT 'VE' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "accounting_bank_journal" text DEFAULT 'BQ' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "contract_amendment_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "quote_unit" "rate_unit";--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "quote_quantity" integer;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "quote_unit_price_cents" integer;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "quote_discount_bp" integer;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "quote_discount_amount_cents" integer;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "quote_amount_cents" integer GENERATED ALWAYS AS (line_net_amount_cents(quote_quantity, quote_unit_price_cents, quote_discount_bp, quote_discount_amount_cents, NULL, NULL)) STORED;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "quote_vat_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "quote_currency" char(3);--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "quote_rate_plan_item_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "quoted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "accounting_code" text;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "vat_rate_bp" integer DEFAULT 2000 NOT NULL;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "offer_id" uuid;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "commitment_months" integer;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "commitment_ends_on" date GENERATED ALWAYS AS (CASE WHEN commitment_months IS NULL THEN NULL ELSE (starts_on + make_interval(months => commitment_months))::date - 1 END) STORED;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "tacit_renewal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "renewal_months" integer;--> statement-breakpoint
ALTER TABLE "offer_items" ADD CONSTRAINT "offer_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_items" ADD CONSTRAINT "offer_items_offer_fk" FOREIGN KEY ("tenant_id","offer_id") REFERENCES "public"."offers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_items" ADD CONSTRAINT "offer_items_resource_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."resources"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_items" ADD CONSTRAINT "offer_items_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_accounts" ADD CONSTRAINT "accounting_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_exports" ADD CONSTRAINT "accounting_exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_exports" ADD CONSTRAINT "accounting_exports_generated_by_staff_members_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_contract_fk" FOREIGN KEY ("tenant_id","contract_id") REFERENCES "public"."contracts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_contract_line_fk" FOREIGN KEY ("tenant_id","contract_id","contract_line_id") REFERENCES "public"."contract_lines"("tenant_id","contract_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_booking_fk" FOREIGN KEY ("tenant_id","booking_id") REFERENCES "public"."bookings"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_subscribed_service_fk" FOREIGN KEY ("tenant_id","subscribed_service_id") REFERENCES "public"."subscribed_services"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_mail_item_fk" FOREIGN KEY ("tenant_id","mail_item_id") REFERENCES "public"."mail_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_resource_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."resources"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_credited_line_fk" FOREIGN KEY ("tenant_id","credited_line_id") REFERENCES "public"."invoice_lines"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_runs" ADD CONSTRAINT "invoice_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_runs" ADD CONSTRAINT "invoice_runs_created_by_staff_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_by_staff_members_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_credited_invoice_fk" FOREIGN KEY ("tenant_id","credited_invoice_id","client_id") REFERENCES "public"."invoices"("tenant_id","id","client_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_run_fk" FOREIGN KEY ("tenant_id","invoice_run_id") REFERENCES "public"."invoice_runs"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_sepa_mandate_fk" FOREIGN KEY ("tenant_id","sepa_mandate_id","client_id") REFERENCES "public"."sepa_mandates"("tenant_id","id","client_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_staff_members_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_cancelled_by_staff_members_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_sepa_mandate_fk" FOREIGN KEY ("tenant_id","sepa_mandate_id") REFERENCES "public"."sepa_mandates"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sepa_mandates" ADD CONSTRAINT "sepa_mandates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sepa_mandates" ADD CONSTRAINT "sepa_mandates_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscribed_services" ADD CONSTRAINT "subscribed_services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscribed_services" ADD CONSTRAINT "subscribed_services_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscribed_services" ADD CONSTRAINT "subscribed_services_contract_fk" FOREIGN KEY ("tenant_id","contract_id","client_id") REFERENCES "public"."contracts"("tenant_id","id","client_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscribed_services" ADD CONSTRAINT "subscribed_services_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_amendments" ADD CONSTRAINT "contract_amendments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_amendments" ADD CONSTRAINT "contract_amendments_contract_fk" FOREIGN KEY ("tenant_id","contract_id") REFERENCES "public"."contracts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_amendments" ADD CONSTRAINT "contract_amendments_resource_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."resources"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_generated_by_staff_members_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_contract_fk" FOREIGN KEY ("tenant_id","contract_id") REFERENCES "public"."contracts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_amendment_fk" FOREIGN KEY ("tenant_id","contract_id","amendment_id") REFERENCES "public"."contract_amendments"("tenant_id","contract_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_lines" ADD CONSTRAINT "contract_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_lines" ADD CONSTRAINT "contract_lines_contract_fk" FOREIGN KEY ("tenant_id","contract_id") REFERENCES "public"."contracts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_lines" ADD CONSTRAINT "contract_lines_amendment_fk" FOREIGN KEY ("tenant_id","contract_id","amendment_id") REFERENCES "public"."contract_amendments"("tenant_id","contract_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_lines" ADD CONSTRAINT "contract_lines_resource_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."resources"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_lines" ADD CONSTRAINT "contract_lines_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_lines" ADD CONSTRAINT "contract_lines_offer_fk" FOREIGN KEY ("tenant_id","offer_id") REFERENCES "public"."offers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_lines" ADD CONSTRAINT "contract_lines_offer_item_fk" FOREIGN KEY ("tenant_id","offer_item_id") REFERENCES "public"."offer_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offer_items_offer_idx" ON "offer_items" USING btree ("tenant_id","offer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_tenant_code_key" ON "services" USING btree ("tenant_id","code") WHERE code is not null and deleted_at is null;--> statement-breakpoint
CREATE INDEX "services_tenant_nature_idx" ON "services" USING btree ("tenant_id","nature");--> statement-breakpoint
CREATE INDEX "accounting_exports_tenant_period_idx" ON "accounting_exports" USING btree ("tenant_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_booking_key" ON "invoice_lines" USING btree ("tenant_id","booking_id") WHERE booking_id is not null and deleted_at is null and released_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_mail_item_key" ON "invoice_lines" USING btree ("tenant_id","mail_item_id") WHERE mail_item_id is not null and deleted_at is null and released_at is null;--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_resource_idx" ON "invoice_lines" USING btree ("tenant_id","resource_id") WHERE resource_id is not null;--> statement-breakpoint
CREATE INDEX "invoice_lines_service_idx" ON "invoice_lines" USING btree ("tenant_id","service_id") WHERE service_id is not null;--> statement-breakpoint
CREATE INDEX "invoice_lines_credited_line_idx" ON "invoice_lines" USING btree ("tenant_id","credited_line_id") WHERE credited_line_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_runs_one_running_key" ON "invoice_runs" USING btree ("tenant_id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "invoice_runs_tenant_period_idx" ON "invoice_runs" USING btree ("tenant_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_number_key" ON "invoices" USING btree ("tenant_id","number") WHERE number is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_run_period_key" ON "invoices" USING btree ("tenant_id","client_id","period_start","period_end") WHERE kind = 'invoice' and invoice_run_id is not null and deleted_at is null and status <> 'cancelled';--> statement-breakpoint
CREATE INDEX "invoices_client_idx" ON "invoices" USING btree ("tenant_id","client_id","period_start");--> statement-breakpoint
CREATE INDEX "invoices_tenant_issue_date_idx" ON "invoices" USING btree ("tenant_id","issue_date") WHERE issue_date is not null;--> statement-breakpoint
CREATE INDEX "invoices_credited_invoice_idx" ON "invoices" USING btree ("tenant_id","credited_invoice_id") WHERE credited_invoice_id is not null;--> statement-breakpoint
CREATE INDEX "invoices_run_idx" ON "invoices" USING btree ("tenant_id","invoice_run_id") WHERE invoice_run_id is not null;--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "payments" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE INDEX "payments_tenant_paid_on_idx" ON "payments" USING btree ("tenant_id","paid_on");--> statement-breakpoint
CREATE UNIQUE INDEX "sepa_mandates_one_active_key" ON "sepa_mandates" USING btree ("tenant_id","client_id") WHERE status = 'active' and deleted_at is null;--> statement-breakpoint
CREATE INDEX "sepa_mandates_client_idx" ON "sepa_mandates" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "subscribed_services_client_idx" ON "subscribed_services" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "subscribed_services_service_idx" ON "subscribed_services" USING btree ("tenant_id","service_id");--> statement-breakpoint
CREATE INDEX "subscribed_services_contract_idx" ON "subscribed_services" USING btree ("tenant_id","contract_id") WHERE contract_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_amendments_number_key" ON "contract_amendments" USING btree ("contract_id","number");--> statement-breakpoint
CREATE INDEX "contract_amendments_contract_idx" ON "contract_amendments" USING btree ("tenant_id","contract_id","effective_on");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_documents_version_key" ON "contract_documents" USING btree ("tenant_id","contract_id","version");--> statement-breakpoint
CREATE INDEX "contract_lines_contract_idx" ON "contract_lines" USING btree ("tenant_id","contract_id");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_contract_amendment_fk" FOREIGN KEY ("tenant_id","contract_id","contract_amendment_id") REFERENCES "public"."contract_amendments"("tenant_id","contract_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_quote_rate_plan_item_fk" FOREIGN KEY ("tenant_id","quote_rate_plan_item_id") REFERENCES "public"."rate_plan_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_offer_fk" FOREIGN KEY ("tenant_id","offer_id") REFERENCES "public"."offers"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_tenant_accounting_code_key" ON "clients" USING btree ("tenant_id","accounting_code") WHERE deleted_at is null and accounting_code is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_contract_occupation_key" ON "bookings" USING btree ("tenant_id","contract_id",coalesce(contract_amendment_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE kind = 'contract';--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_siren_format" CHECK ("tenants"."siren" is null or "tenants"."siren" ~ '^[0-9]{9}$');--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_siret_format" CHECK ("tenants"."siret" is null or ("tenants"."siret" ~ '^[0-9]{14}$' and ("tenants"."siren" is null or left("tenants"."siret", 9) = "tenants"."siren")));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_vat_number_format" CHECK ("tenants"."vat_number" is null or "tenants"."vat_number" ~ '^[A-Z]{2}[0-9A-Z]{2,13}$');--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_share_capital_positive" CHECK ("tenants"."share_capital_cents" is null or "tenants"."share_capital_cents" >= 0);--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_bank_iban_format" CHECK ("tenants"."bank_iban" is null or "tenants"."bank_iban" ~ '^[A-Z]{2}[0-9]{2}[0-9A-Z]{11,30}$');--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_bank_bic_format" CHECK ("tenants"."bank_bic" is null or "tenants"."bank_bic" ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$');--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_sepa_creditor_id_format" CHECK ("tenants"."sepa_creditor_id" is null or "tenants"."sepa_creditor_id" ~ '^[A-Z]{2}[0-9]{2}[0-9A-Z]{1,31}$');--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_pricing_rules_valid" CHECK ("tenants"."started_unit_tolerance_minutes" between 0 and 59 and "tenants"."half_day_minutes" between 60 and 720 and "tenants"."default_vat_rate_bp" between 0 and 10000);--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_invoicing_rules_valid" CHECK ("tenants"."invoice_payment_terms_days" between 0 and 60 and "tenants"."recovery_indemnity_cents" >= 0 and btrim("tenants"."late_payment_penalty_text") <> '' and btrim("tenants"."early_payment_discount_text") <> '');--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_accounting_journals_valid" CHECK ("tenants"."accounting_sales_journal" ~ '^[0-9A-Z]{1,8}$' and "tenants"."accounting_bank_journal" ~ '^[0-9A-Z]{1,8}$');--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_contract_amendment_kind_consistent" CHECK ("bookings"."contract_amendment_id" is null or "bookings"."kind" = 'contract');--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_quote_complete" CHECK (num_nulls("bookings"."quote_unit", "bookings"."quote_quantity", "bookings"."quote_unit_price_cents", "bookings"."quote_vat_rate_bp", "bookings"."quote_currency", "bookings"."quoted_at") in (0, 6));--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_quote_kind_consistent" CHECK ("bookings"."kind" = 'booking' or "bookings"."quoted_at" is null);--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_quote_values_valid" CHECK ("bookings"."quoted_at" is null or ("bookings"."quote_quantity" > 0 and "bookings"."quote_unit_price_cents" >= 0 and "bookings"."quote_vat_rate_bp" between 0 and 10000 and "bookings"."quote_amount_cents" >= 0 and num_nonnulls("bookings"."quote_discount_bp", "bookings"."quote_discount_amount_cents") <= 1 and ("bookings"."quote_discount_bp" is null or "bookings"."quote_discount_bp" between 0 and 10000) and ("bookings"."quote_discount_amount_cents" is null or "bookings"."quote_discount_amount_cents" >= 0)));--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_quote_extras_need_quote" CHECK ("bookings"."quoted_at" is not null or num_nonnulls("bookings"."quote_discount_bp", "bookings"."quote_discount_amount_cents", "bookings"."quote_rate_plan_item_id") = 0);--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_accounting_code_format" CHECK ("clients"."accounting_code" is null or "clients"."accounting_code" ~ '^[0-9A-Z]{1,17}$');--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_vat_rate_valid" CHECK ("contracts"."vat_rate_bp" between 0 and 10000);--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_commitment_valid" CHECK ("contracts"."commitment_months" is null or "contracts"."commitment_months" between 1 and 120);--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_renewal_consistent" CHECK ("contracts"."tacit_renewal" = ("contracts"."renewal_months" is not null) and ("contracts"."renewal_months" is null or "contracts"."renewal_months" between 1 and 120));