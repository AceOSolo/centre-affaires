ALTER TABLE "bookings" ALTER COLUMN "channel" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contracts" ALTER COLUMN "reference" SET DEFAULT next_contract_reference();--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_contract_fk" FOREIGN KEY ("tenant_id","contract_id") REFERENCES "public"."contracts"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_reference_not_blank" CHECK (btrim("contracts"."reference") <> '');