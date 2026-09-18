CREATE TYPE "public"."client_status" AS ENUM('prospect', 'active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."rate_unit" AS ENUM('hour', 'day', 'month', 'unit');--> statement-breakpoint
CREATE TYPE "public"."billing_period" AS ENUM('monthly', 'quarterly', 'yearly');--> statement-breakpoint
CREATE TYPE "public"."contract_status" AS ENUM('draft', 'active', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."contract_type" AS ENUM('domiciliation', 'bureau', 'coworking', 'autre');--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"name" text NOT NULL,
	"legal_form" text,
	"siret" text,
	"vat_number" text,
	"email" text,
	"phone" text,
	"address_line1" text,
	"address_line2" text,
	"postal_code" text,
	"city" text,
	"country" char(2) DEFAULT 'FR' NOT NULL,
	"status" "client_status" DEFAULT 'prospect' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "clients_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "rate_plan_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"rate_plan_id" uuid NOT NULL,
	"resource_type" "resource_type" NOT NULL,
	"resource_id" uuid,
	"unit" "rate_unit" NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_plan_items_amount_positive" CHECK ("rate_plan_items"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rate_plans" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "rate_plans_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "rate_plans_validity_ordered" CHECK ("rate_plans"."valid_to" is null or "rate_plans"."valid_from" is null or "rate_plans"."valid_to" >= "rate_plans"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"client_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"contract_type" "contract_type" NOT NULL,
	"status" "contract_status" DEFAULT 'draft' NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"billing_period" "billing_period" DEFAULT 'monthly' NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"rate_plan_id" uuid,
	"resource_id" uuid,
	"notice_days" integer DEFAULT 90 NOT NULL,
	"terminated_on" date,
	"termination_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "contracts_amount_positive" CHECK ("contracts"."amount_cents" >= 0),
	CONSTRAINT "contracts_notice_positive" CHECK ("contracts"."notice_days" >= 0),
	CONSTRAINT "contracts_period_ordered" CHECK ("contracts"."ends_on" is null or "contracts"."ends_on" >= "contracts"."starts_on"),
	CONSTRAINT "contracts_terminated_on_consistent" CHECK (("contracts"."status" = 'terminated') = ("contracts"."terminated_on" is not null))
);
--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_plan_items" ADD CONSTRAINT "rate_plan_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_plan_items" ADD CONSTRAINT "rate_plan_items_plan_fk" FOREIGN KEY ("tenant_id","rate_plan_id") REFERENCES "public"."rate_plans"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_plan_items" ADD CONSTRAINT "rate_plan_items_resource_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."resources"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_rate_plan_fk" FOREIGN KEY ("tenant_id","rate_plan_id") REFERENCES "public"."rate_plans"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_resource_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."resources"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_tenant_siret_key" ON "clients" USING btree ("tenant_id","siret") WHERE deleted_at is null and siret is not null;--> statement-breakpoint
CREATE INDEX "clients_tenant_name_idx" ON "clients" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_plan_items_type_key" ON "rate_plan_items" USING btree ("rate_plan_id","resource_type","unit") WHERE resource_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "rate_plan_items_resource_key" ON "rate_plan_items" USING btree ("rate_plan_id","resource_id","unit") WHERE resource_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "rate_plans_tenant_default_key" ON "rate_plans" USING btree ("tenant_id") WHERE is_default and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_tenant_reference_key" ON "contracts" USING btree ("tenant_id","reference") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "contracts_tenant_client_idx" ON "contracts" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "contracts_tenant_status_idx" ON "contracts" USING btree ("tenant_id","status");