ALTER TABLE "bookings" ADD COLUMN "requester_name" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "requester_email" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "requester_phone" text;--> statement-breakpoint
CREATE INDEX "bookings_pending_idx" ON "bookings" USING btree ("tenant_id","starts_at") WHERE status = 'pending';