-- Journal des relances (R16, ADR 034) : isolation, droits et garde, que
-- Drizzle ne sait pas décrire.
--
-- Mêmes règles que les migrations 0020 et 0031 : ENABLE et FORCE ROW LEVEL
-- SECURITY, isolation par centre, réservé au back-office. Une relance est une
-- preuve : le rôle applicatif n'a plus que la lecture et l'insertion
-- (décision 6).

ALTER TABLE invoice_reminders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoice_reminders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invoice_reminders_tenant_isolation ON invoice_reminders
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
CREATE POLICY invoice_reminders_back_office_only ON invoice_reminders AS RESTRICTIVE
  USING (current_client_ids() IS NULL)
  WITH CHECK (current_client_ids() IS NULL);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON invoice_reminders FROM app_centre;
--> statement-breakpoint

-- Une relance porte sur une facture émise (pas un brouillon, pas un avoir) :
-- refus CA003, comme une facture non conforme.
CREATE FUNCTION invoice_reminders_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM invoices
     WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id
       AND kind = 'invoice' AND status <> 'draft' AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Une relance porte sur une facture émise, pas sur un brouillon ni un avoir.'
      USING ERRCODE = 'CA003';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_reminders_guard
BEFORE INSERT ON invoice_reminders
FOR EACH ROW EXECUTE FUNCTION invoice_reminders_guard();
