CREATE TABLE "contract_renewals" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"contract_id" uuid NOT NULL,
	"previous_ends_on" date NOT NULL,
	"new_ends_on" date NOT NULL,
	"renewed_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_renewals_extends" CHECK ("contract_renewals"."new_ends_on" > "contract_renewals"."previous_ends_on")
);
--> statement-breakpoint
ALTER TABLE "invoice_runs" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_renewals" ADD CONSTRAINT "contract_renewals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_renewals" ADD CONSTRAINT "contract_renewals_contract_fk" FOREIGN KEY ("tenant_id","contract_id") REFERENCES "public"."contracts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_renewals_contract_idx" ON "contract_renewals" USING btree ("tenant_id","contract_id");