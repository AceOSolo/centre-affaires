-- Isolation par centre et horodatage de `staff_members`, dans les mêmes termes
-- que les migrations 0002, 0003 et 0006.
--
-- Cette table décide qui entre dans le back-office : la laisser hors RLS
-- reviendrait, le jour du multi-centres, à laisser l'équipe d'un centre se voir
-- — ou s'ajouter — dans un autre.
--
-- Les droits de `app_centre` n'ont pas à être redonnés : l'ALTER DEFAULT
-- PRIVILEGES de la migration 0004 couvre les tables créées ensuite par le
-- propriétaire.

CREATE TRIGGER staff_members_set_updated_at
BEFORE UPDATE ON staff_members
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

ALTER TABLE staff_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE staff_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_members_tenant_isolation ON staff_members
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
