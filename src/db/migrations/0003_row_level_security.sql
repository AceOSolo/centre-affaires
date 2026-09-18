-- Isolation par centre au niveau base (décision 1). Active dès le mono-centre :
-- l'ouverture au multi-centres ne demandera pas de reprise des tables.
--
-- FORCE : sans elle, le propriétaire des tables — c'est-à-dire le rôle applicatif
-- sur Neon comme en local — échappe silencieusement aux politiques.
--
-- Les politiques comparent à `current_tenant_id()`, qui renvoie NULL tant que
-- `app.tenant_id` n'est pas positionné : sans contexte, aucune ligne ne passe.
-- Voir `withTenant()` dans src/db/index.ts.

ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE resources FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY resources_tenant_isolation ON resources
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

--> statement-breakpoint

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY bookings_tenant_isolation ON bookings
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

--> statement-breakpoint

-- `tenants` est la table de référencement des centres, pas une table métier :
-- chaque centre ne voit que sa propre ligne.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenants_self_only ON tenants
  USING (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());
