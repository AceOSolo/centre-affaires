-- Isolation par centre et horodatage des tables de l'ADR 015, dans les mêmes
-- termes que les migrations 0003, 0006 et 0009. Le courrier est la donnée la
-- plus sensible du produit : une table oubliée ici exposerait les plis d'un
-- centre à un autre.
--
-- Les droits de `app_centre` viennent de l'ALTER DEFAULT PRIVILEGES de la
-- migration 0004 ; seul le journal d'accès les voit restreints, plus bas.

ALTER TABLE client_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE client_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY client_members_tenant_isolation ON client_members
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

--> statement-breakpoint

ALTER TABLE mail_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mail_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY mail_items_tenant_isolation ON mail_items
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

--> statement-breakpoint

ALTER TABLE mail_scans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mail_scans FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY mail_scans_tenant_isolation ON mail_scans
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

--> statement-breakpoint

-- Journal d'accès aux numérisations : on y ajoute, on y lit, rien d'autre.
-- Deux verrous plutôt qu'un. Les politiques ne couvrent que SELECT et INSERT,
-- donc un UPDATE ou un DELETE ne toucherait aucune ligne ; et le droit
-- lui-même est retiré, pour que la tentative échoue bruyamment au lieu de
-- passer pour une réussite.
ALTER TABLE mail_scan_views ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mail_scan_views FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY mail_scan_views_tenant_read ON mail_scan_views
  FOR SELECT
  USING (tenant_id = current_tenant_id());
--> statement-breakpoint
CREATE POLICY mail_scan_views_tenant_append ON mail_scan_views
  FOR INSERT
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON mail_scan_views FROM app_centre;

--> statement-breakpoint

CREATE TRIGGER client_members_set_updated_at
BEFORE UPDATE ON client_members
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

CREATE TRIGGER mail_items_set_updated_at
BEFORE UPDATE ON mail_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

CREATE TRIGGER mail_scans_set_updated_at
BEFORE UPDATE ON mail_scans
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
