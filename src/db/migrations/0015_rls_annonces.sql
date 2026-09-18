-- Isolation par centre de la table des annonces, dans les mêmes termes que les
-- migrations 0003, 0006 et 0011.
--
-- Les annonces sont lues par le site public, donc sans session : la lecture
-- passe par le rôle applicatif avec le centre du contexte, comme le reste. Rien
-- n'est ouvert à un rôle anonyme — le site public est rendu côté serveur.

ALTER TABLE listings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE listings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY listings_tenant_isolation ON listings
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

--> statement-breakpoint

CREATE TRIGGER listings_set_updated_at
BEFORE UPDATE ON listings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
