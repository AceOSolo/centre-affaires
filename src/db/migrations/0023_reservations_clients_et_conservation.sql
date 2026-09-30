ALTER TABLE "tenants" ADD COLUMN "mail_scan_retention_months" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "mail_access_log_retention_months" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_client_starts_at_idx" ON "bookings" USING btree ("tenant_id","client_id","starts_at") WHERE client_id is not null;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_mail_retention_valid" CHECK ("tenants"."mail_scan_retention_months" between 1 and 120 and "tenants"."mail_access_log_retention_months" between 1 and 120);