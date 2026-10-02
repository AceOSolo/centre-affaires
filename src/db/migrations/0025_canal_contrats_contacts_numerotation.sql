CREATE TYPE "public"."document_type" AS ENUM('contract', 'invoice', 'credit_note');--> statement-breakpoint
CREATE TYPE "public"."booking_channel" AS ENUM('staff', 'client', 'public');--> statement-breakpoint
CREATE TABLE "document_sequences" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"document_type" "document_type" NOT NULL,
	"year" integer NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_sequences_last_value_positive" CHECK ("document_sequences"."last_value" >= 0),
	CONSTRAINT "document_sequences_year_valid" CHECK ("document_sequences"."year" between 2000 and 9999)
);
--> statement-breakpoint
CREATE TABLE "client_contacts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"client_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"job_title" text,
	"email" text,
	"phone" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_billing" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "client_contacts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "client_contacts_name_not_blank" CHECK (btrim("client_contacts"."full_name") <> '')
);
--> statement-breakpoint
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_kind_valid";--> statement-breakpoint
DROP INDEX "rate_plan_items_type_key";--> statement-breakpoint
DROP INDEX "rate_plan_items_resource_key";--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "public_request_retention_months" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "channel" "booking_channel";--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "requester_anonymized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "contract_id" uuid;--> statement-breakpoint
ALTER TABLE "rate_plan_items" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_scans" ADD COLUMN "encryption_key_version" smallint;--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_contacts" ADD CONSTRAINT "client_contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_contacts" ADD CONSTRAINT "client_contacts_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_sequences_series_key" ON "document_sequences" USING btree ("tenant_id","document_type","year");--> statement-breakpoint
CREATE UNIQUE INDEX "client_contacts_primary_key" ON "client_contacts" USING btree ("tenant_id","client_id") WHERE is_primary and deleted_at is null;--> statement-breakpoint
CREATE INDEX "client_contacts_client_idx" ON "client_contacts" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "bookings_contract_idx" ON "bookings" USING btree ("tenant_id","contract_id") WHERE contract_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_contract_occupation_key" ON "bookings" USING btree ("tenant_id","contract_id") WHERE kind = 'contract';--> statement-breakpoint
CREATE INDEX "mail_scans_unencrypted_idx" ON "mail_scans" USING btree ("tenant_id","created_at") WHERE encryption_key_version is null and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "rate_plan_items_type_key" ON "rate_plan_items" USING btree ("rate_plan_id","resource_type","unit") WHERE resource_id is null and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "rate_plan_items_resource_key" ON "rate_plan_items" USING btree ("rate_plan_id","resource_id","unit") WHERE resource_id is not null and deleted_at is null;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_public_request_retention_valid" CHECK ("tenants"."public_request_retention_months" between 1 and 120);--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_contract_kind_consistent" CHECK ("bookings"."kind" <> 'contract' or "bookings"."contract_id" is not null);--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_kind_valid" CHECK ("bookings"."kind" in ('booking', 'unavailability', 'contract'));--> statement-breakpoint
ALTER TABLE "mail_scans" ADD CONSTRAINT "mail_scans_encryption_key_version_positive" CHECK ("mail_scans"."encryption_key_version" is null or "mail_scans"."encryption_key_version" > 0);