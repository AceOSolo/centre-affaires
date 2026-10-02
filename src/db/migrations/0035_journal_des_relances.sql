CREATE TABLE "invoice_reminders" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"level" smallint NOT NULL,
	"channel" text NOT NULL,
	"recipients" text[] DEFAULT '{}'::text[] NOT NULL,
	"amount_due_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"sent_by" uuid NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_reminders_level_valid" CHECK ("invoice_reminders"."level" between 1 and 3),
	CONSTRAINT "invoice_reminders_channel_known" CHECK ("invoice_reminders"."channel" in ('email', 'post')),
	CONSTRAINT "invoice_reminders_recipients_consistent" CHECK (("invoice_reminders"."channel" = 'email') = (cardinality("invoice_reminders"."recipients") > 0)),
	CONSTRAINT "invoice_reminders_amount_positive" CHECK ("invoice_reminders"."amount_due_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_sent_by_staff_members_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_reminders_invoice_idx" ON "invoice_reminders" USING btree ("tenant_id","invoice_id","sent_at");