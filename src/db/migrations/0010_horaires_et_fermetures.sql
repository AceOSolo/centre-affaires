CREATE TABLE "closures" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"resource_id" uuid,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "closures_period_ordered" CHECK ("closures"."ends_on" >= "closures"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "opening_hours" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"resource_id" uuid,
	"weekday" smallint NOT NULL,
	"opens_at" time NOT NULL,
	"closes_at" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opening_hours_weekday_valid" CHECK ("opening_hours"."weekday" between 1 and 7),
	CONSTRAINT "opening_hours_range_not_empty" CHECK ("opening_hours"."closes_at" > "opening_hours"."opens_at")
);
--> statement-breakpoint
ALTER TABLE "closures" ADD CONSTRAINT "closures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closures" ADD CONSTRAINT "closures_resource_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."resources"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_hours" ADD CONSTRAINT "opening_hours_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_hours" ADD CONSTRAINT "opening_hours_resource_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."resources"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "closures_tenant_period_idx" ON "closures" USING btree ("tenant_id","starts_on","ends_on");--> statement-breakpoint
CREATE UNIQUE INDEX "opening_hours_slot_key" ON "opening_hours" USING btree ("tenant_id",coalesce(resource_id, '00000000-0000-0000-0000-000000000000'::uuid),"weekday","opens_at");--> statement-breakpoint
CREATE INDEX "opening_hours_tenant_weekday_idx" ON "opening_hours" USING btree ("tenant_id","weekday");