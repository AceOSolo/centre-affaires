CREATE TYPE "public"."staff_role" AS ENUM('admin', 'staff');--> statement-breakpoint
CREATE TABLE "staff_members" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"auth_user_id" text,
	"email" text NOT NULL,
	"full_name" text,
	"role" "staff_role" DEFAULT 'staff' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_members_tenant_email_key" ON "staff_members" USING btree ("tenant_id","email") WHERE deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_members_auth_user_key" ON "staff_members" USING btree ("auth_user_id") WHERE auth_user_id is not null and deleted_at is null;--> statement-breakpoint
CREATE INDEX "staff_members_tenant_idx" ON "staff_members" USING btree ("tenant_id");