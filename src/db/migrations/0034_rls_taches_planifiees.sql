-- Tâches planifiées de la vague 2 (ADR 033) : isolation et droits du journal
-- des reconductions tacites, que Drizzle ne sait pas décrire.
--
-- Mêmes règles que les migrations 0020 et 0031 : ENABLE et FORCE ROW LEVEL
-- SECURITY, isolation par centre, réservé au back-office (une session client
-- n'y lit rien). Le journal ne perd ni ne réécrit jamais une ligne : le rôle
-- applicatif n'a plus que la lecture et l'insertion (décision 6).
--
-- `invoice_runs.created_by` nul (migration 0033) : un lot lancé par la tâche
-- planifiée du serveur, sans membre de l'équipe.

ALTER TABLE contract_renewals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE contract_renewals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY contract_renewals_tenant_isolation ON contract_renewals
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
CREATE POLICY contract_renewals_back_office_only ON contract_renewals AS RESTRICTIVE
  USING (current_client_ids() IS NULL)
  WITH CHECK (current_client_ids() IS NULL);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON contract_renewals FROM app_centre;
