-- Correctifs de la vague 2 (ADR 032) : ce que la revue de la facturation a
-- trouvé, tenu par la base comme le reste (ADR 026).
--
-- 1. Un avenant de prix ne se signe pas sur une période déjà facturée : la
--    période serait due une seconde fois, aux lignes de la nouvelle version
--    (CA005). `contract_billed_through()` dit jusqu'où un contrat est facturé.
-- 2. Une version de prix ne facture jamais un jour qu'une autre version du
--    même contrat tient déjà, quelle que soit la clé de la ligne (CA003) ; un
--    loyer global se facture à côté des lignes ponctuelles de sa version.
-- 3. Un avoir qui solde une ligne en crédite exactement la TVA restante : le
--    cumul des avoirs retombe sur le TTC de la facture.
-- 4. Une ligne exonérée (catégorie autre que S et Z) ne s'émet pas sans son
--    motif (EN 16931, BT-120) (CA003).
--
-- Les fonctions remplacées gardent leur signature : les triggers de la
-- migration 0031 les appellent toujours.

-- ---------------------------------------------------------------------------
-- 1. Dernier jour facturé d'un contrat, et signature d'un avenant
-- ---------------------------------------------------------------------------
-- Loyers et lignes du contrat (hors forfaits souscrits) que tient encore une
-- facture : émise ou brouillon, ni retirés ni libérés par un avoir. Nul : rien.
-- Sous le rôle appelant, donc sous ses politiques.
CREATE FUNCTION contract_billed_through(p_contract_id uuid) RETURNS date
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT max(l.period_end)
    FROM invoice_lines AS l
   WHERE l.contract_id = p_contract_id
     AND l.kind IN ('rent', 'package')
     AND l.subscribed_service_id IS NULL
     AND l.period_start IS NOT NULL
     AND l.deleted_at IS NULL
     AND l.released_at IS NULL
$$;

--> statement-breakpoint

-- Un avenant peut-il être signé ? Refus (CA005) : contrat qui n'est pas en
-- cours ; date d'effet qui n'est pas strictement après le premier jour du
-- contrat, qui suit son dernier jour, ou qui ne suit pas le dernier avenant
-- signé ; avenant qui ne change rien ; avenant de prix qui prend effet sur
-- une période déjà facturée (ADR 032) — un avenant de ressource seule ne
-- change pas ce qui est dû, il reste permis.
CREATE OR REPLACE FUNCTION contract_amendment_assert_signable(a contract_amendments, c contracts) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  last_day date := least(c.ends_on, c.terminated_on);
  billed_through date;
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
  IF a.amount_cents IS NOT NULL OR EXISTS (
    SELECT 1 FROM contract_lines AS l
     WHERE l.tenant_id = a.tenant_id AND l.amendment_id = a.id AND l.deleted_at IS NULL
  ) THEN
    billed_through := contract_billed_through(c.id);
    IF billed_through IS NOT NULL AND a.effective_on <= billed_through THEN
      RAISE EXCEPTION 'Le contrat % est déjà facturé jusqu''au % : un nouveau prix prend effet au plus tôt le %. Pour revenir sur une période facturée, établissez d''abord un avoir, ou retirez la ligne du brouillon de facture.',
        c.reference, to_char(billed_through, 'DD/MM/YYYY'), to_char(billed_through + 1, 'DD/MM/YYYY')
        USING ERRCODE = 'CA005';
    END IF;
  END IF;
END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Garde des lignes de facture
-- ---------------------------------------------------------------------------
-- Celle de la migration 0031, avec trois changements (ADR 032) :
--
-- - le contrat d'un loyer ou d'un forfait de contrat est verrouillé en
--   partage : la signature d'un avenant (qui le verrouille en écriture)
--   attend la facturation en cours, et inversement ;
-- - un loyer global (sans ligne de contrat) se facture quand sa version n'a
--   aucune ligne **récurrente** : ses lignes ponctuelles (frais de dossier)
--   ne le remplacent pas ;
-- - une ligne de loyer ou de forfait de contrat ne recouvre aucun jour qu'une
--   ligne vivante d'une **autre version** du contrat tient déjà. La contrainte
--   d'exclusion de la migration 0031 porte sur la clé (contrat, ligne de
--   contrat) : sans ce contrôle, un avenant signé après la facturation de sa
--   période la ferait facturer une seconde fois sous d'autres clés.
CREATE OR REPLACE FUNCTION invoice_lines_guard() RETURNS trigger
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
      -- Verrou partagé : un avenant ne se signe pas pendant qu'on facture ce
      -- contrat, et la ligne voit les avenants signés avant elle.
      PERFORM 1 FROM contracts
        WHERE tenant_id = NEW.tenant_id AND id = NEW.contract_id
          AND status IN ('active', 'terminated') AND deleted_at IS NULL
        FOR SHARE;
      IF NOT FOUND THEN
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
           AND is_recurring
      ) THEN
        RAISE EXCEPTION 'Ce contrat a des lignes récurrentes sur cette période : facturez-les ligne à ligne (contract_line_id).'
          USING ERRCODE = 'CA003';
      END IF;

      -- Aucun jour déjà tenu par une autre version du contrat. La version
      -- d'une ligne existante : celle de sa ligne de contrat, ou, pour un
      -- loyer global, celle en vigueur sur son premier jour.
      IF NEW.deleted_at IS NULL AND EXISTS (
        SELECT 1
          FROM invoice_lines AS e
          LEFT JOIN contract_lines AS el ON el.tenant_id = e.tenant_id AND el.id = e.contract_line_id
         WHERE e.tenant_id = NEW.tenant_id
           AND e.contract_id = NEW.contract_id
           AND e.id <> NEW.id
           AND e.kind IN ('rent', 'package')
           AND e.subscribed_service_id IS NULL
           AND e.period_start IS NOT NULL
           AND e.deleted_at IS NULL
           AND e.released_at IS NULL
           AND daterange(e.period_start, e.period_end, '[]') && daterange(NEW.period_start, NEW.period_end, '[]')
           AND (CASE
                  WHEN e.contract_line_id IS NOT NULL THEN el.amendment_id
                  ELSE (SELECT v.amendment_id
                          FROM contract_price_versions(NEW.contract_id) AS v
                         WHERE v.starts_on <= e.period_start
                         ORDER BY v.starts_on DESC
                         LIMIT 1)
                END) IS DISTINCT FROM v_version_amendment
      ) THEN
        RAISE EXCEPTION 'Ces jours du contrat sont déjà facturés par une autre version de son prix : un avenant ne refacture pas une période facturée. Établissez d''abord un avoir.'
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

-- ---------------------------------------------------------------------------
-- 3. TVA d'un avoir qui solde une ligne
-- ---------------------------------------------------------------------------
-- Comme en 0031, la TVA se calcule par catégorie et par taux sur la somme des
-- bases, et l'écart d'arrondi va à la ligne de plus forte valeur absolue.
--
-- Sauf, dans un avoir, pour les lignes qui **soldent** une ligne de la
-- facture corrigée (le net crédité, avoirs émis compris, égale son net, au
-- même taux et dans la même catégorie) : elles en créditent exactement la TVA
-- restante — la TVA de la ligne d'origine moins celle que les avoirs émis ont
-- déjà créditée. Recalculée sur sa seule base, la TVA de chaque avoir
-- s'arrondirait pour son compte, et le cumul des avoirs ne retomberait pas
-- sur le TTC de la facture : deux avoirs de 33,33 € HT à 20 % font 80,00 €
-- pour une facture de 79,99 €. Les autres lignes de l'avoir suivent la règle
-- commune, par taux.
CREATE OR REPLACE FUNCTION invoice_refresh_amounts(p_invoice_id uuid) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status invoice_status;
  v_kind invoice_kind;
  v_deleted_at timestamptz;
BEGIN
  SELECT status, kind, deleted_at INTO v_status, v_kind, v_deleted_at FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND OR v_status <> 'draft' OR v_deleted_at IS NOT NULL THEN
    RETURN;
  END IF;

  PERFORM set_config('app.invoice_amounts_sync', 'on', true);

  WITH lines AS (
    SELECT l.id,
           l.net_amount_cents AS net,
           l.vat_rate_bp AS rate,
           l.vat_category AS category,
           l.position,
           l.credited_line_id,
           vat_amount_cents(l.net_amount_cents, l.vat_rate_bp) AS line_vat
      FROM invoice_lines AS l
     WHERE l.invoice_id = p_invoice_id AND l.deleted_at IS NULL
  ), settled AS (
    -- Lignes d'origine que cet avoir solde, et la TVA qu'il leur reste.
    SELECT o.id AS original_id,
           o.vat_amount_cents - coalesce(prev.vat, 0) AS vat_due
      FROM lines
      JOIN invoice_lines AS o ON o.id = lines.credited_line_id
      LEFT JOIN LATERAL (
        SELECT sum(cl.net_amount_cents) AS net, sum(cl.vat_amount_cents) AS vat
          FROM invoice_lines AS cl
          JOIN invoices AS cn ON cn.tenant_id = cl.tenant_id AND cn.id = cl.invoice_id
         WHERE cl.tenant_id = o.tenant_id AND cl.credited_line_id = o.id
           AND cl.deleted_at IS NULL AND cn.kind = 'credit_note' AND cn.status <> 'draft'
      ) AS prev ON true
     WHERE v_kind = 'credit_note'
     GROUP BY o.id, o.net_amount_cents, o.vat_amount_cents, o.vat_rate_bp, o.vat_category, prev.net, prev.vat
    HAVING sum(lines.net) + coalesce(prev.net, 0) = o.net_amount_cents
       AND bool_and(lines.rate = o.vat_rate_bp AND lines.category = o.vat_category)
  ), keyed AS (
    -- Groupe de calcul : la ligne d'origine soldée, ou la catégorie et le taux.
    SELECT lines.*,
           coalesce('solde:' || settled.original_id::text,
                    'taux:' || lines.category::text || ':' || lines.rate::text) AS grp,
           settled.vat_due
      FROM lines
      LEFT JOIN settled ON settled.original_id = lines.credited_line_id
  ), ranked AS (
    SELECT keyed.*,
           row_number() OVER (PARTITION BY grp ORDER BY abs(net) DESC, position, id) AS rank
      FROM keyed
  ), groups AS (
    SELECT grp,
           coalesce(max(vat_due), vat_amount_cents(sum(net), max(rate))) - sum(line_vat) AS gap
      FROM ranked
     GROUP BY grp
  ), target AS (
    SELECT ranked.id,
           ranked.net,
           (ranked.line_vat + CASE WHEN ranked.rank = 1 THEN groups.gap ELSE 0 END)::integer AS vat
      FROM ranked JOIN groups USING (grp)
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

-- ---------------------------------------------------------------------------
-- 4. Émission : le motif d'exonération est une mention obligatoire
-- ---------------------------------------------------------------------------
-- Celle de la migration 0031, avec une mention de plus : une ligne vivante
-- d'une catégorie qui appelle un motif d'exonération (EN 16931, BT-120 :
-- E, AE, K, G, O ; pas S ni Z, BR-S-10 et BR-Z-10) ne s'émet pas sans lui.
CREATE OR REPLACE FUNCTION issue_invoice(p_invoice_id uuid, p_issued_by uuid DEFAULT NULL) RETURNS text
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
  IF EXISTS (
    SELECT 1 FROM invoice_lines
     WHERE invoice_id = v_invoice.id AND deleted_at IS NULL
       AND vat_category NOT IN ('S', 'Z')
       AND nullif(btrim(vat_exemption_reason), '') IS NULL
  ) THEN
    v_missing := array_append(v_missing, 'motif d''exonération de TVA des lignes sans taux');
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
