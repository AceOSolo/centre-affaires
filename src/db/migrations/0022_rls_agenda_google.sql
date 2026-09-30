-- Isolation par centre et horodatage des tables Google Agenda, dans les mêmes
-- termes que les migrations 0003, 0006 et 0009 (ADR 014).
--
-- `google_calendar_connections` porte le jeton qui ouvre les agendas Google
-- d'un centre : le jour du multi-centres, un centre ne doit ni le lire ni
-- écrire avec celui d'un autre, ni dans les agendas des ressources d'un autre.
--
-- Les droits de `app_centre` n'ont pas à être redonnés : l'ALTER DEFAULT
-- PRIVILEGES de la migration 0004 couvre les tables créées ensuite par le
-- propriétaire.

CREATE TRIGGER google_calendar_connections_set_updated_at
BEFORE UPDATE ON google_calendar_connections
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER resource_google_calendars_set_updated_at
BEFORE UPDATE ON resource_google_calendars
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

ALTER TABLE google_calendar_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE google_calendar_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY google_calendar_connections_tenant_isolation ON google_calendar_connections
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

--> statement-breakpoint

ALTER TABLE resource_google_calendars ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE resource_google_calendars FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY resource_google_calendars_tenant_isolation ON resource_google_calendars
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
