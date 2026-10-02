-- Vague 2, monétisation (ADR 023 à 027) : ce que Drizzle ne sait pas décrire.
-- Isolation par centre et par client des nouvelles tables, droits du rôle
-- applicatif, contraintes d'exclusion contre la double facturation, contrats
-- versionnés et occupation par segments, factures figées à l'émission,
-- paiements et statut déduit, plan de comptes par centre.
--
-- Mêmes règles que les migrations 0003, 0020 et 0026 : toute table métier en
-- ENABLE et FORCE ROW LEVEL SECURITY, les fonctions SECURITY DEFINER filtrent
-- elles-mêmes sur le centre et figent leur `search_path`. Les autres fonctions
-- s'exécutent sous le rôle appelant, donc sous ses politiques.
--
-- Codes d'erreur propres (src/db/errors.ts) :
--   CA002  facture émise ou brouillon abandonné : figé ;
--   CA003  facture non conforme : émission, avoir ou ligne refusés ;
--   CA004  engagement figé : contrat engagé, avenant signé, souscription,
--          document de contrat ;
--   CA005  avenant refusé : contrat qui n'est pas en cours, date d'effet ;
--   CA006  paiement refusé ;
--   CA007  mandat SEPA : RUM et client figés.

-- ---------------------------------------------------------------------------
-- 1. Isolation par centre et horodatage
-- ---------------------------------------------------------------------------
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE services FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY services_tenant_isolation ON services
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
ALTER TABLE offers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE offers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY offers_tenant_isolation ON offers
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
ALTER TABLE offer_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE offer_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY offer_items_tenant_isolation ON offer_items
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
ALTER TABLE subscribed_services ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subscribed_services FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY subscribed_services_tenant_isolation ON subscribed_services
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
ALTER TABLE contract_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE contract_lines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY contract_lines_tenant_isolation ON contract_lines
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
ALTER TABLE contract_amendments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE contract_amendments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY contract_amendments_tenant_isolation ON contract_amendments
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
ALTER TABLE contract_documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE contract_documents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY contract_documents_tenant_isolation ON contract_documents
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
ALTER TABLE invoice_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoice_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invoice_runs_tenant_isolation ON invoice_runs
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invoices_tenant_isolation ON invoices
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invoice_lines_tenant_isolation ON invoice_lines
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payments_tenant_isolation ON payments
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
ALTER TABLE sepa_mandates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sepa_mandates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sepa_mandates_tenant_isolation ON sepa_mandates
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
ALTER TABLE accounting_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE accounting_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY accounting_accounts_tenant_isolation ON accounting_accounts
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
ALTER TABLE accounting_exports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE accounting_exports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY accounting_exports_tenant_isolation ON accounting_exports
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

--> statement-breakpoint

CREATE TRIGGER services_set_updated_at BEFORE UPDATE ON services
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER offers_set_updated_at BEFORE UPDATE ON offers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER offer_items_set_updated_at BEFORE UPDATE ON offer_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER subscribed_services_set_updated_at BEFORE UPDATE ON subscribed_services
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER contract_lines_set_updated_at BEFORE UPDATE ON contract_lines
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER contract_amendments_set_updated_at BEFORE UPDATE ON contract_amendments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER invoice_runs_set_updated_at BEFORE UPDATE ON invoice_runs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER invoices_set_updated_at BEFORE UPDATE ON invoices
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER invoice_lines_set_updated_at BEFORE UPDATE ON invoice_lines
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER payments_set_updated_at BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER sepa_mandates_set_updated_at BEFORE UPDATE ON sepa_mandates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER accounting_accounts_set_updated_at BEFORE UPDATE ON accounting_accounts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Isolation des clients entre eux (ADR 019)
-- ---------------------------------------------------------------------------
-- Politiques RESTRICTIVE, en ET avec l'isolation par centre. Sans portée (le
-- back-office) rien ne change ; sous portée client, seules les lignes des
-- entreprises de la portée passent.

CREATE POLICY subscribed_services_client_scope ON subscribed_services AS RESTRICTIVE
  USING (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()))
  WITH CHECK (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()));
--> statement-breakpoint
CREATE POLICY sepa_mandates_client_scope ON sepa_mandates AS RESTRICTIVE
  USING (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()))
  WITH CHECK (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()));
--> statement-breakpoint
-- Un client ne voit jamais un brouillon : seules ses factures et avoirs émis
-- remontent dans son espace (R17), même pour une requête sans filtre.
CREATE POLICY invoices_client_scope ON invoices AS RESTRICTIVE
  USING (
    current_client_ids() IS NULL
    OR (client_id = ANY (current_client_ids()) AND status <> 'draft' AND deleted_at IS NULL)
  )
  WITH CHECK (
    current_client_ids() IS NULL
    OR (client_id = ANY (current_client_ids()) AND status <> 'draft' AND deleted_at IS NULL)
  );
--> statement-breakpoint
-- Les lignes et les paiements suivent leur facture ; la sous-requête est
-- elle-même soumise aux politiques de `invoices`.
CREATE POLICY invoice_lines_client_scope ON invoice_lines AS RESTRICTIVE
  USING (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM invoices AS i
       WHERE i.tenant_id = invoice_lines.tenant_id
         AND i.id = invoice_lines.invoice_id
         AND i.client_id = ANY (current_client_ids())
    )
  )
  WITH CHECK (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM invoices AS i
       WHERE i.tenant_id = invoice_lines.tenant_id
         AND i.id = invoice_lines.invoice_id
         AND i.client_id = ANY (current_client_ids())
    )
  );
--> statement-breakpoint
CREATE POLICY payments_client_scope ON payments AS RESTRICTIVE
  USING (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM invoices AS i
       WHERE i.tenant_id = payments.tenant_id
         AND i.id = payments.invoice_id
         AND i.client_id = ANY (current_client_ids())
    )
  )
  WITH CHECK (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM invoices AS i
       WHERE i.tenant_id = payments.tenant_id
         AND i.id = payments.invoice_id
         AND i.client_id = ANY (current_client_ids())
    )
  );
--> statement-breakpoint
-- Lignes, avenants et documents d'un contrat : par le contrat.
CREATE POLICY contract_lines_client_scope ON contract_lines AS RESTRICTIVE
  USING (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM contracts AS k
       WHERE k.tenant_id = contract_lines.tenant_id
         AND k.id = contract_lines.contract_id
         AND k.client_id = ANY (current_client_ids())
    )
  )
  WITH CHECK (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM contracts AS k
       WHERE k.tenant_id = contract_lines.tenant_id
         AND k.id = contract_lines.contract_id
         AND k.client_id = ANY (current_client_ids())
    )
  );
--> statement-breakpoint
CREATE POLICY contract_amendments_client_scope ON contract_amendments AS RESTRICTIVE
  USING (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM contracts AS k
       WHERE k.tenant_id = contract_amendments.tenant_id
         AND k.id = contract_amendments.contract_id
         AND k.client_id = ANY (current_client_ids())
    )
  )
  WITH CHECK (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM contracts AS k
       WHERE k.tenant_id = contract_amendments.tenant_id
         AND k.id = contract_amendments.contract_id
         AND k.client_id = ANY (current_client_ids())
    )
  );
--> statement-breakpoint
CREATE POLICY contract_documents_client_scope ON contract_documents AS RESTRICTIVE
  USING (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM contracts AS k
       WHERE k.tenant_id = contract_documents.tenant_id
         AND k.id = contract_documents.contract_id
         AND k.client_id = ANY (current_client_ids())
    )
  )
  WITH CHECK (
    current_client_ids() IS NULL OR EXISTS (
      SELECT 1 FROM contracts AS k
       WHERE k.tenant_id = contract_documents.tenant_id
         AND k.id = contract_documents.contract_id
         AND k.client_id = ANY (current_client_ids())
    )
  );
--> statement-breakpoint
-- Tables du seul back-office : invisibles depuis un espace client. Le bilan
-- d'un lot nomme des clients ; les comptes et les exports ne regardent que
-- le centre.
CREATE POLICY invoice_runs_back_office_only ON invoice_runs AS RESTRICTIVE
  USING (current_client_ids() IS NULL)
  WITH CHECK (current_client_ids() IS NULL);
--> statement-breakpoint
CREATE POLICY accounting_accounts_back_office_only ON accounting_accounts AS RESTRICTIVE
  USING (current_client_ids() IS NULL)
  WITH CHECK (current_client_ids() IS NULL);
--> statement-breakpoint
CREATE POLICY accounting_exports_back_office_only ON accounting_exports AS RESTRICTIVE
  USING (current_client_ids() IS NULL)
  WITH CHECK (current_client_ids() IS NULL);

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Droits du rôle applicatif : pas de suppression physique (décision 6)
-- ---------------------------------------------------------------------------
-- Les tables métier de la vague ne perdent jamais une ligne : archivage par
-- `deleted_at`, annulation d'un paiement, avoir. Retirer le droit fait échouer
-- bruyamment une tentative (42501). Le journal des exports et les documents de
-- contrat ne se modifient pas non plus. `accounting_accounts` est un
-- paramétrage, il se corrige en place.
REVOKE DELETE, TRUNCATE ON services, offers, offer_items, subscribed_services,
  contract_lines, contract_amendments, invoice_runs, invoices, invoice_lines,
  payments, sepa_mandates FROM app_centre;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON contract_documents, accounting_exports FROM app_centre;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Une source n'est facturée qu'une fois, hors avoir (R13, R15, ADR 026)
-- ---------------------------------------------------------------------------
-- Une réservation et un pli : index uniques partiels de la migration 0030.
-- Une ligne de contrat (ou le loyer d'un contrat sans ligne) et une
-- souscription : pas deux lignes qui tiennent la source sur des jours qui se
-- recouvrent. Une ligne retirée d'un brouillon, ou libérée par un avoir
-- (`released_at`), ne tient plus rien.
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_contract_period_no_overlap
EXCLUDE USING gist (
  tenant_id WITH =,
  contract_id WITH =,
  (coalesce(contract_line_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
  daterange(period_start, period_end, '[]') WITH &&
) WHERE (
  kind IN ('rent', 'package')
  AND contract_id IS NOT NULL
  AND subscribed_service_id IS NULL
  AND period_start IS NOT NULL
  AND deleted_at IS NULL
  AND released_at IS NULL
);
--> statement-breakpoint
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_subscription_period_no_overlap
EXCLUDE USING gist (
  tenant_id WITH =,
  subscribed_service_id WITH =,
  daterange(period_start, period_end, '[]') WITH &&
) WHERE (
  kind = 'package'
  AND subscribed_service_id IS NOT NULL
  AND period_start IS NOT NULL
  AND deleted_at IS NULL
  AND released_at IS NULL
);
--> statement-breakpoint
-- Un client ne souscrit pas deux fois le même service, pour le même contrat,
-- sur des périodes qui se recouvrent (R18) : la seconde serait facturée en
-- double. Deux unités s'expriment par la quantité.
ALTER TABLE subscribed_services ADD CONSTRAINT subscribed_services_no_overlap
EXCLUDE USING gist (
  tenant_id WITH =,
  client_id WITH =,
  service_id WITH =,
  (coalesce(contract_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
  daterange(starts_on, ends_on, '[]') WITH &&
) WHERE (deleted_at IS NULL);

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Statut de paiement déduit (R16, ADR 026)
-- ---------------------------------------------------------------------------
-- Hors brouillon, le statut d'une facture est une fonction de ses montants :
-- jamais écrit par le code, vérifié par une contrainte.
--
--   annulée         avoirs émis ≥ total TTC (total > 0)
--   payée           total − avoirs − paiements ≤ 0 (une facture à 0 € l'est)
--   part. payée     reste dû et paiements > 0
--   émise           sinon
--
-- Un avoir n'a que `issued` : il ne se paie pas, il réduit sa facture.
CREATE FUNCTION invoice_payment_status(
  p_kind invoice_kind,
  p_total_cents integer,
  p_paid_cents integer,
  p_credited_cents integer
) RETURNS invoice_status
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (CASE
    WHEN p_kind = 'credit_note' THEN 'issued'
    WHEN p_total_cents > 0 AND p_credited_cents >= p_total_cents THEN 'cancelled'
    WHEN p_total_cents - p_credited_cents - p_paid_cents <= 0 THEN 'paid'
    WHEN p_paid_cents > 0 THEN 'partially_paid'
    ELSE 'issued'
  END)::invoice_status
$$;
--> statement-breakpoint
ALTER TABLE invoices ADD CONSTRAINT invoices_status_derived CHECK (
  status = 'draft'
  OR status = invoice_payment_status(kind, total_incl_tax_cents, paid_cents, credited_cents)
);

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Montants d'une facture tenus par la base (EN 16931)
-- ---------------------------------------------------------------------------
-- Recalcule la TVA des lignes et les totaux d'un brouillon. La TVA se calcule
-- par catégorie et par taux sur la somme des bases (BR-CO-17), puis se répartit
-- sur les lignes : chacune reçoit sa TVA arrondie, et l'écart d'arrondi du taux
-- va à la ligne de plus forte valeur absolue (puis la première par position).
-- La somme des TVA des lignes égale donc exactement la TVA de la ventilation.
--
-- Sans effet sur une facture émise ou un brouillon abandonné. Pose
-- `app.invoice_amounts_sync` le temps de ses écritures : les gardes laissent
-- alors passer la TVA calculée ici.
CREATE FUNCTION invoice_refresh_amounts(p_invoice_id uuid) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status invoice_status;
  v_deleted_at timestamptz;
BEGIN
  SELECT status, deleted_at INTO v_status, v_deleted_at FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND OR v_status <> 'draft' OR v_deleted_at IS NOT NULL THEN
    RETURN;
  END IF;

  PERFORM set_config('app.invoice_amounts_sync', 'on', true);

  WITH lines AS (
    SELECT l.id,
           l.net_amount_cents AS net,
           l.vat_rate_bp AS rate,
           l.vat_category AS category,
           vat_amount_cents(l.net_amount_cents, l.vat_rate_bp) AS line_vat,
           row_number() OVER (
             PARTITION BY l.vat_category, l.vat_rate_bp
             ORDER BY abs(l.net_amount_cents) DESC, l.position, l.id
           ) AS rank
      FROM invoice_lines AS l
     WHERE l.invoice_id = p_invoice_id AND l.deleted_at IS NULL
  ), groups AS (
    SELECT category, rate, vat_amount_cents(sum(net), rate) - sum(line_vat) AS gap
      FROM lines
     GROUP BY category, rate
  ), target AS (
    SELECT lines.id,
           lines.net,
           (lines.line_vat + CASE WHEN lines.rank = 1 THEN groups.gap ELSE 0 END)::integer AS vat
      FROM lines JOIN groups USING (category, rate)
  )
  UPDATE invoice_lines AS l
     SET vat_amount_cents = target.vat,
         total_amount_cents = target.net + target.vat
    FROM target
   WHERE l.id = target.id
     AND (l.vat_amount_cents <> target.vat OR l.total_amount_cents <> target.net + target.vat);

  UPDATE invoices AS i
     SET total_excl_tax_cents = sums.excl,
         total_tax_cents = sums.tax,
         total_incl_tax_cents = sums.excl + sums.tax
    FROM (
      SELECT coalesce(sum(net_amount_cents), 0)::integer AS excl,
             coalesce(sum(vat_amount_cents), 0)::integer AS tax
        FROM invoice_lines
       WHERE invoice_id = p_invoice_id AND deleted_at IS NULL
    ) AS sums
   WHERE i.id = p_invoice_id
     AND (i.total_excl_tax_cents, i.total_tax_cents) IS DISTINCT FROM (sums.excl, sums.tax);

  PERFORM set_config('app.invoice_amounts_sync', '', true);
END
$$;

--> statement-breakpoint

-- Garde des lignes de facture, avant chaque écriture :
--
-- - une ligne ne se supprime pas (décision 6) ; d'un brouillon, elle se retire
--   par `deleted_at` ;
-- - une ligne d'une facture émise ne change plus (CA002), sauf la libération
--   de sa source par un avoir émis (`released_at`, posée par la base) ;
-- - dans un brouillon : une ligne d'avoir ne porte pas de source et ne crédite
--   qu'une ligne de la facture corrigée ; une ligne de facture porte la source
--   que sa nature exige, et cette source est celle du client facturé (CA003) ;
-- - un loyer ou un forfait de contrat vise un contrat engagé, et la version de
--   prix en vigueur sur toute sa période : ses lignes si elle en a, le contrat
--   seul sinon ; un forfait souscrit, une souscription qui couvre la période ;
--   un acte de courrier, un pli ouvert et non retiré (CA003) ;
-- - une ligne ponctuelle d'un contrat (`is_recurring` faux) prend pour période
--   le premier jour de sa version : facturée une fois, la contrainte
--   d'exclusion empêche de la refacturer ;
-- - TVA provisoire de la ligne et TTC, recalculés ensuite pour toute la
--   facture par `invoice_refresh_amounts`.
CREATE FUNCTION invoice_lines_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice invoices%ROWTYPE;
  v_net integer;
  v_recurring boolean;
  v_version_start date;
  v_version_amendment uuid;
  v_version_end date;
  v_client uuid;
  v_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Une ligne de facture ne se supprime pas : retirez-la d''un brouillon (deleted_at).'
      USING ERRCODE = 'CA002';
  END IF;

  SELECT * INTO v_invoice FROM invoices
   WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    -- La clé étrangère le dira, avec son propre code.
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND (NEW.invoice_id <> OLD.invoice_id OR NEW.tenant_id <> OLD.tenant_id) THEN
    RAISE EXCEPTION 'Une ligne ne change pas de facture.' USING ERRCODE = 'CA002';
  END IF;

  IF v_invoice.status <> 'draft' THEN
    IF TG_OP = 'UPDATE'
       AND coalesce(current_setting('app.invoice_settlement_sync', true), '') = 'on'
       AND to_jsonb(NEW) - '{released_at,updated_at,net_amount_cents}'::text[]
           = to_jsonb(OLD) - '{released_at,updated_at,net_amount_cents}'::text[] THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'La facture % est émise : ses lignes ne se modifient plus. Toute correction passe par un avoir.',
      v_invoice.number
      USING ERRCODE = 'CA002';
  END IF;

  IF v_invoice.deleted_at IS NOT NULL THEN
    -- Brouillon abandonné : ses lignes ne font que se retirer avec lui.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS NOT NULL
       AND to_jsonb(NEW) - '{deleted_at,updated_at,net_amount_cents}'::text[]
           = to_jsonb(OLD) - '{deleted_at,updated_at,net_amount_cents}'::text[] THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Ce brouillon a été abandonné : il ne se modifie plus.' USING ERRCODE = 'CA002';
  END IF;

  IF NEW.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'La libération d''une source est posée par la base, à l''émission d''un avoir.'
      USING ERRCODE = 'CA003';
  END IF;

  IF v_invoice.kind = 'credit_note' THEN
    IF num_nonnulls(NEW.contract_id, NEW.contract_line_id, NEW.booking_id,
                    NEW.subscribed_service_id, NEW.mail_item_id) > 0 THEN
      RAISE EXCEPTION 'Une ligne d''avoir ne porte pas de source : elle désigne la ligne qu''elle crédite (credited_line_id).'
        USING ERRCODE = 'CA003';
    END IF;
    IF NEW.credited_line_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM invoice_lines AS o
       WHERE o.tenant_id = NEW.tenant_id
         AND o.id = NEW.credited_line_id
         AND o.invoice_id = v_invoice.credited_invoice_id
         AND o.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'La ligne créditée n''appartient pas à la facture que l''avoir corrige.'
        USING ERRCODE = 'CA003';
    END IF;
  ELSE
    IF NEW.credited_line_id IS NOT NULL THEN
      RAISE EXCEPTION 'Seule une ligne d''avoir crédite une ligne de facture.' USING ERRCODE = 'CA003';
    END IF;

    v_kind := NEW.kind::text;
    IF (v_kind = 'rent' AND (NEW.contract_id IS NULL OR NEW.period_start IS NULL))
       OR (v_kind = 'booking' AND NEW.booking_id IS NULL)
       OR (v_kind = 'act' AND NEW.service_id IS NULL)
       OR (v_kind = 'package' AND (num_nonnulls(NEW.subscribed_service_id, NEW.contract_line_id) = 0
                                   OR NEW.period_start IS NULL))
       OR (NEW.booking_id IS NOT NULL AND v_kind <> 'booking')
       OR (NEW.mail_item_id IS NOT NULL AND v_kind <> 'act')
       OR (NEW.contract_line_id IS NOT NULL AND v_kind NOT IN ('rent', 'package'))
       OR (NEW.subscribed_service_id IS NOT NULL AND v_kind NOT IN ('package', 'act')) THEN
      RAISE EXCEPTION 'Ligne de facture incohérente : une ligne « % » ne porte pas cette source.', v_kind
        USING ERRCODE = 'CA003',
              HINT = 'rent : contrat et période ; booking : réservation ; act : service (et pli) ; package : souscription ou ligne de contrat, et période.';
    END IF;

    IF NEW.contract_id IS NOT NULL THEN
      SELECT client_id INTO v_client FROM contracts WHERE tenant_id = NEW.tenant_id AND id = NEW.contract_id;
      IF v_client IS DISTINCT FROM v_invoice.client_id THEN
        RAISE EXCEPTION 'Ce contrat n''est pas celui du client facturé.' USING ERRCODE = 'CA003';
      END IF;
    END IF;
    IF NEW.booking_id IS NOT NULL THEN
      SELECT client_id INTO v_client FROM bookings
       WHERE tenant_id = NEW.tenant_id AND id = NEW.booking_id AND kind = 'booking';
      IF v_client IS DISTINCT FROM v_invoice.client_id THEN
        RAISE EXCEPTION 'Cette réservation n''est pas une réservation du client facturé.' USING ERRCODE = 'CA003';
      END IF;
    END IF;
    IF NEW.subscribed_service_id IS NOT NULL THEN
      SELECT client_id INTO v_client FROM subscribed_services
       WHERE tenant_id = NEW.tenant_id AND id = NEW.subscribed_service_id;
      IF v_client IS DISTINCT FROM v_invoice.client_id THEN
        RAISE EXCEPTION 'Cette souscription n''est pas celle du client facturé.' USING ERRCODE = 'CA003';
      END IF;
    END IF;
    IF NEW.mail_item_id IS NOT NULL THEN
      SELECT client_id INTO v_client FROM mail_items
       WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_item_id;
      IF v_client IS DISTINCT FROM v_invoice.client_id THEN
        RAISE EXCEPTION 'Ce pli n''est pas adressé au client facturé.' USING ERRCODE = 'CA003';
      END IF;
    END IF;

    IF NEW.contract_line_id IS NOT NULL THEN
      SELECT cl.is_recurring, coalesce(a.effective_on, k.starts_on)
        INTO v_recurring, v_version_start
        FROM contract_lines AS cl
        JOIN contracts AS k ON k.tenant_id = cl.tenant_id AND k.id = cl.contract_id
        LEFT JOIN contract_amendments AS a ON a.tenant_id = cl.tenant_id AND a.id = cl.amendment_id
       WHERE cl.tenant_id = NEW.tenant_id AND cl.id = NEW.contract_line_id;
      IF v_recurring IS FALSE THEN
        NEW.period_start := v_version_start;
        NEW.period_end := v_version_start;
      END IF;
    END IF;

    -- Loyer ou forfait d'un contrat : un contrat engagé, et la version de prix
    -- en vigueur sur toute la période de la ligne. Sans cela, la ligne d'une
    -- version remplacée par un avenant, ou un loyer global à côté des lignes,
    -- facturerait deux fois les mêmes jours sous deux clés différentes.
    IF NEW.contract_id IS NOT NULL AND v_kind IN ('rent', 'package')
       AND NEW.subscribed_service_id IS NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM contracts
         WHERE tenant_id = NEW.tenant_id AND id = NEW.contract_id
           AND status IN ('active', 'terminated') AND deleted_at IS NULL
      ) THEN
        RAISE EXCEPTION 'Seul un contrat engagé (en cours ou résilié, non archivé) se facture.'
          USING ERRCODE = 'CA003';
      END IF;
      SELECT v.amendment_id, v.ends_on INTO v_version_amendment, v_version_end
        FROM contract_price_versions(NEW.contract_id) AS v
       WHERE v.starts_on <= NEW.period_start
       ORDER BY v.starts_on DESC
       LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'La période facturée commence avant le contrat.' USING ERRCODE = 'CA003';
      END IF;
      IF v_version_end IS NOT NULL AND NEW.period_end > v_version_end THEN
        RAISE EXCEPTION 'La période facturée dépasse la version du contrat qui la couvre (jusqu''au %) : coupez-la à la date d''effet de l''avenant, ou au dernier jour du contrat.',
          to_char(v_version_end, 'DD/MM/YYYY')
          USING ERRCODE = 'CA003';
      END IF;
      IF NEW.contract_line_id IS NOT NULL THEN
        IF NOT EXISTS (
          SELECT 1 FROM contract_lines
           WHERE tenant_id = NEW.tenant_id AND id = NEW.contract_line_id
             AND amendment_id IS NOT DISTINCT FROM v_version_amendment
        ) THEN
          RAISE EXCEPTION 'Cette ligne de contrat n''est pas celle de la version en vigueur sur la période.'
            USING ERRCODE = 'CA003';
        END IF;
      ELSIF EXISTS (
        SELECT 1 FROM contract_lines
         WHERE tenant_id = NEW.tenant_id AND contract_id = NEW.contract_id
           AND amendment_id IS NOT DISTINCT FROM v_version_amendment
           AND deleted_at IS NULL
      ) THEN
        RAISE EXCEPTION 'Ce contrat a des lignes sur cette période : facturez-les ligne à ligne (contract_line_id).'
          USING ERRCODE = 'CA003';
      END IF;
    END IF;

    -- Forfait souscrit : la souscription couvre toute la période.
    IF NEW.subscribed_service_id IS NOT NULL AND v_kind = 'package' AND NOT EXISTS (
      SELECT 1 FROM subscribed_services
       WHERE tenant_id = NEW.tenant_id AND id = NEW.subscribed_service_id
         AND deleted_at IS NULL
         AND starts_on <= NEW.period_start
         AND (ends_on IS NULL OR ends_on >= NEW.period_end)
    ) THEN
      RAISE EXCEPTION 'La souscription ne couvre pas toute la période facturée.' USING ERRCODE = 'CA003';
    END IF;

    -- Un pli se facture ouvert, et pas s'il a été retiré (ADR 015).
    IF NEW.mail_item_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM mail_items
       WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_item_id
         AND opened_at IS NOT NULL AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Seul un pli ouvert, et non retiré, se facture.' USING ERRCODE = 'CA003';
    END IF;
  END IF;

  v_net := line_net_amount_cents(NEW.quantity, NEW.unit_price_cents, NEW.discount_bp,
                                 NEW.discount_amount_cents, NEW.prorata_numerator,
                                 NEW.prorata_denominator);
  IF coalesce(current_setting('app.invoice_amounts_sync', true), '') <> 'on' THEN
    NEW.vat_amount_cents := vat_amount_cents(v_net, NEW.vat_rate_bp);
  END IF;
  NEW.total_amount_cents := v_net + NEW.vat_amount_cents;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_guard
BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
FOR EACH ROW EXECUTE FUNCTION invoice_lines_guard();
--> statement-breakpoint
-- Après chaque instruction qui écrit des lignes : TVA et totaux du brouillon
-- recalculés en une fois, quelle que soit la façon dont le code a écrit.
CREATE FUNCTION invoice_lines_refresh() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice_id uuid;
BEGIN
  IF coalesce(current_setting('app.invoice_amounts_sync', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  FOR v_invoice_id IN SELECT DISTINCT invoice_id FROM changed_lines LOOP
    PERFORM invoice_refresh_amounts(v_invoice_id);
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_refresh_on_insert
AFTER INSERT ON invoice_lines
REFERENCING NEW TABLE AS changed_lines
FOR EACH STATEMENT EXECUTE FUNCTION invoice_lines_refresh();
--> statement-breakpoint
CREATE TRIGGER invoice_lines_refresh_on_update
AFTER UPDATE ON invoice_lines
REFERENCING NEW TABLE AS changed_lines
FOR EACH STATEMENT EXECUTE FUNCTION invoice_lines_refresh();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. Factures : nées brouillons, émises par la base, figées ensuite
-- ---------------------------------------------------------------------------
-- Garde de `invoices` :
--
-- - une facture naît brouillon, totaux et règlements à zéro ; un avoir vise
--   une facture émise ;
-- - un brouillon se modifie, sauf ses totaux (tenus par la base), sa nature,
--   la facture qu'il corrige, et son client une fois qu'il a des lignes ;
--   il ne passe à l'état émis que par `issue_invoice()` ;
-- - un brouillon abandonné (`deleted_at`) ne change plus ;
-- - une facture émise ne change plus (CA002), sauf ce que la base déduit des
--   paiements et des avoirs (`paid_cents`, `credited_cents`, `status`) ;
-- - une facture ne se supprime jamais.
CREATE FUNCTION invoices_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Une facture ne se supprime pas : un brouillon s''abandonne (deleted_at), une facture émise se corrige par un avoir.'
      USING ERRCODE = 'CA002';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Une facture naît brouillon : elle est émise par issue_invoice().'
        USING ERRCODE = 'CA003';
    END IF;
    NEW.total_excl_tax_cents := 0;
    NEW.total_tax_cents := 0;
    NEW.total_incl_tax_cents := 0;
    NEW.paid_cents := 0;
    NEW.credited_cents := 0;
    IF NEW.kind = 'credit_note' AND NOT EXISTS (
      SELECT 1 FROM invoices AS o
       WHERE o.tenant_id = NEW.tenant_id
         AND o.id = NEW.credited_invoice_id
         AND o.kind = 'invoice'
         AND o.status <> 'draft'
    ) THEN
      RAISE EXCEPTION 'Un avoir corrige une facture émise.' USING ERRCODE = 'CA003';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.kind <> OLD.kind
     OR NEW.credited_invoice_id IS DISTINCT FROM OLD.credited_invoice_id THEN
    RAISE EXCEPTION 'La nature d''une facture et la facture qu''un avoir corrige ne changent pas.'
      USING ERRCODE = 'CA002';
  END IF;

  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Ce brouillon a été abandonné : il ne se modifie plus.' USING ERRCODE = 'CA002';
  END IF;

  IF OLD.status = 'draft' THEN
    IF NEW.status <> 'draft' AND coalesce(current_setting('app.invoice_issue', true), '') <> 'on' THEN
      RAISE EXCEPTION 'Une facture s''émet par issue_invoice() : numéro, date, échéance et mentions viennent de la base.'
        USING ERRCODE = 'CA003';
    END IF;
    IF coalesce(current_setting('app.invoice_amounts_sync', true), '') <> 'on' THEN
      NEW.total_excl_tax_cents := OLD.total_excl_tax_cents;
      NEW.total_tax_cents := OLD.total_tax_cents;
      NEW.total_incl_tax_cents := OLD.total_incl_tax_cents;
    END IF;
    IF NEW.client_id <> OLD.client_id AND EXISTS (
      SELECT 1 FROM invoice_lines
       WHERE tenant_id = OLD.tenant_id AND invoice_id = OLD.id AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Ce brouillon a des lignes : il ne change pas de client.' USING ERRCODE = 'CA003';
    END IF;
    RETURN NEW;
  END IF;

  IF coalesce(current_setting('app.invoice_settlement_sync', true), '') = 'on'
     AND to_jsonb(NEW) - '{paid_cents,credited_cents,status,updated_at}'::text[]
         = to_jsonb(OLD) - '{paid_cents,credited_cents,status,updated_at}'::text[] THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'La facture % est émise : elle ne se modifie plus. Toute correction passe par un avoir.',
    OLD.number
    USING ERRCODE = 'CA002';
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoices_guard
BEFORE INSERT OR UPDATE OR DELETE ON invoices
FOR EACH ROW EXECUTE FUNCTION invoices_guard();
--> statement-breakpoint
-- Un brouillon abandonné retire ses lignes : elles libèrent leurs sources,
-- qu'un autre brouillon peut alors facturer.
CREATE FUNCTION invoices_abandon_lines() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    UPDATE invoice_lines
       SET deleted_at = NEW.deleted_at
     WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.id AND deleted_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoices_abandon_lines
AFTER UPDATE ON invoices
FOR EACH ROW EXECUTE FUNCTION invoices_abandon_lines();

--> statement-breakpoint

-- Règlement d'une facture émise : paiements non annulés, avoirs émis, statut
-- déduit, et libération des sources des lignes entièrement créditées (une
-- ligne d'avoir émise au moins, et la somme créditée égale à son montant net).
-- Appelée par la base seule : après un paiement, après l'émission d'un avoir.
CREATE FUNCTION invoice_settle(p_invoice_id uuid) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice invoices%ROWTYPE;
  v_paid bigint;
  v_credited bigint;
BEGIN
  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id FOR NO KEY UPDATE;
  IF NOT FOUND OR v_invoice.status = 'draft' OR v_invoice.kind <> 'invoice' THEN
    RETURN;
  END IF;

  SELECT coalesce(sum(amount_cents), 0) INTO v_paid
    FROM payments
   WHERE tenant_id = v_invoice.tenant_id AND invoice_id = v_invoice.id AND cancelled_at IS NULL;
  SELECT coalesce(sum(total_incl_tax_cents), 0) INTO v_credited
    FROM invoices
   WHERE tenant_id = v_invoice.tenant_id
     AND credited_invoice_id = v_invoice.id
     AND kind = 'credit_note'
     AND status <> 'draft';

  PERFORM set_config('app.invoice_settlement_sync', 'on', true);

  UPDATE invoices
     SET paid_cents = v_paid::integer,
         credited_cents = v_credited::integer,
         status = invoice_payment_status(kind, total_incl_tax_cents, v_paid::integer, v_credited::integer)
   WHERE id = v_invoice.id
     AND (paid_cents, credited_cents) IS DISTINCT FROM (v_paid::integer, v_credited::integer);

  UPDATE invoice_lines AS o
     SET released_at = now()
   WHERE o.tenant_id = v_invoice.tenant_id
     AND o.invoice_id = v_invoice.id
     AND o.deleted_at IS NULL
     AND o.released_at IS NULL
     AND EXISTS (
       SELECT 1
         FROM invoice_lines AS cl
         JOIN invoices AS cn ON cn.tenant_id = cl.tenant_id AND cn.id = cl.invoice_id
        WHERE cl.tenant_id = o.tenant_id AND cl.credited_line_id = o.id
          AND cl.deleted_at IS NULL AND cn.kind = 'credit_note' AND cn.status <> 'draft'
       HAVING sum(cl.net_amount_cents) = o.net_amount_cents
     );

  PERFORM set_config('app.invoice_settlement_sync', '', true);
END
$$;

--> statement-breakpoint

-- Émission d'une facture ou d'un avoir (R13, ADR 021, ADR 026). Seul chemin
-- d'un brouillon vers l'état émis. Dans la transaction appelante :
--
-- 1. verrouille le brouillon ;
-- 2. vérifie les mentions obligatoires du vendeur et de l'acheteur, et le
--    moyen de paiement (IBAN du centre pour un virement, mandat actif et ICS
--    pour un prélèvement) ;
-- 3. recalcule TVA et totaux ; refuse une facture vide ou négative, un avoir
--    nul, excédentaire, ou qui crédite une ligne au-delà de son montant ;
-- 4. prend le numéro (`next_document_number`, sans trou : une annulation de la
--    transaction le rend), date la facture du jour du centre, calcule
--    l'échéance, fige le vendeur, l'acheteur et les mentions ;
-- 5. pour un avoir, règle la facture corrigée (`invoice_settle`).
--
-- Refus : SQLSTATE CA003 (non conforme), CA002 (déjà émise). Rend le numéro.
CREATE FUNCTION issue_invoice(p_invoice_id uuid, p_issued_by uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice invoices%ROWTYPE;
  v_tenant tenants%ROWTYPE;
  v_client clients%ROWTYPE;
  v_original invoices%ROWTYPE;
  v_mandate sepa_mandates%ROWTYPE;
  v_missing text[] := ARRAY[]::text[];
  v_line_count integer;
  v_today date;
  v_terms integer;
  v_number text;
  v_siret text;
BEGIN
  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Facture % introuvable dans ce centre.', p_invoice_id USING ERRCODE = 'CA003';
  END IF;
  IF v_invoice.status <> 'draft' THEN
    RAISE EXCEPTION 'La facture % est déjà émise.', v_invoice.number USING ERRCODE = 'CA002';
  END IF;
  IF v_invoice.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Ce brouillon a été abandonné : il ne s''émet pas.' USING ERRCODE = 'CA003';
  END IF;

  SELECT * INTO v_tenant FROM tenants WHERE id = v_invoice.tenant_id;
  SELECT * INTO v_client FROM clients WHERE tenant_id = v_invoice.tenant_id AND id = v_invoice.client_id;

  -- Mentions obligatoires (art. 242 nonies A de l'annexe II du CGI,
  -- art. L. 441-9 du Code de commerce).
  IF nullif(btrim(v_tenant.legal_name), '') IS NULL THEN
    v_missing := array_append(v_missing, 'raison sociale du centre');
  END IF;
  IF nullif(btrim(v_tenant.address_line1), '') IS NULL
     OR nullif(btrim(v_tenant.postal_code), '') IS NULL
     OR nullif(btrim(v_tenant.city), '') IS NULL THEN
    v_missing := array_append(v_missing, 'adresse du centre');
  END IF;
  IF v_tenant.siren IS NULL THEN
    v_missing := array_append(v_missing, 'SIREN du centre');
  END IF;
  IF v_tenant.vat_number IS NULL THEN
    v_missing := array_append(v_missing, 'numéro de TVA intracommunautaire du centre');
  END IF;
  IF nullif(btrim(v_client.address_line1), '') IS NULL
     OR nullif(btrim(v_client.postal_code), '') IS NULL
     OR nullif(btrim(v_client.city), '') IS NULL THEN
    v_missing := array_append(v_missing, 'adresse du client');
  END IF;
  IF v_invoice.kind = 'invoice' THEN
    IF v_invoice.expected_payment_method = 'transfer' AND v_tenant.bank_iban IS NULL THEN
      v_missing := array_append(v_missing, 'IBAN du centre (paiement par virement)');
    END IF;
    IF v_invoice.expected_payment_method = 'direct_debit' THEN
      IF v_tenant.sepa_creditor_id IS NULL THEN
        v_missing := array_append(v_missing, 'identifiant créancier SEPA du centre');
      END IF;
      SELECT * INTO v_mandate FROM sepa_mandates
       WHERE tenant_id = v_invoice.tenant_id AND id = v_invoice.sepa_mandate_id;
      IF NOT FOUND OR v_mandate.status <> 'active' OR v_mandate.deleted_at IS NOT NULL THEN
        v_missing := array_append(v_missing, 'mandat de prélèvement actif du client');
      END IF;
    END IF;
  END IF;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'Émission impossible, il manque : %.', array_to_string(v_missing, ', ')
      USING ERRCODE = 'CA003';
  END IF;

  PERFORM invoice_refresh_amounts(v_invoice.id);
  SELECT count(*) INTO v_line_count
    FROM invoice_lines WHERE invoice_id = v_invoice.id AND deleted_at IS NULL;
  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'Une facture sans ligne ne s''émet pas.' USING ERRCODE = 'CA003';
  END IF;
  SELECT * INTO v_invoice FROM invoices WHERE id = v_invoice.id;

  IF v_invoice.kind = 'invoice' AND v_invoice.total_incl_tax_cents < 0 THEN
    RAISE EXCEPTION 'Le total de cette facture est négatif : c''est un avoir qu''il faut établir.'
      USING ERRCODE = 'CA003';
  END IF;

  IF v_invoice.kind = 'credit_note' THEN
    IF v_invoice.total_incl_tax_cents <= 0 THEN
      RAISE EXCEPTION 'Un avoir porte un montant positif.' USING ERRCODE = 'CA003';
    END IF;
    SELECT * INTO v_original FROM invoices
     WHERE tenant_id = v_invoice.tenant_id AND id = v_invoice.credited_invoice_id
     FOR NO KEY UPDATE;
    IF v_original.kind <> 'invoice' OR v_original.status = 'draft' THEN
      RAISE EXCEPTION 'Un avoir corrige une facture émise.' USING ERRCODE = 'CA003';
    END IF;
    IF v_original.currency <> v_invoice.currency THEN
      RAISE EXCEPTION 'L''avoir et la facture % ne sont pas dans la même devise.', v_original.number
        USING ERRCODE = 'CA003';
    END IF;
    IF v_original.credited_cents + v_invoice.total_incl_tax_cents > v_original.total_incl_tax_cents THEN
      RAISE EXCEPTION 'Avoir excédentaire : il reste % centimes TTC à créditer sur la facture %.',
        v_original.total_incl_tax_cents - v_original.credited_cents, v_original.number
        USING ERRCODE = 'CA003';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM invoice_lines AS o
        JOIN invoice_lines AS cl ON cl.tenant_id = o.tenant_id AND cl.credited_line_id = o.id
        JOIN invoices AS cn ON cn.tenant_id = cl.tenant_id AND cn.id = cl.invoice_id
       WHERE o.tenant_id = v_invoice.tenant_id
         AND o.invoice_id = v_original.id
         AND cl.deleted_at IS NULL
         AND (cn.id = v_invoice.id OR (cn.kind = 'credit_note' AND cn.status <> 'draft'))
       GROUP BY o.id, o.net_amount_cents
      HAVING CASE WHEN o.net_amount_cents >= 0
                  THEN sum(cl.net_amount_cents) NOT BETWEEN 0 AND o.net_amount_cents
                  ELSE sum(cl.net_amount_cents) NOT BETWEEN o.net_amount_cents AND 0
             END
    ) THEN
      RAISE EXCEPTION 'Une ligne serait créditée au-delà de son montant.' USING ERRCODE = 'CA003';
    END IF;
  END IF;

  v_today := (now() AT TIME ZONE v_tenant.timezone)::date;
  v_terms := CASE WHEN v_invoice.kind = 'invoice'
                  THEN coalesce(v_invoice.payment_terms_days, v_tenant.invoice_payment_terms_days)
                  ELSE 0 END;
  v_number := next_document_number(
    CASE v_invoice.kind WHEN 'invoice' THEN 'invoice' ELSE 'credit_note' END::document_type
  );
  v_siret := nullif(regexp_replace(coalesce(v_client.siret, ''), '\s', '', 'g'), '');

  PERFORM set_config('app.invoice_issue', 'on', true);
  UPDATE invoices
     SET number = v_number,
         status = invoice_payment_status(kind, total_incl_tax_cents, 0, 0),
         issue_date = v_today,
         issued_at = now(),
         issued_by = p_issued_by,
         payment_terms_days = v_terms,
         due_date = v_today + v_terms,
         mandate_reference = CASE WHEN v_invoice.expected_payment_method = 'direct_debit'
                                  THEN v_mandate.reference END,
         seller_snapshot = jsonb_build_object(
           'legalName', v_tenant.legal_name,
           'legalForm', v_tenant.legal_form,
           'shareCapitalCents', v_tenant.share_capital_cents,
           'siren', v_tenant.siren,
           'siret', v_tenant.siret,
           'vatNumber', v_tenant.vat_number,
           'rcsCity', v_tenant.rcs_city,
           'addressLine1', v_tenant.address_line1,
           'addressLine2', v_tenant.address_line2,
           'postalCode', v_tenant.postal_code,
           'city', v_tenant.city,
           'country', v_tenant.country,
           'email', v_tenant.email,
           'phone', v_tenant.phone,
           'websiteUrl', v_tenant.website_url,
           'bankIban', v_tenant.bank_iban,
           'bankBic', v_tenant.bank_bic,
           'sepaCreditorId', v_tenant.sepa_creditor_id
         ),
         buyer_snapshot = jsonb_build_object(
           'name', v_client.name,
           'legalForm', v_client.legal_form,
           'siret', v_siret,
           'siren', CASE WHEN v_siret ~ '^[0-9]{14}$' THEN left(v_siret, 9) END,
           'vatNumber', v_client.vat_number,
           'addressLine1', v_client.address_line1,
           'addressLine2', v_client.address_line2,
           'postalCode', v_client.postal_code,
           'city', v_client.city,
           'country', v_client.country,
           'email', v_client.email,
           'accountingCode', v_client.accounting_code
         ),
         legal_mentions = jsonb_build_object(
           'paymentTermsDays', v_terms,
           'latePaymentPenaltyText', v_tenant.late_payment_penalty_text,
           'recoveryIndemnityCents', v_tenant.recovery_indemnity_cents,
           'earlyPaymentDiscountText', v_tenant.early_payment_discount_text,
           'vatOnDebits', v_tenant.vat_on_debits,
           'operationCategory', 'services',
           'footerText', v_tenant.invoice_footer_text,
           'creditedInvoiceNumber', v_original.number
         )
   WHERE id = v_invoice.id;
  PERFORM set_config('app.invoice_issue', '', true);

  IF v_invoice.kind = 'credit_note' THEN
    PERFORM invoice_settle(v_original.id);
  END IF;

  RETURN v_number;
END
$$;

--> statement-breakpoint

-- Brouillon d'avoir qui annule ce qui reste d'une facture émise : chaque ligne
-- pas encore entièrement créditée y est reprise pour son reliquat — à
-- l'identique si rien n'en a été crédité, pour le reste net sinon. Le code peut
-- ensuite le modifier (avoir partiel) avant de l'émettre par `issue_invoice`.
-- Rend l'identifiant du brouillon.
CREATE FUNCTION draft_credit_note(p_invoice_id uuid, p_reason text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_original invoices%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO v_original FROM invoices WHERE id = p_invoice_id FOR NO KEY UPDATE;
  IF NOT FOUND OR v_original.kind <> 'invoice' OR v_original.status = 'draft' THEN
    RAISE EXCEPTION 'Seule une facture émise se corrige par un avoir.' USING ERRCODE = 'CA003';
  END IF;
  IF v_original.status = 'cancelled' THEN
    RAISE EXCEPTION 'La facture % est déjà entièrement créditée.', v_original.number USING ERRCODE = 'CA003';
  END IF;

  INSERT INTO invoices (
    tenant_id, kind, client_id, credited_invoice_id, period_start, period_end, currency,
    expected_payment_method, notes
  )
  VALUES (
    v_original.tenant_id, 'credit_note', v_original.client_id, v_original.id,
    v_original.period_start, v_original.period_end, v_original.currency, 'transfer', p_reason
  )
  RETURNING id INTO v_id;

  INSERT INTO invoice_lines (
    tenant_id, invoice_id, position, kind, description, period_start, period_end,
    quantity, unit, unit_price_cents, discount_bp, discount_amount_cents,
    prorata_numerator, prorata_denominator, vat_rate_bp, vat_category, vat_exemption_reason,
    service_id, resource_id, credited_line_id
  )
  SELECT o.tenant_id, v_id, o.position, o.kind, o.description, o.period_start, o.period_end,
         CASE WHEN r.credited = 0 THEN o.quantity ELSE 1 END,
         CASE WHEN r.credited = 0 THEN o.unit END,
         CASE WHEN r.credited = 0 THEN o.unit_price_cents ELSE o.net_amount_cents - r.credited END,
         CASE WHEN r.credited = 0 THEN o.discount_bp END,
         CASE WHEN r.credited = 0 THEN o.discount_amount_cents END,
         CASE WHEN r.credited = 0 THEN o.prorata_numerator END,
         CASE WHEN r.credited = 0 THEN o.prorata_denominator END,
         o.vat_rate_bp, o.vat_category, o.vat_exemption_reason,
         o.service_id, o.resource_id, o.id
    FROM invoice_lines AS o
    CROSS JOIN LATERAL (
      SELECT coalesce(sum(cl.net_amount_cents), 0)::integer AS credited
        FROM invoice_lines AS cl
        JOIN invoices AS cn ON cn.tenant_id = cl.tenant_id AND cn.id = cl.invoice_id
       WHERE cl.tenant_id = o.tenant_id AND cl.credited_line_id = o.id
         AND cl.deleted_at IS NULL AND cn.kind = 'credit_note' AND cn.status <> 'draft'
    ) AS r
   WHERE o.tenant_id = v_original.tenant_id
     AND o.invoice_id = v_original.id
     AND o.deleted_at IS NULL
     AND o.released_at IS NULL
   ORDER BY o.position, o.id;

  RETURN v_id;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. Paiements (R16, ADR 027)
-- ---------------------------------------------------------------------------
-- Sur une facture émise seulement, dans sa devise ; jamais supprimé ni
-- modifié, seulement annulé. Le statut de la facture suit.
CREATE FUNCTION payments_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice invoices%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un paiement ne se supprime pas : annulez-le (cancelled_at).' USING ERRCODE = 'CA006';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO v_invoice FROM invoices WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
    IF v_invoice.kind <> 'invoice' THEN
      RAISE EXCEPTION 'Un avoir ne se paie pas : un remboursement se pointe sur la facture, en montant négatif.'
        USING ERRCODE = 'CA006';
    END IF;
    IF v_invoice.status = 'draft' OR v_invoice.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Un brouillon ne se paie pas : émettez d''abord la facture.' USING ERRCODE = 'CA006';
    END IF;
    IF NEW.currency <> v_invoice.currency THEN
      RAISE EXCEPTION 'Le paiement est en %, la facture % en %.', NEW.currency, v_invoice.number, v_invoice.currency
        USING ERRCODE = 'CA006';
    END IF;
    IF NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'Un paiement s''enregistre valide, puis s''annule.' USING ERRCODE = 'CA006';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Ce paiement est annulé : il ne change plus.' USING ERRCODE = 'CA006';
  END IF;
  IF to_jsonb(NEW) - '{cancelled_at,cancelled_by,cancellation_reason,updated_at}'::text[]
     <> to_jsonb(OLD) - '{cancelled_at,cancelled_by,cancellation_reason,updated_at}'::text[] THEN
    RAISE EXCEPTION 'Un paiement ne se modifie pas : annulez-le, puis saisissez le bon.' USING ERRCODE = 'CA006';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payments_guard
BEFORE INSERT OR UPDATE OR DELETE ON payments
FOR EACH ROW EXECUTE FUNCTION payments_guard();
--> statement-breakpoint
CREATE FUNCTION payments_settle_invoice() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM invoice_settle(NEW.invoice_id);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payments_settle_invoice
AFTER INSERT OR UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION payments_settle_invoice();

--> statement-breakpoint

-- Mandats SEPA : la RUM et le client ne changent jamais (règlement SEPA). Un
-- changement de compte réécrit l'IBAN chiffré sous la même RUM.
CREATE FUNCTION sepa_mandates_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un mandat ne se supprime pas : révoquez-le.' USING ERRCODE = 'CA007';
  END IF;
  IF NEW.reference <> OLD.reference OR NEW.client_id <> OLD.client_id OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'La RUM et le débiteur d''un mandat ne changent pas : établissez un nouveau mandat.'
      USING ERRCODE = 'CA007';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER sepa_mandates_guard
BEFORE UPDATE OR DELETE ON sepa_mandates
FOR EACH ROW EXECUTE FUNCTION sepa_mandates_guard();

--> statement-breakpoint

-- Souscriptions : ce qui a été convenu ne se réécrit pas (prix, TVA, quantité,
-- inclus, service, client, contrat, début). On y met fin (`ends_on`) ou on
-- l'archive, puis on souscrit à nouveau.
CREATE FUNCTION subscribed_services_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Une souscription ne se supprime pas : mettez-y fin (ends_on) ou archivez-la.'
      USING ERRCODE = 'CA004';
  END IF;
  IF (NEW.tenant_id, NEW.client_id, NEW.contract_id, NEW.service_id, NEW.quantity, NEW.unit,
      NEW.unit_price_cents, NEW.discount_bp, NEW.discount_amount_cents, NEW.vat_rate_bp,
      NEW.currency, NEW.included_quantity, NEW.starts_on)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.client_id, OLD.contract_id, OLD.service_id, OLD.quantity, OLD.unit,
      OLD.unit_price_cents, OLD.discount_bp, OLD.discount_amount_cents, OLD.vat_rate_bp,
      OLD.currency, OLD.included_quantity, OLD.starts_on) THEN
    RAISE EXCEPTION 'Une souscription ne se réécrit pas : mettez-y fin, puis souscrivez aux nouvelles conditions.'
      USING ERRCODE = 'CA004';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER subscribed_services_guard
BEFORE UPDATE OR DELETE ON subscribed_services
FOR EACH ROW EXECUTE FUNCTION subscribed_services_guard();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. Contrats versionnés (R12, ADR 025)
-- ---------------------------------------------------------------------------
-- Montant HT par période d'une version, tiré de ses lignes récurrentes
-- vivantes ; nul si elle n'en a aucune (le montant saisi vaut alors).
CREATE FUNCTION contract_version_lines_amount(
  p_tenant_id uuid,
  p_contract_id uuid,
  p_amendment_id uuid
) RETURNS integer
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN count(*) = 0 THEN NULL ELSE sum(net_amount_cents)::integer END
    FROM contract_lines
   WHERE tenant_id = p_tenant_id
     AND contract_id = p_contract_id
     AND amendment_id IS NOT DISTINCT FROM p_amendment_id
     AND deleted_at IS NULL
     AND is_recurring
$$;

--> statement-breakpoint

-- Garde de `contracts` (avant l'écriture) :
-- - le montant d'un brouillon suit ses lignes quand il en a (la valeur écrite
--   est ignorée) ;
-- - hors brouillon, prix, TVA, période, devise et engagement sont figés : ils
--   changent par avenant (CA004) ;
-- - un contrat qui a des avenants signés ne change plus de date de début.
CREATE FUNCTION contracts_guard_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_amount integer;
BEGIN
  IF OLD.status <> 'draft' THEN
    IF (NEW.amount_cents, NEW.vat_rate_bp, NEW.billing_period, NEW.currency, NEW.commitment_months)
       IS DISTINCT FROM
       (OLD.amount_cents, OLD.vat_rate_bp, OLD.billing_period, OLD.currency, OLD.commitment_months) THEN
      RAISE EXCEPTION 'Le contrat % est engagé : son prix et son engagement changent par avenant.', OLD.reference
        USING ERRCODE = 'CA004';
    END IF;
  ELSE
    -- Brouillon : le montant suit les lignes, la valeur écrite est ignorée.
    v_amount := contract_version_lines_amount(NEW.tenant_id, NEW.id, NULL);
    IF v_amount IS NOT NULL THEN
      NEW.amount_cents := v_amount;
    END IF;
  END IF;

  IF NEW.starts_on <> OLD.starts_on AND EXISTS (
    SELECT 1 FROM contract_amendments
     WHERE tenant_id = OLD.tenant_id AND contract_id = OLD.id AND status = 'signed'
  ) THEN
    RAISE EXCEPTION 'Le contrat % a des avenants signés : sa date de début ne change plus.', OLD.reference
      USING ERRCODE = 'CA004';
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER contracts_guard_version
BEFORE UPDATE ON contracts
FOR EACH ROW EXECUTE FUNCTION contracts_guard_version();

--> statement-breakpoint

-- Garde des lignes de contrat : seules celles d'un brouillon (contrat non
-- archivé, ou avenant non signé et non abandonné) s'écrivent ; aucune ne se
-- supprime ni ne change de contrat ou d'avenant.
CREATE FUNCTION contract_lines_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_contract contracts%ROWTYPE;
  v_amendment contract_amendments%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Une ligne de contrat ne se supprime pas : retirez-la d''un brouillon (deleted_at).'
      USING ERRCODE = 'CA004';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id <> OLD.tenant_id OR NEW.contract_id <> OLD.contract_id
                           OR NEW.amendment_id IS DISTINCT FROM OLD.amendment_id) THEN
    RAISE EXCEPTION 'Une ligne ne change ni de contrat ni d''avenant.' USING ERRCODE = 'CA004';
  END IF;

  SELECT * INTO v_contract FROM contracts
   WHERE tenant_id = NEW.tenant_id AND id = NEW.contract_id
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.amendment_id IS NULL THEN
    IF v_contract.status <> 'draft' OR v_contract.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Le contrat % est engagé : ses lignes changent par avenant.', v_contract.reference
        USING ERRCODE = 'CA004';
    END IF;
  ELSE
    SELECT * INTO v_amendment FROM contract_amendments
     WHERE tenant_id = NEW.tenant_id AND id = NEW.amendment_id
     FOR NO KEY UPDATE;
    IF FOUND AND (v_amendment.status <> 'draft' OR v_amendment.deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'L''avenant n° % du contrat % est signé ou abandonné : ses lignes ne changent plus.',
        v_amendment.number, v_contract.reference
        USING ERRCODE = 'CA004';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER contract_lines_guard
BEFORE INSERT OR UPDATE OR DELETE ON contract_lines
FOR EACH ROW EXECUTE FUNCTION contract_lines_guard();
--> statement-breakpoint
-- Après l'écriture d'une ligne : le montant de sa version suit.
CREATE FUNCTION contract_lines_sync_amount() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_amount integer;
BEGIN
  v_amount := contract_version_lines_amount(NEW.tenant_id, NEW.contract_id, NEW.amendment_id);
  IF v_amount IS NULL THEN
    RETURN NULL;
  END IF;
  IF NEW.amendment_id IS NULL THEN
    UPDATE contracts SET amount_cents = v_amount
     WHERE tenant_id = NEW.tenant_id AND id = NEW.contract_id AND amount_cents <> v_amount;
  ELSE
    UPDATE contract_amendments SET amount_cents = v_amount
     WHERE tenant_id = NEW.tenant_id AND id = NEW.amendment_id
       AND amount_cents IS DISTINCT FROM v_amount;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER contract_lines_sync_amount
AFTER INSERT OR UPDATE ON contract_lines
FOR EACH ROW EXECUTE FUNCTION contract_lines_sync_amount();

--> statement-breakpoint

-- Un avenant peut-il être signé ? Refus (CA005) : contrat qui n'est pas en
-- cours ; date d'effet qui n'est pas strictement après le premier jour du
-- contrat, qui suit son dernier jour, ou qui ne suit pas le dernier avenant
-- signé ; avenant qui ne change rien.
CREATE FUNCTION contract_amendment_assert_signable(a contract_amendments, c contracts) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  last_day date := least(c.ends_on, c.terminated_on);
BEGIN
  IF c.status <> 'active' OR c.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Le contrat % n''est pas en cours : l''avenant ne se signe pas.', c.reference
      USING ERRCODE = 'CA005';
  END IF;
  IF a.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cet avenant a été abandonné.' USING ERRCODE = 'CA005';
  END IF;
  IF a.effective_on <= c.starts_on THEN
    RAISE EXCEPTION 'La date d''effet doit suivre le premier jour du contrat (%) : avant son début, le contrat se modifie sans avenant.',
      to_char(c.starts_on, 'DD/MM/YYYY')
      USING ERRCODE = 'CA005';
  END IF;
  IF last_day IS NOT NULL AND a.effective_on > last_day THEN
    RAISE EXCEPTION 'La date d''effet suit le dernier jour du contrat (%).', to_char(last_day, 'DD/MM/YYYY')
      USING ERRCODE = 'CA005';
  END IF;
  IF EXISTS (
    SELECT 1 FROM contract_amendments AS other
     WHERE other.tenant_id = a.tenant_id AND other.contract_id = a.contract_id
       AND other.status = 'signed' AND other.id <> a.id AND other.effective_on >= a.effective_on
  ) THEN
    RAISE EXCEPTION 'Un avenant signé prend déjà effet à cette date ou après : les avenants se suivent dans le temps.'
      USING ERRCODE = 'CA005';
  END IF;
  IF NOT a.changes_resource AND a.amount_cents IS NULL AND NOT EXISTS (
    SELECT 1 FROM contract_lines AS l
     WHERE l.tenant_id = a.tenant_id AND l.amendment_id = a.id AND l.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Cet avenant ne change ni le prix ni la ressource.' USING ERRCODE = 'CA005';
  END IF;
END
$$;

--> statement-breakpoint

-- Garde des avenants (avant l'écriture) : numéro attribué par la base à la
-- création, sur un contrat en cours seulement ; un avenant signé ne change
-- plus ; la signature est vérifiée ; le montant suit les lignes de l'avenant.
CREATE FUNCTION contract_amendments_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_contract contracts%ROWTYPE;
  v_amount integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un avenant ne se supprime pas : un brouillon s''abandonne (deleted_at).'
      USING ERRCODE = 'CA004';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'signed' THEN
      RAISE EXCEPTION 'L''avenant n° % est signé : il ne change plus.', OLD.number USING ERRCODE = 'CA004';
    END IF;
    IF OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Cet avenant a été abandonné : il ne change plus.' USING ERRCODE = 'CA004';
    END IF;
    IF NEW.tenant_id <> OLD.tenant_id OR NEW.contract_id <> OLD.contract_id THEN
      RAISE EXCEPTION 'Un avenant ne change pas de contrat.' USING ERRCODE = 'CA004';
    END IF;
    NEW.number := OLD.number;
  END IF;

  SELECT * INTO v_contract FROM contracts
   WHERE tenant_id = NEW.tenant_id AND id = NEW.contract_id
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_contract.status <> 'active' OR v_contract.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Un avenant s''établit sur un contrat en cours : un brouillon se modifie directement.'
        USING ERRCODE = 'CA005';
    END IF;
    SELECT coalesce(max(number), 0) + 1 INTO NEW.number
      FROM contract_amendments
     WHERE tenant_id = NEW.tenant_id AND contract_id = NEW.contract_id;
  END IF;

  v_amount := contract_version_lines_amount(NEW.tenant_id, NEW.contract_id, NEW.id);
  IF v_amount IS NOT NULL THEN
    NEW.amount_cents := v_amount;
  END IF;

  IF NEW.status = 'signed' THEN
    PERFORM contract_amendment_assert_signable(NEW, v_contract);
    NEW.signed_at := coalesce(NEW.signed_at, now());
  ELSE
    NEW.signed_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER contract_amendments_guard
BEFORE INSERT OR UPDATE OR DELETE ON contract_amendments
FOR EACH ROW EXECUTE FUNCTION contract_amendments_guard();
--> statement-breakpoint
-- Après la signature d'un avenant qui change la ressource : l'occupation du
-- contrat est recalculée par segments.
CREATE FUNCTION contract_amendments_sync_occupation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'signed' AND NEW.changes_resource
     AND (TG_OP = 'INSERT' OR OLD.status <> 'signed') THEN
    PERFORM apply_contract_occupation(k)
       FROM contracts AS k
      WHERE k.tenant_id = NEW.tenant_id AND k.id = NEW.contract_id;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER contract_amendments_sync_occupation
AFTER INSERT OR UPDATE ON contract_amendments
FOR EACH ROW EXECUTE FUNCTION contract_amendments_sync_occupation();

--> statement-breakpoint

-- Segments d'occupation d'un contrat (ADR 025) : la ressource de la version
-- initiale depuis le premier jour, puis celle de chaque avenant signé qui la
-- change, à sa date d'effet, chacun jusqu'à la veille du suivant ; le dernier
-- jusqu'au dernier jour du contrat (nul : sans terme). Un avenant qui prend
-- effet après le dernier jour, ou un contrat résilié avant son début, ne donne
-- aucun segment. `resource_id` nul : rien n'est occupé sur le segment.
CREATE FUNCTION contract_segments(c contracts)
RETURNS TABLE (
  amendment_id uuid,
  amendment_number integer,
  resource_id uuid,
  starts_on date,
  ends_on date
)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT least(c.ends_on, c.terminated_on) AS last_day
  ), changes AS (
    SELECT NULL::uuid AS change_id,
           NULL::integer AS change_number,
           c.resource_id AS change_resource,
           c.starts_on AS change_start
    UNION ALL
    SELECT a.id, a.number, a.resource_id, a.effective_on
      FROM contract_amendments AS a, bounds
     WHERE a.tenant_id = c.tenant_id
       AND a.contract_id = c.id
       AND a.status = 'signed'
       AND a.changes_resource
       AND a.effective_on > c.starts_on
       AND (bounds.last_day IS NULL OR a.effective_on <= bounds.last_day)
  ), ordered AS (
    SELECT changes.*, lead(changes.change_start) OVER (ORDER BY changes.change_start) AS next_start
      FROM changes
  )
  SELECT o.change_id, o.change_number, o.change_resource, o.change_start,
         CASE WHEN o.next_start IS NOT NULL THEN o.next_start - 1 ELSE b.last_day END
    FROM ordered AS o, bounds AS b
   WHERE b.last_day IS NULL OR b.last_day >= c.starts_on
   ORDER BY o.change_start
$$;

--> statement-breakpoint

-- Versions de prix d'un contrat (ADR 025) : la version initiale
-- (`contracts.amount_cents`) puis chaque avenant signé qui porte un montant,
-- de sa date d'effet à la veille du suivant ; la dernière jusqu'au dernier
-- jour du contrat (nul : sans terme). Les lignes d'une version sont les
-- `contract_lines` vivantes de même `amendment_id` (nul pour l'initiale) ;
-- sans ligne, la version se facture d'un montant, à `contracts.vat_rate_bp`.
CREATE FUNCTION contract_price_versions(p_contract_id uuid)
RETURNS TABLE (
  amendment_id uuid,
  amendment_number integer,
  starts_on date,
  ends_on date,
  amount_cents integer
)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  WITH k AS (
    SELECT * FROM contracts WHERE id = p_contract_id
  ), bounds AS (
    SELECT least(k.ends_on, k.terminated_on) AS last_day, k.starts_on AS first_day FROM k
  ), versions AS (
    SELECT NULL::uuid AS version_id,
           NULL::integer AS version_number,
           k.starts_on AS version_start,
           k.amount_cents AS version_amount
      FROM k
    UNION ALL
    SELECT a.id, a.number, a.effective_on, a.amount_cents
      FROM contract_amendments AS a
      JOIN k ON a.tenant_id = k.tenant_id AND a.contract_id = k.id
      CROSS JOIN bounds
     WHERE a.status = 'signed'
       AND a.amount_cents IS NOT NULL
       AND a.effective_on > k.starts_on
       AND (bounds.last_day IS NULL OR a.effective_on <= bounds.last_day)
  ), ordered AS (
    SELECT versions.*, lead(versions.version_start) OVER (ORDER BY versions.version_start) AS next_start
      FROM versions
  )
  SELECT o.version_id, o.version_number, o.version_start,
         CASE WHEN o.next_start IS NOT NULL THEN o.next_start - 1 ELSE b.last_day END,
         o.version_amount
    FROM ordered AS o, bounds AS b
   WHERE b.last_day IS NULL OR b.last_day >= b.first_day
   ORDER BY o.version_start
$$;

--> statement-breakpoint

-- Aligne l'occupation d'un contrat sur ses segments (remplace la fonction de
-- la migration 0026, ADR 018 amendé par l'ADR 025). Une ligne de `bookings`
-- par segment qui désigne une ressource, clé `(contract_id,
-- contract_amendment_id)`. Idempotente : ne réécrit que ce qui diffère.
--
-- Même prédicat qu'avant pour le contrat (non archivé, actif ou résilié, pas
-- résilié avant son début) ; mêmes bornes : minuit du centre au premier jour,
-- minuit du centre le lendemain du dernier jour, `booking_open_end()` sans
-- terme.
--
-- Deux passes, pour que la contrainte d'exclusion ne voie jamais deux
-- segments du même contrat se chevaucher en cours de route : la première
-- annule ce qui disparaît et met de côté ce qui se déplace, la seconde écrit
-- les segments voulus.
CREATE OR REPLACE FUNCTION apply_contract_occupation(c contracts) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  last_day date := least(c.ends_on, c.terminated_on);
  occupied boolean;
  centre_time_zone text;
  existing bookings%ROWTYPE;
  segment record;
  range_start timestamptz;
  range_end timestamptz;
  segment_title text;
  found_segment boolean;
BEGIN
  occupied := c.deleted_at IS NULL
          AND c.status IN ('active', 'terminated')
          AND (last_day IS NULL OR last_day >= c.starts_on);

  IF occupied THEN
    SELECT t.timezone INTO centre_time_zone FROM tenants AS t WHERE t.id = c.tenant_id;
    IF centre_time_zone IS NULL THEN
      RAISE EXCEPTION 'Fuseau du centre % introuvable : impossible de dater l''occupation du contrat %.',
        c.tenant_id, c.reference;
    END IF;
  END IF;

  PERFORM set_config('app.contract_occupation_sync', 'on', true);

  -- Passe 1 : annuler ce qui ne doit plus occuper, libérer ce qui se déplace.
  FOR existing IN
    SELECT * FROM bookings
     WHERE tenant_id = c.tenant_id AND contract_id = c.id AND kind = 'contract'
     ORDER BY starts_at
     FOR UPDATE
  LOOP
    found_segment := false;
    IF occupied THEN
      SELECT s.* INTO segment
        FROM contract_segments(c) AS s
       WHERE s.amendment_id IS NOT DISTINCT FROM existing.contract_amendment_id
         AND s.resource_id IS NOT NULL;
      found_segment := FOUND;
    END IF;

    IF NOT found_segment THEN
      IF existing.status <> 'cancelled' THEN
        UPDATE bookings
           SET status = 'cancelled',
               cancelled_at = now(),
               cancellation_reason = CASE
                 WHEN c.deleted_at IS NOT NULL THEN 'Contrat archivé'
                 WHEN c.status = 'draft' THEN 'Contrat repassé en brouillon'
                 WHEN last_day IS NOT NULL AND last_day < c.starts_on THEN 'Contrat résilié avant son début'
                 WHEN existing.contract_amendment_id IS NULL AND c.resource_id IS NULL
                   THEN 'Ressource retirée du contrat'
                 WHEN existing.contract_amendment_id IS NOT NULL
                   THEN 'Contrat résilié avant la date d''effet de l''avenant'
                 ELSE 'Occupation remplacée par avenant'
               END
         WHERE id = existing.id;
      END IF;
    ELSE
      range_start := segment.starts_on::timestamp AT TIME ZONE centre_time_zone;
      range_end := CASE
        WHEN segment.ends_on IS NULL THEN booking_open_end()
        ELSE (segment.ends_on + 1)::timestamp AT TIME ZONE centre_time_zone
      END;
      IF existing.status <> 'cancelled'
         AND (existing.resource_id <> segment.resource_id
              OR existing.starts_at <> range_start
              OR existing.ends_at <> range_end) THEN
        UPDATE bookings
           SET status = 'cancelled',
               cancelled_at = now(),
               cancellation_reason = 'Occupation en cours de mise à jour'
         WHERE id = existing.id;
      END IF;
    END IF;
  END LOOP;

  -- Passe 2 : écrire chaque segment voulu.
  IF occupied THEN
    FOR segment IN
      SELECT * FROM contract_segments(c) AS s WHERE s.resource_id IS NOT NULL
    LOOP
      range_start := segment.starts_on::timestamp AT TIME ZONE centre_time_zone;
      range_end := CASE
        WHEN segment.ends_on IS NULL THEN booking_open_end()
        ELSE (segment.ends_on + 1)::timestamp AT TIME ZONE centre_time_zone
      END;
      segment_title := CASE
        WHEN segment.amendment_id IS NULL THEN 'Contrat ' || c.reference
        ELSE 'Contrat ' || c.reference || ' — avenant n° ' || segment.amendment_number
      END;

      SELECT * INTO existing FROM bookings
       WHERE tenant_id = c.tenant_id AND contract_id = c.id AND kind = 'contract'
         AND contract_amendment_id IS NOT DISTINCT FROM segment.amendment_id;

      IF NOT FOUND THEN
        INSERT INTO bookings (
          tenant_id, resource_id, contract_id, contract_amendment_id, client_id, kind, channel,
          status, title, starts_at, ends_at
        )
        VALUES (
          c.tenant_id, segment.resource_id, c.id, segment.amendment_id, c.client_id, 'contract',
          'staff', 'confirmed', segment_title, range_start, range_end
        );
      ELSIF existing.status <> 'confirmed'
         OR existing.resource_id <> segment.resource_id
         OR existing.starts_at <> range_start
         OR existing.ends_at <> range_end
         OR existing.client_id IS DISTINCT FROM c.client_id
         OR existing.title <> segment_title THEN
        UPDATE bookings
           SET resource_id = segment.resource_id,
               client_id = c.client_id,
               title = segment_title,
               starts_at = range_start,
               ends_at = range_end,
               status = 'confirmed',
               cancelled_at = NULL,
               cancellation_reason = NULL
         WHERE id = existing.id;
      END IF;
    END LOOP;
  END IF;

  PERFORM set_config('app.contract_occupation_sync', '', true);
END
$$;

--> statement-breakpoint

-- Dernier jour possible d'un contrat si le préavis est donné ce jour-là
-- (R10, ADR 023) : le plus tardif du terme du préavis (jour de la demande
-- compris, comme `noticeEndsOn`) et du dernier jour d'engagement.
CREATE FUNCTION contract_earliest_end_on(p_contract_id uuid, p_notice_on date) RETURNS date
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT greatest(p_notice_on + greatest(k.notice_days - 1, 0), k.commitment_ends_on)
    FROM contracts AS k
   WHERE k.id = p_contract_id
$$;

--> statement-breakpoint

-- Documents de contrat : version attribuée par la base (la suivante du
-- contrat, sous verrou du contrat), empreinte SHA-256 calculée par la base
-- sur la forme canonique de l'instantané (`jsonb::text`, UTF-8). Un document
-- ne change jamais (droits retirés, et garde pour le propriétaire).
CREATE FUNCTION contract_documents_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Un document de contrat remis ne se réécrit pas.' USING ERRCODE = 'CA004';
  END IF;
  PERFORM 1 FROM contracts WHERE tenant_id = NEW.tenant_id AND id = NEW.contract_id FOR NO KEY UPDATE;
  SELECT coalesce(max(version), 0) + 1 INTO NEW.version
    FROM contract_documents
   WHERE tenant_id = NEW.tenant_id AND contract_id = NEW.contract_id;
  NEW.sha256 := encode(sha256(convert_to(NEW.snapshot::text, 'UTF8')), 'hex');
  NEW.created_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER contract_documents_guard
BEFORE INSERT OR UPDATE OR DELETE ON contract_documents
FOR EACH ROW EXECUTE FUNCTION contract_documents_guard();
--> statement-breakpoint
-- Le journal des exports ne se réécrit pas non plus, même par le propriétaire.
CREATE FUNCTION accounting_exports_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Le journal des exports comptables ne se réécrit pas.' USING ERRCODE = 'CA002';
END
$$;
--> statement-breakpoint
CREATE TRIGGER accounting_exports_guard
BEFORE UPDATE OR DELETE ON accounting_exports
FOR EACH ROW EXECUTE FUNCTION accounting_exports_guard();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 10. Plan de comptes par centre (R16, ADR 027)
-- ---------------------------------------------------------------------------
-- Comptes du plan comptable général proposés par défaut, à valider par
-- l'expert-comptable du centre. N'écrase jamais un compte déjà paramétré.
-- SECURITY DEFINER : posé à la création d'un centre, quel que soit le rôle
-- qui le crée. Ne traite que le centre passé en argument.
CREATE FUNCTION seed_accounting_accounts(p_tenant_id uuid) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO accounting_accounts (tenant_id, purpose, line_kind, vat_rate_bp, account_number, label)
  VALUES
    (p_tenant_id, 'customers', NULL, NULL, '411000', 'Clients'),
    (p_tenant_id, 'bank', NULL, NULL, '512000', 'Banque'),
    (p_tenant_id, 'revenue', 'rent', NULL, '706100', 'Prestations : loyers et domiciliation'),
    (p_tenant_id, 'revenue', 'booking', NULL, '706200', 'Prestations : réservations d''espaces'),
    (p_tenant_id, 'revenue', 'package', NULL, '706300', 'Prestations : forfaits de services'),
    (p_tenant_id, 'revenue', 'act', NULL, '706400', 'Prestations : actes'),
    (p_tenant_id, 'revenue', 'discount', NULL, '709000', 'Rabais, remises et ristournes accordés'),
    (p_tenant_id, 'revenue', 'other', NULL, '706000', 'Prestations de services'),
    (p_tenant_id, 'vat_collected', NULL, 2000, '445711', 'TVA collectée à 20 %'),
    (p_tenant_id, 'vat_collected', NULL, 1000, '445712', 'TVA collectée à 10 %'),
    (p_tenant_id, 'vat_collected', NULL, 550, '445713', 'TVA collectée à 5,5 %'),
    (p_tenant_id, 'vat_collected', NULL, 210, '445714', 'TVA collectée à 2,1 %')
  ON CONFLICT ON CONSTRAINT accounting_accounts_key DO NOTHING
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION seed_accounting_accounts(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION tenants_seed_accounting_accounts() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM seed_accounting_accounts(NEW.id);
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tenants_seed_accounting_accounts() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER tenants_seed_accounting_accounts
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION tenants_seed_accounting_accounts();
--> statement-breakpoint
SELECT seed_accounting_accounts(id) FROM tenants;
