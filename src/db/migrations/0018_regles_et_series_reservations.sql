ALTER TABLE "tenants" ADD COLUMN "booking_lead_hours" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "booking_horizon_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "kind" text DEFAULT 'booking' NOT NULL;--> statement-breakpoint
CREATE INDEX "bookings_series_idx" ON "bookings" USING btree ("tenant_id","series_id");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_booking_delays_valid" CHECK ("tenants"."booking_lead_hours" >= 0 and "tenants"."booking_horizon_days" between 1 and 365 and "tenants"."booking_lead_hours" < "tenants"."booking_horizon_days" * 24);--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_kind_valid" CHECK ("bookings"."kind" in ('booking', 'unavailability'));