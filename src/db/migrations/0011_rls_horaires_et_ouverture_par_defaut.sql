-- Isolation par centre des deux nouvelles tables, dans les mêmes termes que les
-- migrations 0003 et 0006. Un test vérifie qu'aucune table publique n'y échappe.

ALTER TABLE opening_hours ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE opening_hours FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY opening_hours_tenant_isolation ON opening_hours
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

--> statement-breakpoint

ALTER TABLE closures ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE closures FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY closures_tenant_isolation ON closures
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

--> statement-breakpoint

CREATE TRIGGER opening_hours_set_updated_at
BEFORE UPDATE ON opening_hours
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

CREATE TRIGGER closures_set_updated_at
BEFORE UPDATE ON closures
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

-- Horaires de départ : 9h-18h du lundi au vendredi, pour tout le centre.
--
-- Sans une ligne, aucune ressource ne serait ouverte : le planning serait vide
-- et le site public afficherait « fermé » partout. Les poser ici plutôt que de
-- prévoir un repli dans le code : un repli masquerait une configuration
-- oubliée, alors que ces lignes sont visibles et modifiables à l'écran.
--
-- Jusqu'ici l'application supposait 7h-20h sept jours sur sept, ce qui faisait
-- proposer des créneaux le dimanche matin sur le site public.
INSERT INTO opening_hours (tenant_id, resource_id, weekday, opens_at, closes_at)
SELECT t.id, NULL, d.weekday, TIME '09:00', TIME '18:00'
FROM tenants t
CROSS JOIN (VALUES (1), (2), (3), (4), (5)) AS d(weekday)
ON CONFLICT DO NOTHING;
