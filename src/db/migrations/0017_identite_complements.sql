ALTER TABLE "tenants" ADD COLUMN "logo_light_path" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "social_links" jsonb DEFAULT '[]'::jsonb NOT NULL;