CREATE TYPE "public"."mail_kind" AS ENUM('lettre', 'recommande', 'colis', 'autre');--> statement-breakpoint
CREATE TYPE "public"."mail_scan_side" AS ENUM('envelope', 'content');--> statement-breakpoint
CREATE TYPE "public"."mail_status" AS ENUM('received', 'opening_requested', 'opened');--> statement-breakpoint
CREATE TABLE "client_members" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"client_id" uuid NOT NULL,
	"auth_user_id" text,
	"email" text NOT NULL,
	"full_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "client_members_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "mail_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" "mail_kind" DEFAULT 'lettre' NOT NULL,
	"sender" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"status" "mail_status" DEFAULT 'received' NOT NULL,
	"registered_by" uuid,
	"opening_requested_at" timestamp with time zone,
	"opening_requested_by" uuid,
	"opened_at" timestamp with time zone,
	"opened_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "mail_items_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "mail_items_status_consistent" CHECK (case "mail_items"."status"
        when 'received' then "mail_items"."opening_requested_at" is null and "mail_items"."opened_at" is null
        when 'opening_requested' then "mail_items"."opening_requested_at" is not null and "mail_items"."opened_at" is null
        when 'opened' then "mail_items"."opened_at" is not null
        else false
      end),
	CONSTRAINT "mail_items_request_complete" CHECK (("mail_items"."opening_requested_at" is null) = ("mail_items"."opening_requested_by" is null)),
	CONSTRAINT "mail_items_opening_complete" CHECK (("mail_items"."opened_at" is null) = ("mail_items"."opened_by" is null))
);
--> statement-breakpoint
CREATE TABLE "mail_scan_views" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"mail_scan_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"viewer" text NOT NULL,
	"staff_member_id" uuid,
	"client_member_id" uuid,
	"auth_user_id" text NOT NULL,
	CONSTRAINT "mail_scan_views_viewer_consistent" CHECK (case "mail_scan_views"."viewer"
        when 'staff' then "mail_scan_views"."staff_member_id" is not null and "mail_scan_views"."client_member_id" is null
        when 'client' then "mail_scan_views"."client_member_id" is not null and "mail_scan_views"."staff_member_id" is null
        else false
      end)
);
--> statement-breakpoint
CREATE TABLE "mail_scans" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"mail_item_id" uuid NOT NULL,
	"side" "mail_scan_side" NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "mail_scans_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "mail_scans_storage_key_key" UNIQUE("storage_key"),
	CONSTRAINT "mail_scans_content_type_allowed" CHECK ("mail_scans"."content_type" in ('application/pdf', 'image/jpeg', 'image/png')),
	CONSTRAINT "mail_scans_byte_size_positive" CHECK ("mail_scans"."byte_size" > 0)
);
--> statement-breakpoint
ALTER TABLE "client_members" ADD CONSTRAINT "client_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_members" ADD CONSTRAINT "client_members_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_items" ADD CONSTRAINT "mail_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_items" ADD CONSTRAINT "mail_items_registered_by_staff_members_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_items" ADD CONSTRAINT "mail_items_opened_by_staff_members_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_items" ADD CONSTRAINT "mail_items_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_items" ADD CONSTRAINT "mail_items_requested_by_fk" FOREIGN KEY ("tenant_id","opening_requested_by") REFERENCES "public"."client_members"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_scan_views" ADD CONSTRAINT "mail_scan_views_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_scan_views" ADD CONSTRAINT "mail_scan_views_staff_member_id_staff_members_id_fk" FOREIGN KEY ("staff_member_id") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_scan_views" ADD CONSTRAINT "mail_scan_views_scan_fk" FOREIGN KEY ("tenant_id","mail_scan_id") REFERENCES "public"."mail_scans"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_scan_views" ADD CONSTRAINT "mail_scan_views_client_member_fk" FOREIGN KEY ("tenant_id","client_member_id") REFERENCES "public"."client_members"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_scans" ADD CONSTRAINT "mail_scans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_scans" ADD CONSTRAINT "mail_scans_uploaded_by_staff_members_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_scans" ADD CONSTRAINT "mail_scans_mail_item_fk" FOREIGN KEY ("tenant_id","mail_item_id") REFERENCES "public"."mail_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_members_client_email_key" ON "client_members" USING btree ("tenant_id","client_id","email") WHERE deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "client_members_client_auth_user_key" ON "client_members" USING btree ("client_id","auth_user_id") WHERE auth_user_id is not null and deleted_at is null;--> statement-breakpoint
CREATE INDEX "client_members_tenant_email_idx" ON "client_members" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "client_members_auth_user_idx" ON "client_members" USING btree ("auth_user_id");--> statement-breakpoint
CREATE INDEX "mail_items_client_received_idx" ON "mail_items" USING btree ("tenant_id","client_id","received_at");--> statement-breakpoint
CREATE INDEX "mail_items_tenant_received_idx" ON "mail_items" USING btree ("tenant_id","received_at");--> statement-breakpoint
CREATE INDEX "mail_items_requested_idx" ON "mail_items" USING btree ("tenant_id","opening_requested_at") WHERE status = 'opening_requested' and deleted_at is null;--> statement-breakpoint
CREATE INDEX "mail_items_opened_idx" ON "mail_items" USING btree ("tenant_id","opened_at") WHERE opened_at is not null;--> statement-breakpoint
CREATE INDEX "mail_scan_views_scan_idx" ON "mail_scan_views" USING btree ("tenant_id","mail_scan_id","viewed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_scans_item_side_key" ON "mail_scans" USING btree ("mail_item_id","side") WHERE deleted_at is null;