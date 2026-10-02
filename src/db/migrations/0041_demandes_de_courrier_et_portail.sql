-- Vague 3 (ADR 036, 037) : ce que Drizzle ne sait pas décrire pour les
-- demandes de courrier et la réservation depuis l'espace client.
--
-- 1. `mail_requests` : isolation par centre, portée client, pas de
--    suppression.
-- 2. Reprise des demandes d'ouverture portées par `mail_items`, puis le même
--    geste à chaque pli inséré avec une demande (import, tests).
-- 3. Le résumé `mail_items.status` / `opening_requested_*` n'est plus écrit
--    que par la base, depuis la demande d'ouverture en cours (CA008).
-- 4. Transitions des demandes, dates posées par la base, portée client
--    (CA008) ; l'ouverture d'un pli clôt sa demande, son retrait refuse les
--    demandes en cours.
-- 5. Facturation : une demande faite est une source unique de lignes de
--    facture, hors avoir (CA003).
-- 6. Réservation depuis l'espace client : réglage par ressource, auteur,
--    annulation par le client tracée (CA009).
--
-- Mêmes règles que les migrations 0026 et 0031 : RLS en ENABLE et FORCE,
-- `search_path` figé, drapeau de session pour les écritures tenues par la
-- base (`app.mail_request_sync`), sauvegardé puis restauré.

-- ---------------------------------------------------------------------------
-- 1. Demandes de courrier : isolation
-- ---------------------------------------------------------------------------
ALTER TABLE mail_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mail_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY mail_requests_tenant_isolation ON mail_requests
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
--> statement-breakpoint
-- Portée client (ADR 019) : une entreprise ne voit et n'écrit que les
-- demandes de ses plis. RESTRICTIVE : en ET avec l'isolation par centre.
CREATE POLICY mail_requests_client_scope ON mail_requests AS RESTRICTIVE
  USING (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()))
  WITH CHECK (current_client_ids() IS NULL OR client_id = ANY (current_client_ids()));
--> statement-breakpoint
-- Une demande ne se supprime pas : elle s'annule ou se refuse (décision 6).
REVOKE DELETE, TRUNCATE ON mail_requests FROM app_centre;
--> statement-breakpoint
CREATE TRIGGER mail_requests_set_updated_at
BEFORE UPDATE ON mail_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

--> statement-breakpoint

-- Service du catalogue qui facture une demande faite (ADR 037). Une ouverture
-- n'en a pas : elle se facture par son pli (`courrier.ouverture`).
-- Miroir : `serviceCodes` (src/modules/facturation/schema.ts).
CREATE FUNCTION mail_request_service_code(p_kind mail_request_kind) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_kind
    WHEN 'scan' THEN 'courrier.numerisation'
    WHEN 'forward' THEN 'courrier.reexpedition'
    ELSE NULL
  END
$$;

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Reprise : la demande d'ouverture d'un pli devient une ligne de demande
-- ---------------------------------------------------------------------------
-- Un pli qui porte `opening_requested_at` a reçu une demande d'ouverture :
--
-- - encore fermé : la demande est en cours (`requested`) ;
-- - ouvert depuis : elle est faite, à la date et par l'auteur de l'ouverture ;
-- - retiré sans avoir été ouvert : elle est refusée, et le résumé du pli
--   revient à `received`.
--
-- Idempotente : une demande déjà reprise (même pli, même date) ne l'est pas
-- deux fois. Sert à la reprise ci-dessous et, par le trigger
-- `mail_items_adopt_requests`, à tout pli inséré avec une demande.
CREATE FUNCTION mail_item_adopt_requests(m mail_items) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_previous text := coalesce(current_setting('app.mail_request_sync', true), '');
  v_withdrawn boolean := m.opened_at IS NULL AND m.deleted_at IS NOT NULL;
BEGIN
  IF m.opening_requested_at IS NULL OR m.opening_requested_by IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM mail_requests
     WHERE tenant_id = m.tenant_id AND mail_item_id = m.id
       AND kind = 'open_and_scan' AND requested_at = m.opening_requested_at
  ) THEN
    RETURN;
  END IF;

  PERFORM set_config('app.mail_request_sync', 'on', true);
  INSERT INTO mail_requests (
    tenant_id, mail_item_id, client_id, kind, status, requested_at, requested_by_member_id,
    completed_at, completed_by_staff_id, refused_at, refusal_reason
  ) VALUES (
    m.tenant_id, m.id, m.client_id, 'open_and_scan',
    CASE
      WHEN m.opened_at IS NOT NULL THEN 'done'
      WHEN v_withdrawn THEN 'refused'
      ELSE 'requested'
    END::mail_request_status,
    m.opening_requested_at, m.opening_requested_by,
    m.opened_at, m.opened_by,
    CASE WHEN v_withdrawn THEN m.deleted_at END,
    CASE WHEN v_withdrawn THEN 'Courrier retiré : enregistré par erreur.' END
  );
  IF v_withdrawn THEN
    UPDATE mail_items
       SET status = 'received', opening_requested_at = NULL, opening_requested_by = NULL
     WHERE tenant_id = m.tenant_id AND id = m.id;
  END IF;
  PERFORM set_config('app.mail_request_sync', v_previous, true);
END
$$;

--> statement-breakpoint

-- `updated_at` des plis n'est pas touché par la reprise.
ALTER TABLE mail_items DISABLE TRIGGER mail_items_set_updated_at;
--> statement-breakpoint
DO $$
DECLARE
  m mail_items%ROWTYPE;
BEGIN
  FOR m IN
    SELECT * FROM mail_items WHERE opening_requested_at IS NOT NULL ORDER BY opening_requested_at, id
  LOOP
    PERFORM mail_item_adopt_requests(m);
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE mail_items ENABLE TRIGGER mail_items_set_updated_at;

--> statement-breakpoint

CREATE FUNCTION mail_items_adopt_requests() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM mail_item_adopt_requests(NEW);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER mail_items_adopt_requests
AFTER INSERT ON mail_items
FOR EACH ROW
WHEN (NEW.opening_requested_at IS NOT NULL)
EXECUTE FUNCTION mail_items_adopt_requests();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Le résumé de la demande d'ouverture sur le pli est tenu par la base
-- ---------------------------------------------------------------------------
-- `mail_items.status = 'opening_requested'` et `opening_requested_*` disent
-- qu'une demande d'ouverture est en cours (la file de l'accueil, le compteur
-- de la navigation, l'origine au relevé). Ils suivent `mail_requests` : le
-- code dépose, annule ou refuse la demande, jamais le résumé. Sans ce garde,
-- remettre le résumé à `received` effacerait encore la demande sans trace —
-- le défaut que la vague corrige. L'ouverture (`received` ou
-- `opening_requested` → `opened`) reste au code.
CREATE FUNCTION mail_items_guard_request_summary() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(current_setting('app.mail_request_sync', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.opening_requested_at IS DISTINCT FROM OLD.opening_requested_at
     OR NEW.opening_requested_by IS DISTINCT FROM OLD.opening_requested_by
     OR (NEW.status = 'opening_requested' AND OLD.status <> 'opening_requested')
     OR (OLD.status = 'opening_requested' AND NEW.status = 'received') THEN
    RAISE EXCEPTION 'La demande d''ouverture d''un pli se dépose, s''annule ou se refuse dans mail_requests : son résumé sur le pli est tenu par la base.'
      USING ERRCODE = 'CA008',
            HINT = 'Insérer une demande open_and_scan, ou passer la demande en cours à cancelled ou refused.';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER mail_items_guard_request_summary
BEFORE UPDATE ON mail_items
FOR EACH ROW EXECUTE FUNCTION mail_items_guard_request_summary();

--> statement-breakpoint

-- Le résumé suit la demande d'ouverture : déposée, le pli est
-- `opening_requested` ; annulée ou refusée, il redevient `received`. Faite,
-- il est déjà `opened` (l'ouverture l'a clôturée, section 4). Idempotent.
CREATE FUNCTION mail_requests_sync_item() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_previous text := coalesce(current_setting('app.mail_request_sync', true), '');
BEGIN
  IF NEW.kind <> 'open_and_scan' THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.mail_request_sync', 'on', true);
  IF NEW.status IN ('requested', 'in_progress') THEN
    UPDATE mail_items
       SET status = 'opening_requested',
           opening_requested_at = NEW.requested_at,
           opening_requested_by = NEW.requested_by_member_id
     WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_item_id
       AND opened_at IS NULL
       AND (status, opening_requested_at, opening_requested_by)
           IS DISTINCT FROM ('opening_requested'::mail_status, NEW.requested_at, NEW.requested_by_member_id);
  ELSIF NEW.status IN ('cancelled', 'refused') THEN
    UPDATE mail_items
       SET status = 'received', opening_requested_at = NULL, opening_requested_by = NULL
     WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_item_id
       AND status = 'opening_requested'
       AND opening_requested_at = NEW.requested_at;
  END IF;
  PERFORM set_config('app.mail_request_sync', v_previous, true);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER mail_requests_sync_item
AFTER INSERT OR UPDATE OF status ON mail_requests
FOR EACH ROW EXECUTE FUNCTION mail_requests_sync_item();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Transitions des demandes
-- ---------------------------------------------------------------------------
-- Garde de `mail_requests` (CA008) :
--
-- - une demande naît `requested`, datée par la base (`requested_at`), sur un
--   pli ni retiré ni réexpédié ; une ouverture sur un pli fermé, une
--   numérisation seule sur un pli ouvert ; sous portée client, au nom d'une
--   personne de l'entreprise ;
-- - ne changent jamais : pli, client, nature, date et auteur de la demande,
--   consigne, adresse de réexpédition figée ;
-- - transitions : `requested` → `in_progress` (prise en charge) ;
--   `requested`/`in_progress` → `done` (faite) ou `refused` (motif) ;
--   `requested` → `cancelled`. Chaque date est posée par la base, l'auteur
--   est exigé. Une ouverture se clôt pli ouvert ; une réexpédition, la
--   dernière, quand plus aucune autre demande n'attend sur le pli ;
-- - sous portée client, seule l'annulation d'une demande `requested`, par une
--   personne de l'entreprise ;
-- - faite, une réexpédition garde la main sur ses frais et son numéro de
--   suivi tant qu'aucune facture ne la tient ; tout le reste est figé.
--
-- Le drapeau `app.mail_request_sync` laisse passer les écritures de la base
-- elle-même (reprise, ouverture, retrait), `app.anonymization` celles de
-- l'anonymisation (ADR 040).
CREATE FUNCTION mail_requests_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_client_space boolean;
  v_item mail_items%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Une demande de courrier ne se supprime pas : elle s''annule ou se refuse, et sa trace reste.'
      USING ERRCODE = 'CA008';
  END IF;
  IF coalesce(current_setting('app.mail_request_sync', true), '') = 'on'
     OR coalesce(current_setting('app.anonymization', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  v_client_space := current_client_ids() IS NOT NULL AND NEW.client_id = ANY (current_client_ids());

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested'
       OR num_nonnulls(NEW.started_at, NEW.started_by_staff_id, NEW.completed_at,
                       NEW.completed_by_staff_id, NEW.refused_at, NEW.refused_by_staff_id,
                       NEW.refusal_reason, NEW.cancelled_at, NEW.cancelled_by_member_id,
                       NEW.cancelled_by_staff_id, NEW.postage_cents, NEW.postage_currency,
                       NEW.forward_tracking_number) > 0 THEN
      RAISE EXCEPTION 'Une demande de courrier naît « demandée » : sa prise en charge, sa réalisation, son refus ou son annulation viennent ensuite.'
        USING ERRCODE = 'CA008';
    END IF;
    IF v_client_space AND (NEW.requested_by_member_id IS NULL OR NEW.requested_by_staff_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Depuis l''espace client, une demande porte la personne de l''entreprise qui la dépose.'
        USING ERRCODE = 'CA008';
    END IF;
    NEW.requested_at := now();

    SELECT * INTO v_item FROM mail_items
     WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_item_id
     FOR SHARE;
    IF NOT FOUND THEN
      -- La clé étrangère le dira, avec son propre code.
      RETURN NEW;
    END IF;
    IF v_item.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Ce courrier a été retiré : aucune demande ne s''y dépose.' USING ERRCODE = 'CA008';
    END IF;
    IF EXISTS (
      SELECT 1 FROM mail_requests
       WHERE tenant_id = NEW.tenant_id AND mail_item_id = NEW.mail_item_id
         AND kind = 'forward' AND status = 'done'
    ) THEN
      RAISE EXCEPTION 'Ce courrier a été réexpédié : il n''est plus au centre.' USING ERRCODE = 'CA008';
    END IF;
    IF NEW.kind = 'open_and_scan' AND v_item.opened_at IS NOT NULL THEN
      RAISE EXCEPTION 'Ce courrier est déjà ouvert : demandez une numérisation.' USING ERRCODE = 'CA008';
    END IF;
    IF NEW.kind = 'scan' AND v_item.opened_at IS NULL THEN
      RAISE EXCEPTION 'Ce courrier est encore fermé : demandez son ouverture et sa numérisation.'
        USING ERRCODE = 'CA008';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF (NEW.id, NEW.tenant_id, NEW.mail_item_id, NEW.client_id, NEW.kind, NEW.requested_at,
      NEW.requested_by_member_id, NEW.requested_by_staff_id, NEW.client_note)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.mail_item_id, OLD.client_id, OLD.kind, OLD.requested_at,
      OLD.requested_by_member_id, OLD.requested_by_staff_id, OLD.client_note) THEN
    RAISE EXCEPTION 'Une demande ne change ni de pli, ni de nature, ni de date, ni d''auteur, ni de consigne.'
      USING ERRCODE = 'CA008';
  END IF;
  IF (NEW.forward_recipient, NEW.forward_address_line1, NEW.forward_address_line2,
      NEW.forward_postal_code, NEW.forward_city, NEW.forward_country)
     IS DISTINCT FROM
     (OLD.forward_recipient, OLD.forward_address_line1, OLD.forward_address_line2,
      OLD.forward_postal_code, OLD.forward_city, OLD.forward_country) THEN
    RAISE EXCEPTION 'L''adresse de réexpédition est figée à la demande : pour une autre adresse, annulez et déposez une nouvelle demande.'
      USING ERRCODE = 'CA008';
  END IF;

  IF NEW.status = OLD.status THEN
    IF to_jsonb(NEW) - 'updated_at' = to_jsonb(OLD) - 'updated_at' THEN
      RETURN NEW;
    END IF;
    IF NOT v_client_space AND OLD.status = 'done' AND OLD.kind = 'forward'
       AND to_jsonb(NEW) - '{postage_cents,postage_currency,forward_tracking_number,updated_at}'::text[]
           = to_jsonb(OLD) - '{postage_cents,postage_currency,forward_tracking_number,updated_at}'::text[] THEN
      IF (NEW.postage_cents, NEW.postage_currency) IS DISTINCT FROM (OLD.postage_cents, OLD.postage_currency)
         AND EXISTS (
           SELECT 1 FROM invoice_lines
            WHERE tenant_id = OLD.tenant_id AND mail_request_id = OLD.id
              AND deleted_at IS NULL AND released_at IS NULL
         ) THEN
        RAISE EXCEPTION 'Cette réexpédition est facturée : ses frais ne changent plus. Établissez d''abord un avoir, ou retirez la ligne du brouillon.'
          USING ERRCODE = 'CA008';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Cette demande est « % » : elle ne se modifie plus ainsi.', OLD.status
      USING ERRCODE = 'CA008';
  END IF;

  IF v_client_space AND NOT (
       OLD.status = 'requested' AND NEW.status = 'cancelled'
       AND NEW.cancelled_by_member_id IS NOT NULL AND NEW.cancelled_by_staff_id IS NULL
     ) THEN
    RAISE EXCEPTION 'Depuis l''espace client, une demande ne peut qu''être annulée, tant que le centre ne l''a pas prise en charge.'
      USING ERRCODE = 'CA008';
  END IF;

  IF OLD.status = 'requested' AND NEW.status = 'in_progress' THEN
    IF NEW.started_by_staff_id IS NULL THEN
      RAISE EXCEPTION 'La prise en charge d''une demande porte son auteur.' USING ERRCODE = 'CA008';
    END IF;
    NEW.started_at := now();
  ELSIF OLD.status IN ('requested', 'in_progress') AND NEW.status = 'done' THEN
    IF NEW.completed_by_staff_id IS NULL THEN
      RAISE EXCEPTION 'Une demande faite porte l''auteur de sa réalisation.' USING ERRCODE = 'CA008';
    END IF;
    NEW.completed_at := now();
    SELECT * INTO v_item FROM mail_items
     WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_item_id
     FOR SHARE;
    IF v_item.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Ce courrier a été retiré : la demande se refuse.' USING ERRCODE = 'CA008';
    END IF;
    IF NEW.kind = 'open_and_scan' AND v_item.opened_at IS NULL THEN
      RAISE EXCEPTION 'Ouvrez le pli : sa demande d''ouverture se clôt avec l''ouverture.' USING ERRCODE = 'CA008';
    END IF;
    IF NEW.kind = 'forward' AND EXISTS (
      SELECT 1 FROM mail_requests
       WHERE tenant_id = NEW.tenant_id AND mail_item_id = NEW.mail_item_id
         AND id <> NEW.id AND status IN ('requested', 'in_progress')
    ) THEN
      RAISE EXCEPTION 'D''autres demandes attendent sur ce pli : traitez-les ou refusez-les avant de le réexpédier, il quittera le centre.'
        USING ERRCODE = 'CA008';
    END IF;
  ELSIF OLD.status IN ('requested', 'in_progress') AND NEW.status = 'refused' THEN
    IF NEW.refused_by_staff_id IS NULL THEN
      RAISE EXCEPTION 'Un refus porte son auteur et son motif.' USING ERRCODE = 'CA008';
    END IF;
    NEW.refused_at := now();
  ELSIF OLD.status = 'requested' AND NEW.status = 'cancelled' THEN
    NEW.cancelled_at := now();
  ELSE
    RAISE EXCEPTION 'Une demande « % » ne passe pas à « % ».', OLD.status, NEW.status
      USING ERRCODE = 'CA008',
            HINT = 'requested → in_progress → done ; requested ou in_progress → refused ; requested → cancelled.';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER mail_requests_guard
BEFORE INSERT OR UPDATE OR DELETE ON mail_requests
FOR EACH ROW EXECUTE FUNCTION mail_requests_guard();

--> statement-breakpoint

-- Le pli décide de ses demandes en cours :
--
-- - ouvert (`opened_at` posé) : sa demande d'ouverture en cours est faite, à
--   la date et par l'auteur de l'ouverture ;
-- - retiré (`deleted_at` posé) : ses demandes en cours sont refusées par la
--   base, sans auteur, motif « Courrier retiré ».
CREATE FUNCTION mail_items_follow_requests() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_previous text := coalesce(current_setting('app.mail_request_sync', true), '');
BEGIN
  PERFORM set_config('app.mail_request_sync', 'on', true);
  IF OLD.opened_at IS NULL AND NEW.opened_at IS NOT NULL THEN
    UPDATE mail_requests
       SET status = 'done', completed_at = NEW.opened_at, completed_by_staff_id = NEW.opened_by
     WHERE tenant_id = NEW.tenant_id AND mail_item_id = NEW.id
       AND kind = 'open_and_scan' AND status IN ('requested', 'in_progress');
  END IF;
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    UPDATE mail_requests
       SET status = 'refused', refused_at = now(), refused_by_staff_id = NULL,
           refusal_reason = 'Courrier retiré : enregistré par erreur.'
     WHERE tenant_id = NEW.tenant_id AND mail_item_id = NEW.id
       AND status IN ('requested', 'in_progress');
  END IF;
  PERFORM set_config('app.mail_request_sync', v_previous, true);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER mail_items_follow_requests
AFTER UPDATE OF opened_at, deleted_at ON mail_items
FOR EACH ROW EXECUTE FUNCTION mail_items_follow_requests();

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Facturation des demandes (R14, R21, ADR 037)
-- ---------------------------------------------------------------------------
-- Garde des lignes de facture : celle de la migration 0032, plus la source
-- `mail_request_id` :
--
-- - jamais sur une ligne d'avoir, jamais avec `mail_item_id` (contrainte) ;
-- - sur une ligne `act` (le service de la nature : `courrier.numerisation`,
--   `courrier.reexpedition`) ou `other` (frais d'affranchissement relevés
--   d'une réexpédition, refacturés au centime : quantité 1, prix = frais,
--   sans remise ni prorata, dans la devise de la facture) ;
-- - la demande est celle du client facturé, faite, et n'est pas une
--   ouverture (qui se facture par son pli) ;
-- - la demande est verrouillée en partage : ses frais ne changent pas pendant
--   qu'on la facture.
--
-- L'unicité (un acte et des frais au plus par demande, hors avoir) est tenue
-- par l'index `invoice_lines_mail_request_key` (migration 0040).
CREATE OR REPLACE FUNCTION invoice_lines_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice invoices%ROWTYPE;
  v_request mail_requests%ROWTYPE;
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
                    NEW.subscribed_service_id, NEW.mail_item_id, NEW.mail_request_id) > 0 THEN
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
       OR (NEW.mail_request_id IS NOT NULL AND v_kind NOT IN ('act', 'other'))
       OR (NEW.contract_line_id IS NOT NULL AND v_kind NOT IN ('rent', 'package'))
       OR (NEW.subscribed_service_id IS NOT NULL AND v_kind NOT IN ('package', 'act')) THEN
      RAISE EXCEPTION 'Ligne de facture incohérente : une ligne « % » ne porte pas cette source.', v_kind
        USING ERRCODE = 'CA003',
              HINT = 'rent : contrat et période ; booking : réservation ; act : service (et pli ou demande) ; package : souscription ou ligne de contrat, et période ; other : frais d''une demande.';
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

    -- Demande de courrier faite (ADR 037).
    IF NEW.mail_request_id IS NOT NULL THEN
      SELECT * INTO v_request FROM mail_requests
       WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_request_id
       FOR SHARE;
      IF FOUND THEN
        IF v_request.client_id IS DISTINCT FROM v_invoice.client_id THEN
          RAISE EXCEPTION 'Cette demande de courrier n''est pas celle du client facturé.' USING ERRCODE = 'CA003';
        END IF;
        IF v_request.kind = 'open_and_scan' THEN
          RAISE EXCEPTION 'Une ouverture se facture par son pli (mail_item_id), jamais par sa demande.'
            USING ERRCODE = 'CA003';
        END IF;
        IF v_request.status <> 'done' THEN
          RAISE EXCEPTION 'Seule une demande faite se facture : celle-ci est « % ».', v_request.status
            USING ERRCODE = 'CA003';
        END IF;
        IF v_kind = 'act' THEN
          IF NOT EXISTS (
            SELECT 1 FROM services
             WHERE tenant_id = NEW.tenant_id AND id = NEW.service_id
               AND code = mail_request_service_code(v_request.kind)
          ) THEN
            RAISE EXCEPTION 'Cette demande se facture avec le service « % ».', mail_request_service_code(v_request.kind)
              USING ERRCODE = 'CA003';
          END IF;
        ELSE
          IF v_request.kind <> 'forward' OR v_request.postage_cents IS NULL THEN
            RAISE EXCEPTION 'Seuls les frais d''affranchissement relevés d''une réexpédition se facturent ainsi.'
              USING ERRCODE = 'CA003';
          END IF;
          IF NEW.quantity <> 1
             OR NEW.unit_price_cents <> v_request.postage_cents
             OR num_nonnulls(NEW.discount_bp, NEW.discount_amount_cents, NEW.prorata_numerator) > 0
             OR v_request.postage_currency <> v_invoice.currency THEN
            RAISE EXCEPTION 'Les frais d''affranchissement se refacturent tels que relevés : % centimes (%), une fois, sans remise.',
              v_request.postage_cents, v_request.postage_currency
              USING ERRCODE = 'CA003';
          END IF;
        END IF;
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
-- 6. Réservation depuis l'espace client (R23, ADR 016 D4, ADR 036)
-- ---------------------------------------------------------------------------
-- Casiers et boîtes aux lettres se louent par contrat (ADR 018) : fermés au
-- portail dès la reprise. Les autres ressources gardent la valeur prudente,
-- `approval`. `updated_at` n'est pas touché.
ALTER TABLE resources DISABLE TRIGGER resources_set_updated_at;
--> statement-breakpoint
UPDATE resources SET client_booking_mode = 'closed'
 WHERE resource_type IN ('casier', 'boite_aux_lettres');
--> statement-breakpoint
ALTER TABLE resources ENABLE TRIGGER resources_set_updated_at;

--> statement-breakpoint

-- Une réservation qui porte la personne qui l'a faite depuis son espace
-- (`booked_by_member_id`) suit le réglage de sa ressource :
--
-- - `closed`, ressource inactive ou archivée : refusée (CA009) ;
-- - `instant` avec un devis figé (`quoted_at`) : confirmée d'emblée ;
-- - sinon : en attente de l'accueil (`pending`).
--
-- Le statut est **posé par la base**, quel que soit celui que le code a
-- écrit : un changement de réglage pendant la saisie ne confirme rien par
-- surprise. Le code lit le statut rendu (`returning`) pour dire au client si
-- c'est une demande ou une réservation.
CREATE FUNCTION bookings_apply_client_booking_mode() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_resource resources%ROWTYPE;
BEGIN
  IF NEW.booked_by_member_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_resource FROM resources WHERE tenant_id = NEW.tenant_id AND id = NEW.resource_id;
  IF NOT FOUND THEN
    -- La clé étrangère le dira, avec son propre code.
    RETURN NEW;
  END IF;
  IF v_resource.client_booking_mode = 'closed'
     OR v_resource.status <> 'active'
     OR v_resource.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION '« % » ne se réserve pas depuis l''espace client : contactez le centre.', v_resource.name
      USING ERRCODE = 'CA009';
  END IF;
  NEW.status := CASE
    WHEN v_resource.client_booking_mode = 'instant' AND NEW.quoted_at IS NOT NULL THEN 'confirmed'
    ELSE 'pending'
  END::booking_status;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER bookings_apply_client_booking_mode
BEFORE INSERT ON bookings
FOR EACH ROW EXECUTE FUNCTION bookings_apply_client_booking_mode();

--> statement-breakpoint

-- Garde des réservations du portail (CA009) :
--
-- - l'auteur d'une réservation du portail ne change pas ;
-- - une annulation au nom d'une personne de l'entreprise
--   (`cancelled_by_member_id`) ne vaut que pour une demande en attente, pas
--   commencée — la règle `canClientCancel` (compte-regles.ts) ; une
--   réservation confirmée s'annule auprès du centre (ADR 015) ;
-- - sous portée client (ADR 019), pour une entreprise de la portée : une
--   insertion est une réservation (`kind = 'booking'`, canal `client`) au nom
--   d'une personne de l'entreprise, sans coordonnées de demandeur public ; une
--   modification n'est que cette annulation. Hors de la portée, la RLS
--   refuse elle-même.
CREATE FUNCTION bookings_guard_client_space() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.booked_by_member_id IS DISTINCT FROM OLD.booked_by_member_id THEN
      RAISE EXCEPTION 'L''auteur d''une réservation faite depuis l''espace client ne change pas.'
        USING ERRCODE = 'CA009';
    END IF;
    IF NEW.cancelled_by_member_id IS NOT NULL
       AND NEW.cancelled_by_member_id IS DISTINCT FROM OLD.cancelled_by_member_id
       AND NOT (OLD.status = 'pending' AND NEW.status = 'cancelled' AND OLD.starts_at > now()) THEN
      RAISE EXCEPTION 'Le client n''annule lui-même qu''une demande en attente, avant son début : une réservation confirmée s''annule auprès du centre.'
        USING ERRCODE = 'CA009';
    END IF;
  END IF;

  IF current_client_ids() IS NULL
     OR NEW.client_id IS NULL
     OR NOT (NEW.client_id = ANY (current_client_ids())) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.booked_by_member_id IS NULL
       OR NEW.kind <> 'booking'
       OR NEW.channel <> 'client'
       OR num_nonnulls(NEW.requester_name, NEW.requester_email, NEW.requester_phone) > 0 THEN
      RAISE EXCEPTION 'Depuis l''espace client, une réservation porte la personne de l''entreprise qui la fait (booked_by_member_id), au canal client.'
        USING ERRCODE = 'CA009';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT (
       OLD.status = 'pending' AND NEW.status = 'cancelled'
       AND NEW.cancelled_by_member_id IS NOT NULL
       AND to_jsonb(NEW) - '{status,cancelled_at,cancellation_reason,cancelled_by_member_id,updated_at,quote_amount_cents}'::text[]
           = to_jsonb(OLD) - '{status,cancelled_at,cancellation_reason,cancelled_by_member_id,updated_at,quote_amount_cents}'::text[]
     ) THEN
    RAISE EXCEPTION 'Depuis l''espace client, une réservation ne peut qu''être annulée, au nom d''une personne de l''entreprise, tant qu''elle est en attente.'
      USING ERRCODE = 'CA009';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER bookings_guard_client_space
BEFORE INSERT OR UPDATE ON bookings
FOR EACH ROW EXECUTE FUNCTION bookings_guard_client_space();
