-- Isolation par centre et horodatage des nouvelles tables, dans les mêmes
-- termes que les migrations 0002 et 0003. Toute table métier y passe : une
-- table oubliée serait lisible depuis n'importe quel centre.
--
-- Les droits de `app_centre` n'ont pas à être redonnés : l'ALTER DEFAULT
-- PRIVILEGES de la migration 0004 couvre les tables créées ensuite par le
-- propriétaire (migration 0005).

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY clients_tenant_isolation ON clients
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

--> statement-breakpoint

ALTER TABLE rate_plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE rate_plans FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY rate_plans_tenant_isolation ON rate_plans
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

--> statement-breakpoint

ALTER TABLE rate_plan_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE rate_plan_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY rate_plan_items_tenant_isolation ON rate_plan_items
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

--> statement-breakpoint

ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE contracts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY contracts_tenant_isolation ON contracts
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

--> statement-breakpoint

CREATE TRIGGER clients_set_updated_at
BEFORE UPDATE ON clients
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

CREATE TRIGGER rate_plans_set_updated_at
BEFORE UPDATE ON rate_plans
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

CREATE TRIGGER rate_plan_items_set_updated_at
BEFORE UPDATE ON rate_plan_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

CREATE TRIGGER contracts_set_updated_at
BEFORE UPDATE ON contracts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
