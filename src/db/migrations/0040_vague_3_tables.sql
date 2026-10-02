-- Ordre retouché à la main avant toute application : les cibles uniques
-- ajoutées à des tables existantes passent avant les clés étrangères qui
-- les visent (Drizzle les émet en fin de fichier).
CREATE TYPE "public"."client_booking_mode" AS ENUM('instant', 'approval', 'closed');--> statement-breakpoint
CREATE TYPE "public"."mail_request_kind" AS ENUM('open_and_scan', 'scan', 'forward');--> statement-breakpoint
CREATE TYPE "public"."mail_request_status" AS ENUM('requested', 'in_progress', 'done', 'refused', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."notification_audience" AS ENUM('client', 'centre');--> statement-breakpoint
CREATE TYPE "public"."notification_category" AS ENUM('mail', 'bookings', 'invoices', 'contracts', 'inspections');--> statement-breakpoint
CREATE TYPE "public"."notification_delivery_status" AS ENUM('sent', 'failed', 'not_configured', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."notification_event" AS ENUM('mail_received', 'mail_scanned', 'mail_request_submitted', 'mail_request_done', 'mail_request_refused', 'booking_request_submitted', 'booking_request_accepted', 'booking_request_refused', 'booking_confirmed', 'booking_cancelled', 'invoice_issued', 'invoice_reminder', 'contract_activated', 'inspection_to_sign', 'inspection_signed', 'member_invited', 'offer_requested');--> statement-breakpoint
CREATE TYPE "public"."notification_related_type" AS ENUM('mail_item', 'mail_request', 'booking', 'invoice', 'contract', 'inspection', 'client_member', 'offer');--> statement-breakpoint
CREATE TYPE "public"."inspection_kind" AS ENUM('entry', 'exit');--> statement-breakpoint
CREATE TYPE "public"."inspection_status" AS ENUM('draft', 'closed');--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_client_key" UNIQUE("tenant_id","id","client_id");--> statement-breakpoint
ALTER TABLE "client_members" ADD CONSTRAINT "client_members_tenant_client_id_key" UNIQUE("tenant_id","client_id","id");--> statement-breakpoint
ALTER TABLE "mail_items" ADD CONSTRAINT "mail_items_tenant_id_client_key" UNIQUE("tenant_id","id","client_id");--> statement-breakpoint
CREATE TABLE "mail_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"mail_item_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" "mail_request_kind" NOT NULL,
	"status" "mail_request_status" DEFAULT 'requested' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by_member_id" uuid,
	"requested_by_staff_id" uuid,
	"client_note" text,
	"forward_recipient" text,
	"forward_address_line1" text,
	"forward_address_line2" text,
	"forward_postal_code" text,
	"forward_city" text,
	"forward_country" char(2),
	"forward_tracking_number" text,
	"postage_cents" integer,
	"postage_currency" char(3),
	"started_at" timestamp with time zone,
	"started_by_staff_id" uuid,
	"completed_at" timestamp with time zone,
	"completed_by_staff_id" uuid,
	"refused_at" timestamp with time zone,
	"refused_by_staff_id" uuid,
	"refusal_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_member_id" uuid,
	"cancelled_by_staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_requests_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "mail_requests_tenant_id_item_key" UNIQUE("tenant_id","id","mail_item_id"),
	CONSTRAINT "mail_requests_one_author" CHECK (num_nonnulls("mail_requests"."requested_by_member_id", "mail_requests"."requested_by_staff_id") = 1),
	CONSTRAINT "mail_requests_opening_by_client" CHECK ("mail_requests"."kind" <> 'open_and_scan' or "mail_requests"."requested_by_member_id" is not null),
	CONSTRAINT "mail_requests_forward_address" CHECK (case when "mail_requests"."kind" = 'forward'
        then num_nulls("mail_requests"."forward_recipient", "mail_requests"."forward_address_line1", "mail_requests"."forward_postal_code", "mail_requests"."forward_city", "mail_requests"."forward_country") = 0
             and btrim("mail_requests"."forward_recipient") <> '' and btrim("mail_requests"."forward_address_line1") <> ''
             and btrim("mail_requests"."forward_postal_code") <> '' and btrim("mail_requests"."forward_city") <> ''
        else num_nonnulls("mail_requests"."forward_recipient", "mail_requests"."forward_address_line1", "mail_requests"."forward_address_line2", "mail_requests"."forward_postal_code", "mail_requests"."forward_city", "mail_requests"."forward_country", "mail_requests"."forward_tracking_number") = 0
      end),
	CONSTRAINT "mail_requests_postage_valid" CHECK (("mail_requests"."postage_cents" is null) = ("mail_requests"."postage_currency" is null) and ("mail_requests"."postage_cents" is null or ("mail_requests"."kind" = 'forward' and "mail_requests"."status" = 'done' and "mail_requests"."postage_cents" >= 0))),
	CONSTRAINT "mail_requests_status_consistent" CHECK (("mail_requests"."started_at" is null) = ("mail_requests"."started_by_staff_id" is null)
        and ("mail_requests"."completed_at" is null) = ("mail_requests"."completed_by_staff_id" is null)
        and ("mail_requests"."status" = 'done') = ("mail_requests"."completed_at" is not null)
        and ("mail_requests"."status" = 'refused') = ("mail_requests"."refused_at" is not null)
        and ("mail_requests"."refused_at" is null) = ("mail_requests"."refusal_reason" is null)
        and ("mail_requests"."refusal_reason" is null or btrim("mail_requests"."refusal_reason") <> '')
        and ("mail_requests"."refused_by_staff_id" is null or "mail_requests"."refused_at" is not null)
        and ("mail_requests"."status" = 'cancelled') = ("mail_requests"."cancelled_at" is not null)
        and (case when "mail_requests"."cancelled_at" is null
              then num_nonnulls("mail_requests"."cancelled_by_member_id", "mail_requests"."cancelled_by_staff_id") = 0
              else num_nonnulls("mail_requests"."cancelled_by_member_id", "mail_requests"."cancelled_by_staff_id") = 1 end)
        and ("mail_requests"."status" <> 'requested' or "mail_requests"."started_at" is null)
        and ("mail_requests"."status" <> 'in_progress' or "mail_requests"."started_at" is not null)
        and ("mail_requests"."status" <> 'cancelled' or "mail_requests"."started_at" is null))
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"event" "notification_event" NOT NULL,
	"audience" "notification_audience" NOT NULL,
	"client_id" uuid,
	"recipients" text[] DEFAULT '{}'::text[] NOT NULL,
	"failed_recipients" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text NOT NULL,
	"status" "notification_delivery_status" NOT NULL,
	"error" text,
	"related_type" "notification_related_type",
	"related_id" uuid,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_audience_matches" CHECK ("notification_deliveries"."audience"::text = notification_event_audience("notification_deliveries"."event"::text)),
	CONSTRAINT "notification_deliveries_client_audience" CHECK ("notification_deliveries"."audience" <> 'client' or "notification_deliveries"."client_id" is not null),
	CONSTRAINT "notification_deliveries_subject_not_blank" CHECK (btrim("notification_deliveries"."subject") <> ''),
	CONSTRAINT "notification_deliveries_status_consistent" CHECK ("notification_deliveries"."failed_recipients" <@ "notification_deliveries"."recipients"
        and case "notification_deliveries"."status"
          when 'sent' then cardinality("notification_deliveries"."recipients") > 0 and cardinality("notification_deliveries"."failed_recipients") = 0
          when 'failed' then "notification_deliveries"."error" is not null and cardinality("notification_deliveries"."failed_recipients") > 0
          when 'not_configured' then cardinality("notification_deliveries"."failed_recipients") = 0
          when 'skipped' then "notification_deliveries"."error" is not null and cardinality("notification_deliveries"."failed_recipients") = 0
          else false
        end),
	CONSTRAINT "notification_deliveries_related_complete" CHECK (("notification_deliveries"."related_type" is null) = ("notification_deliveries"."related_id" is null))
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"client_id" uuid NOT NULL,
	"client_member_id" uuid NOT NULL,
	"category" "notification_category" NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"event" "notification_event" NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_templates_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "notification_templates_text_valid" CHECK (btrim("notification_templates"."subject") <> '' and length("notification_templates"."subject") <= 200 and btrim("notification_templates"."body") <> '' and length("notification_templates"."body") <= 10000)
);
--> statement-breakpoint
CREATE TABLE "inspection_photo_views" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"photo_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"viewer" text NOT NULL,
	"staff_member_id" uuid,
	"client_member_id" uuid,
	"auth_user_id" text NOT NULL,
	CONSTRAINT "inspection_photo_views_viewer_consistent" CHECK (case "inspection_photo_views"."viewer"
        when 'staff' then "inspection_photo_views"."staff_member_id" is not null and "inspection_photo_views"."client_member_id" is null
        when 'client' then "inspection_photo_views"."client_member_id" is not null and "inspection_photo_views"."staff_member_id" is null
        else false
      end)
);
--> statement-breakpoint
CREATE TABLE "inspection_photos" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"inspection_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"encryption_key_version" smallint NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"caption" text,
	"field_id" text,
	"position" smallint DEFAULT 0 NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "inspection_photos_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "inspection_photos_storage_key_key" UNIQUE("storage_key"),
	CONSTRAINT "inspection_photos_content_type_allowed" CHECK ("inspection_photos"."content_type" in ('image/jpeg', 'image/webp', 'image/png')),
	CONSTRAINT "inspection_photos_byte_size_valid" CHECK ("inspection_photos"."byte_size" between 1 and 10485760),
	CONSTRAINT "inspection_photos_dimensions_valid" CHECK ("inspection_photos"."width" between 1 and 10000 and "inspection_photos"."height" between 1 and 10000),
	CONSTRAINT "inspection_photos_encryption_key_version_positive" CHECK ("inspection_photos"."encryption_key_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "inspection_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"fields" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inspection_template_versions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "inspection_template_versions_version_positive" CHECK ("inspection_template_versions"."version" >= 1),
	CONSTRAINT "inspection_template_versions_fields_valid" CHECK (inspection_fields_error("inspection_template_versions"."fields") is null)
);
--> statement-breakpoint
CREATE TABLE "inspection_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"resource_type" "resource_type" NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "inspection_templates_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "inspection_templates_name_not_blank" CHECK (btrim("inspection_templates"."name") <> '')
);
--> statement-breakpoint
CREATE TABLE "inspections" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"tenant_id" uuid DEFAULT tenant_id_default() NOT NULL,
	"kind" "inspection_kind" NOT NULL,
	"status" "inspection_status" DEFAULT 'draft' NOT NULL,
	"resource_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"booking_id" uuid,
	"contract_id" uuid,
	"entry_inspection_id" uuid,
	"template_version_id" uuid NOT NULL,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observations" text,
	"created_by" uuid NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"signed_at" timestamp with time zone,
	"signed_by_member_id" uuid,
	"client_remarks" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "inspections_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "inspections_tenant_id_client_resource_key" UNIQUE("tenant_id","id","client_id","resource_id"),
	CONSTRAINT "inspections_occupation_given" CHECK (num_nonnulls("inspections"."booking_id", "inspections"."contract_id") >= 1),
	CONSTRAINT "inspections_entry_for_exit" CHECK ("inspections"."entry_inspection_id" is null or "inspections"."kind" = 'exit'),
	CONSTRAINT "inspections_values_object" CHECK (jsonb_typeof("inspections"."values") = 'object'),
	CONSTRAINT "inspections_status_consistent" CHECK (("inspections"."status" = 'closed') = ("inspections"."closed_at" is not null)
        and ("inspections"."closed_at" is null) = ("inspections"."closed_by" is null)
        and ("inspections"."signed_at" is null) = ("inspections"."signed_by_member_id" is null)
        and ("inspections"."signed_at" is null or "inspections"."status" = 'closed')
        and ("inspections"."client_remarks" is null or "inspections"."signed_at" is not null)
        and ("inspections"."deleted_at" is null or "inspections"."status" = 'draft'))
);
--> statement-breakpoint
DROP INDEX "mail_scans_item_side_key";--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "prospect_retention_months" integer DEFAULT 36 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "client_retention_months" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "removed_member_retention_months" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "notification_log_retention_months" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "inspection_photo_retention_months" integer DEFAULT 36 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "inspection_access_log_retention_months" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_members" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "client_booking_mode" "client_booking_mode" DEFAULT 'approval' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "booked_by_member_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "cancelled_by_member_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "cancelled_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "client_contacts" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_members" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "last_contact_on" date;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offer_items" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "client_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "mail_request_id" uuid;--> statement-breakpoint
ALTER TABLE "mail_items" ADD COLUMN "sender_anonymized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_scans" ADD COLUMN "mail_request_id" uuid;--> statement-breakpoint
ALTER TABLE "mail_requests" ADD CONSTRAINT "mail_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_requests" ADD CONSTRAINT "mail_requests_requested_by_staff_id_staff_members_id_fk" FOREIGN KEY ("requested_by_staff_id") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_requests" ADD CONSTRAINT "mail_requests_started_by_staff_id_staff_members_id_fk" FOREIGN KEY ("started_by_staff_id") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_requests" ADD CONSTRAINT "mail_requests_completed_by_staff_id_staff_members_id_fk" FOREIGN KEY ("completed_by_staff_id") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_requests" ADD CONSTRAINT "mail_requests_refused_by_staff_id_staff_members_id_fk" FOREIGN KEY ("refused_by_staff_id") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_requests" ADD CONSTRAINT "mail_requests_cancelled_by_staff_id_staff_members_id_fk" FOREIGN KEY ("cancelled_by_staff_id") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_requests" ADD CONSTRAINT "mail_requests_mail_item_fk" FOREIGN KEY ("tenant_id","mail_item_id","client_id") REFERENCES "public"."mail_items"("tenant_id","id","client_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_requests" ADD CONSTRAINT "mail_requests_requested_by_member_fk" FOREIGN KEY ("tenant_id","client_id","requested_by_member_id") REFERENCES "public"."client_members"("tenant_id","client_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_requests" ADD CONSTRAINT "mail_requests_cancelled_by_member_fk" FOREIGN KEY ("tenant_id","client_id","cancelled_by_member_id") REFERENCES "public"."client_members"("tenant_id","client_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_member_fk" FOREIGN KEY ("tenant_id","client_id","client_member_id") REFERENCES "public"."client_members"("tenant_id","client_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_updated_by_staff_members_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_photo_views" ADD CONSTRAINT "inspection_photo_views_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_photo_views" ADD CONSTRAINT "inspection_photo_views_staff_member_id_staff_members_id_fk" FOREIGN KEY ("staff_member_id") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_photo_views" ADD CONSTRAINT "inspection_photo_views_photo_fk" FOREIGN KEY ("tenant_id","photo_id") REFERENCES "public"."inspection_photos"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_photo_views" ADD CONSTRAINT "inspection_photo_views_client_member_fk" FOREIGN KEY ("tenant_id","client_member_id") REFERENCES "public"."client_members"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_photos" ADD CONSTRAINT "inspection_photos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_photos" ADD CONSTRAINT "inspection_photos_uploaded_by_staff_members_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_photos" ADD CONSTRAINT "inspection_photos_inspection_fk" FOREIGN KEY ("tenant_id","inspection_id") REFERENCES "public"."inspections"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_template_versions" ADD CONSTRAINT "inspection_template_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_template_versions" ADD CONSTRAINT "inspection_template_versions_created_by_staff_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_template_versions" ADD CONSTRAINT "inspection_template_versions_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."inspection_templates"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_templates" ADD CONSTRAINT "inspection_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_created_by_staff_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_closed_by_staff_members_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_resource_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."resources"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_booking_fk" FOREIGN KEY ("tenant_id","booking_id","client_id") REFERENCES "public"."bookings"("tenant_id","id","client_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_contract_fk" FOREIGN KEY ("tenant_id","contract_id","client_id") REFERENCES "public"."contracts"("tenant_id","id","client_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_entry_fk" FOREIGN KEY ("tenant_id","entry_inspection_id","client_id","resource_id") REFERENCES "public"."inspections"("tenant_id","id","client_id","resource_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_template_version_fk" FOREIGN KEY ("tenant_id","template_version_id") REFERENCES "public"."inspection_template_versions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_signed_by_member_fk" FOREIGN KEY ("tenant_id","client_id","signed_by_member_id") REFERENCES "public"."client_members"("tenant_id","client_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_requests_pending_key" ON "mail_requests" USING btree ("tenant_id","mail_item_id","kind") WHERE status in ('requested', 'in_progress');--> statement-breakpoint
CREATE INDEX "mail_requests_item_idx" ON "mail_requests" USING btree ("tenant_id","mail_item_id","requested_at");--> statement-breakpoint
CREATE INDEX "mail_requests_client_idx" ON "mail_requests" USING btree ("tenant_id","client_id","requested_at");--> statement-breakpoint
CREATE INDEX "mail_requests_queue_idx" ON "mail_requests" USING btree ("tenant_id","requested_at") WHERE status in ('requested', 'in_progress');--> statement-breakpoint
CREATE INDEX "mail_requests_done_idx" ON "mail_requests" USING btree ("tenant_id","completed_at") WHERE status = 'done' and kind in ('scan', 'forward');--> statement-breakpoint
CREATE INDEX "notification_deliveries_sent_idx" ON "notification_deliveries" USING btree ("tenant_id","sent_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_client_idx" ON "notification_deliveries" USING btree ("tenant_id","client_id","sent_at") WHERE client_id is not null;--> statement-breakpoint
CREATE INDEX "notification_deliveries_related_idx" ON "notification_deliveries" USING btree ("tenant_id","related_type","related_id") WHERE related_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_member_category_key" ON "notification_preferences" USING btree ("tenant_id","client_member_id","category");--> statement-breakpoint
CREATE INDEX "notification_preferences_client_idx" ON "notification_preferences" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_templates_event_key" ON "notification_templates" USING btree ("tenant_id","event");--> statement-breakpoint
CREATE INDEX "inspection_photo_views_photo_idx" ON "inspection_photo_views" USING btree ("tenant_id","photo_id","viewed_at");--> statement-breakpoint
CREATE INDEX "inspection_photos_inspection_idx" ON "inspection_photos" USING btree ("tenant_id","inspection_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "inspection_template_versions_version_key" ON "inspection_template_versions" USING btree ("tenant_id","template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "inspection_templates_type_key" ON "inspection_templates" USING btree ("tenant_id","resource_type") WHERE deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "inspections_exit_per_entry_key" ON "inspections" USING btree ("tenant_id","entry_inspection_id") WHERE entry_inspection_id is not null and deleted_at is null;--> statement-breakpoint
CREATE INDEX "inspections_client_idx" ON "inspections" USING btree ("tenant_id","client_id","performed_at");--> statement-breakpoint
CREATE INDEX "inspections_resource_idx" ON "inspections" USING btree ("tenant_id","resource_id","performed_at");--> statement-breakpoint
CREATE INDEX "inspections_booking_idx" ON "inspections" USING btree ("tenant_id","booking_id") WHERE booking_id is not null;--> statement-breakpoint
CREATE INDEX "inspections_contract_idx" ON "inspections" USING btree ("tenant_id","contract_id") WHERE contract_id is not null;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_by_staff_id_staff_members_id_fk" FOREIGN KEY ("cancelled_by_staff_id") REFERENCES "public"."staff_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_booked_by_member_fk" FOREIGN KEY ("tenant_id","client_id","booked_by_member_id") REFERENCES "public"."client_members"("tenant_id","client_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_by_member_fk" FOREIGN KEY ("tenant_id","client_id","cancelled_by_member_id") REFERENCES "public"."client_members"("tenant_id","client_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_mail_request_fk" FOREIGN KEY ("tenant_id","mail_request_id") REFERENCES "public"."mail_requests"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_scans" ADD CONSTRAINT "mail_scans_mail_request_fk" FOREIGN KEY ("tenant_id","mail_request_id","mail_item_id") REFERENCES "public"."mail_requests"("tenant_id","id","mail_item_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_mail_request_key" ON "invoice_lines" USING btree ("tenant_id","mail_request_id","kind") WHERE mail_request_id is not null and deleted_at is null and released_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_scans_item_side_key" ON "mail_scans" USING btree ("mail_item_id","side",coalesce(mail_request_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE deleted_at is null;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_anonymization_retention_valid" CHECK ("tenants"."prospect_retention_months" between 1 and 120 and "tenants"."client_retention_months" between 1 and 120 and "tenants"."removed_member_retention_months" between 1 and 120);--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_notification_retention_valid" CHECK ("tenants"."notification_log_retention_months" between 1 and 120);--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_inspection_retention_valid" CHECK ("tenants"."inspection_photo_retention_months" between 1 and 120 and "tenants"."inspection_access_log_retention_months" between 1 and 120);--> statement-breakpoint
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_anonymized_removed" CHECK ("staff_members"."anonymized_at" is null or ("staff_members"."deleted_at" is not null and "staff_members"."auth_user_id" is null));--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_booked_by_member_consistent" CHECK ("bookings"."booked_by_member_id" is null or ("bookings"."channel" = 'client' and "bookings"."kind" = 'booking' and "bookings"."client_id" is not null));--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_by_consistent" CHECK (num_nonnulls("bookings"."cancelled_by_member_id", "bookings"."cancelled_by_staff_id") = 0 or ("bookings"."status" = 'cancelled' and num_nonnulls("bookings"."cancelled_by_member_id", "bookings"."cancelled_by_staff_id") = 1 and ("bookings"."cancelled_by_member_id" is null or "bookings"."client_id" is not null)));--> statement-breakpoint
ALTER TABLE "client_contacts" ADD CONSTRAINT "client_contacts_anonymized_archived" CHECK ("client_contacts"."anonymized_at" is null or "client_contacts"."deleted_at" is not null);--> statement-breakpoint
ALTER TABLE "client_members" ADD CONSTRAINT "client_members_anonymized_removed" CHECK ("client_members"."anonymized_at" is null or ("client_members"."deleted_at" is not null and "client_members"."auth_user_id" is null));--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_anonymized_archived" CHECK ("clients"."anonymized_at" is null or "clients"."deleted_at" is not null);--> statement-breakpoint
ALTER TABLE "offer_items" ADD CONSTRAINT "offer_items_label_not_blank" CHECK ("offer_items"."label" is null or btrim("offer_items"."label") <> '');--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_one_mail_source" CHECK (num_nonnulls("invoice_lines"."mail_item_id", "invoice_lines"."mail_request_id") <= 1);--> statement-breakpoint
ALTER TABLE "mail_items" ADD CONSTRAINT "mail_items_sender_anonymized" CHECK ("mail_items"."sender_anonymized_at" is null or ("mail_items"."sender" is null and "mail_items"."note" is null));--> statement-breakpoint
ALTER TABLE "mail_scans" ADD CONSTRAINT "mail_scans_request_content_only" CHECK ("mail_scans"."mail_request_id" is null or "mail_scans"."side" = 'content');