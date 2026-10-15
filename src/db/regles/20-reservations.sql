-- Règles métier du module réservations (MySQL 8). Porté des migrations
-- PostgreSQL 0002 (anti-chevauchement), 0026 (garde d'occupation de contrat,
-- créneaux occupés, anonymisation des demandes publiques), 0038 (devis
-- facturé), 0041 (mode de réservation du portail, garde de l'espace client) et
-- 0044 (datation de la confirmation). Voir
-- docs/migration-mysql/routines-reservations.md.
--
-- Un trigger MySQL ne porte qu'un événement : les triggers d'origine sont
-- regroupés en un par événement, dans l'ordre d'exécution de PostgreSQL. Les
-- triggers `updated_at` et `<table>_guard_tenant_*` sont posés par le
-- migrateur. Les messages de SIGNAL tiennent en 128 caractères (limite de
-- MESSAGE_TEXT) : le code `CAnnn:` en préfixe est ce que lit dbErrorCode().

DROP TRIGGER IF EXISTS bookings_before_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bookings_before_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bookings_before_delete;
--> statement-breakpoint
DROP FUNCTION IF EXISTS booking_open_end;
--> statement-breakpoint
DROP PROCEDURE IF EXISTS anonymize_expired_public_requests;
--> statement-breakpoint

-- Fin d'une occupation sans terme (contrat à durée indéterminée). MySQL n'a
-- pas d'infini. Même valeur que OPEN_ENDED_BOOKING_END (schema.ts).
CREATE FUNCTION booking_open_end() RETURNS datetime(3)
DETERMINISTIC NO SQL
RETURN '9999-12-31 00:00:00.000';
--> statement-breakpoint

-- Conservation des demandes publiques (B4, ADR 005, ADR 020). Efface les
-- coordonnées des demandeurs au terme de la durée du centre
-- (`tenants.public_request_retention_months`), comptée depuis la fin du
-- créneau demandé, ou depuis son annulation si elle est antérieure.
-- Anonymiser, pas supprimer : la réservation reste (décision 6). Une demande
-- jamais rattachée à un client perd aussi son objet et ses notes.
-- Centre courant seulement (`@app_tenant_id`). Procédure, et non fonction :
-- elle écrit (MySQL refuse `CREATE FUNCTION` modifiante sous binlog).
CREATE PROCEDURE anonymize_expired_public_requests(OUT p_count int)
SQL SECURITY DEFINER
BEGIN
  UPDATE bookings AS b
    JOIN tenants AS t ON t.id = b.tenant_id
     SET b.requester_name = NULL,
         b.requester_email = NULL,
         b.requester_phone = NULL,
         b.requester_anonymized_at = CURRENT_TIMESTAMP(3),
         b.notes = CASE WHEN b.client_id IS NULL THEN NULL ELSE b.notes END,
         b.title = CASE WHEN b.client_id IS NULL THEN 'Demande publique anonymisée' ELSE b.title END
   WHERE t.id = @app_tenant_id
     AND (b.requester_name IS NOT NULL
          OR b.requester_email IS NOT NULL
          OR b.requester_phone IS NOT NULL)
     AND CASE WHEN b.status = 'cancelled' THEN LEAST(b.cancelled_at, b.ends_at) ELSE b.ends_at END
         < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL t.public_request_retention_months MONTH);
  SET p_count = ROW_COUNT();
END;
--> statement-breakpoint

-- INSERT, dans l'ordre de PostgreSQL :
--  1. bookings_apply_client_booking_mode (0041) : une réservation qui porte
--     `booked_by_member_id` suit le réglage de sa ressource ; le statut est
--     posé par la base, quel que soit celui que le code a écrit.
--  2. bookings_guard_client_space (0041) + politique `bookings_client_scope`
--     (0026, WITH CHECK, supprimée avec la RLS).
--  3. bookings_guard_contract_occupation (0026) : une occupation de contrat ne
--     s'écrit qu'à travers son contrat.
--  4. bookings_stamp_confirmation (0044).
--  5. bookings_no_overlap (0002, décision 3) : verrou de la ressource puis
--     contrôle de chevauchement `[)`, annulées exclues.
CREATE TRIGGER bookings_before_insert
BEFORE INSERT ON bookings
FOR EACH ROW
BEGIN
  DECLARE v_mode varchar(20);
  DECLARE v_status varchar(20);
  DECLARE v_deleted datetime(3);
  DECLARE v_name text;
  DECLARE v_message varchar(128);
  DECLARE v_found int DEFAULT 0;
  DECLARE v_count int;

  -- 1. Mode de réservation du portail.
  IF NEW.booked_by_member_id IS NOT NULL THEN
    SELECT COUNT(*), MAX(client_booking_mode), MAX(status), MAX(deleted_at), MAX(name)
      INTO v_found, v_mode, v_status, v_deleted, v_name
      FROM resources
     WHERE tenant_id = NEW.tenant_id AND id = NEW.resource_id;
    -- Ressource introuvable : la clé étrangère le dira, avec son propre code.
    IF v_found > 0 THEN
      IF v_mode = 'closed' OR v_status <> 'active' OR v_deleted IS NOT NULL THEN
        -- SIGNAL n'accepte qu'un littéral ou une variable, pas une expression.
        SET v_message = CONCAT(
          'CA009: « ', LEFT(v_name, 40),
          ' » ne se réserve pas depuis l''espace client : contactez le centre.');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
      END IF;
      IF v_mode = 'instant' AND NEW.quoted_at IS NOT NULL THEN
        SET NEW.status = 'confirmed';
      ELSE
        SET NEW.status = 'pending';
      END IF;
    END IF;
  END IF;

  -- 2. Espace client : écriture sous portée (`@app_client_ids` non NULL).
  IF @app_client_ids IS NOT NULL THEN
    IF NEW.client_id IS NULL OR FIND_IN_SET(NEW.client_id, @app_client_ids) = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA015: Cette réservation n''appartient à aucune entreprise du compte connecté.';
    END IF;
    IF NEW.booked_by_member_id IS NULL
       OR NEW.kind <> 'booking'
       OR NEW.channel <> 'client'
       OR NEW.requester_name IS NOT NULL
       OR NEW.requester_email IS NOT NULL
       OR NEW.requester_phone IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA009: Espace client : une réservation porte la personne de l''entreprise (booked_by_member_id), au canal client.';
    END IF;
  END IF;

  -- 3. Occupation de contrat : tenue par le contrat.
  IF NEW.kind = 'contract' AND COALESCE(@app_contract_occupation_sync, '') <> 'on' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA001: Cette occupation est tenue par son contrat : elle ne se modifie qu''à travers lui.';
  END IF;

  -- 4. Confirmation datée par la base.
  IF NEW.status = 'confirmed' THEN
    SET NEW.confirmed_at = CURRENT_TIMESTAMP(3);
  ELSE
    SET NEW.confirmed_at = NULL;
  END IF;

  -- 5. Anti-double-réservation. Le verrou de la ressource sérialise les
  --    écritures concurrentes sur elle (toutes passent ici avant d'écrire) ;
  --    le contrôle relit alors les lignes validées, en lecture simple : sous
  --    READ COMMITTED elle voit tout ce qui est validé, et ne pose pas de verrou
  --    de ligne qui inverserait l'ordre des verrous d'un UPDATE (ligne puis
  --    ressource). Une réservation annulée n'occupe rien.
  IF NEW.status <> 'cancelled' THEN
    SELECT COUNT(*) INTO v_count
      FROM resources
     WHERE tenant_id = NEW.tenant_id AND id = NEW.resource_id
       FOR UPDATE;
    SELECT COUNT(*) INTO v_count
      FROM bookings
     WHERE resource_id = NEW.resource_id
       AND status <> 'cancelled'
       AND starts_at < NEW.ends_at
       AND ends_at > NEW.starts_at
       AND id <> NEW.id;
    IF v_count > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA000: Ce créneau est déjà occupé sur cette ressource.';
    END IF;
  END IF;
END;
--> statement-breakpoint

-- UPDATE : mêmes règles, plus le garde du devis facturé (0038). Le contrôle de
-- chevauchement n'est relancé que si les bornes, la ressource ou le statut
-- bougent (PostgreSQL ne revalide pas non plus une ligne dont ces colonnes
-- sont inchangées).
CREATE TRIGGER bookings_before_update
BEFORE UPDATE ON bookings
FOR EACH ROW
BEGIN
  DECLARE v_count int;

  -- Réservation du portail : l'auteur ne change pas, et le client n'annule
  -- lui-même qu'une demande en attente, pas commencée (`canClientCancel`).
  IF NOT (NEW.booked_by_member_id <=> OLD.booked_by_member_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA009: L''auteur d''une réservation faite depuis l''espace client ne change pas.';
  END IF;
  IF NEW.cancelled_by_member_id IS NOT NULL
     AND NOT (NEW.cancelled_by_member_id <=> OLD.cancelled_by_member_id)
     AND NOT (OLD.status = 'pending' AND NEW.status = 'cancelled'
              AND OLD.starts_at > CURRENT_TIMESTAMP(3)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA009: Le client n''annule lui-même qu''une demande en attente, avant son début : le reste, auprès du centre.';
  END IF;

  -- Espace client : la ligne et son résultat sont de la portée (politique
  -- RESTRICTIVE d'origine), et la seule modification permise est l'annulation
  -- d'une demande en attente au nom d'une personne de l'entreprise.
  IF @app_client_ids IS NOT NULL THEN
    IF OLD.client_id IS NULL OR FIND_IN_SET(OLD.client_id, @app_client_ids) = 0
       OR NEW.client_id IS NULL OR FIND_IN_SET(NEW.client_id, @app_client_ids) = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA015: Cette réservation n''appartient à aucune entreprise du compte connecté.';
    END IF;
    IF NOT (
         OLD.status = 'pending' AND NEW.status = 'cancelled'
         AND NEW.cancelled_by_member_id IS NOT NULL
         AND NEW.id <=> OLD.id
         AND NEW.tenant_id <=> OLD.tenant_id
         AND NEW.resource_id <=> OLD.resource_id
         AND NEW.series_id <=> OLD.series_id
         AND NEW.kind <=> OLD.kind
         AND NEW.channel <=> OLD.channel
         AND NEW.starts_at <=> OLD.starts_at
         AND NEW.ends_at <=> OLD.ends_at
         AND NEW.title <=> OLD.title
         AND NEW.notes <=> OLD.notes
         AND NEW.requester_name <=> OLD.requester_name
         AND NEW.requester_email <=> OLD.requester_email
         AND NEW.requester_phone <=> OLD.requester_phone
         AND NEW.requester_anonymized_at <=> OLD.requester_anonymized_at
         AND NEW.client_id <=> OLD.client_id
         AND NEW.contract_id <=> OLD.contract_id
         AND NEW.contract_amendment_id <=> OLD.contract_amendment_id
         AND NEW.quote_unit <=> OLD.quote_unit
         AND NEW.quote_quantity <=> OLD.quote_quantity
         AND NEW.quote_unit_price_cents <=> OLD.quote_unit_price_cents
         AND NEW.quote_discount_bp <=> OLD.quote_discount_bp
         AND NEW.quote_discount_amount_cents <=> OLD.quote_discount_amount_cents
         AND NEW.quote_vat_rate_bp <=> OLD.quote_vat_rate_bp
         AND NEW.quote_currency <=> OLD.quote_currency
         AND NEW.quote_rate_plan_item_id <=> OLD.quote_rate_plan_item_id
         AND NEW.quoted_at <=> OLD.quoted_at
         AND NEW.booked_by_member_id <=> OLD.booked_by_member_id
         AND NEW.confirmed_at <=> OLD.confirmed_at
         AND NEW.confirmed_by_staff_id <=> OLD.confirmed_by_staff_id
         AND NEW.cancelled_by_staff_id <=> OLD.cancelled_by_staff_id
         AND NEW.created_at <=> OLD.created_at
       ) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA009: Espace client : une demande en attente peut seulement être annulée, au nom d''une personne de l''entreprise.';
    END IF;
  END IF;

  -- Occupation de contrat : tenue par le contrat, avant comme après.
  IF COALESCE(@app_contract_occupation_sync, '') <> 'on'
     AND (OLD.kind = 'contract' OR NEW.kind = 'contract') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA001: Cette occupation est tenue par son contrat : elle ne se modifie qu''à travers lui.';
  END IF;

  -- Le devis d'une réservation facturée ne change plus (ADR 026) : une ligne
  -- vivante de facture, ni retirée ni libérée par un avoir, l'a repris.
  IF NOT (NEW.quote_unit <=> OLD.quote_unit
          AND NEW.quote_quantity <=> OLD.quote_quantity
          AND NEW.quote_unit_price_cents <=> OLD.quote_unit_price_cents
          AND NEW.quote_discount_bp <=> OLD.quote_discount_bp
          AND NEW.quote_discount_amount_cents <=> OLD.quote_discount_amount_cents
          AND NEW.quote_vat_rate_bp <=> OLD.quote_vat_rate_bp
          AND NEW.quote_currency <=> OLD.quote_currency
          AND NEW.quote_rate_plan_item_id <=> OLD.quote_rate_plan_item_id
          AND NEW.quoted_at <=> OLD.quoted_at) THEN
    IF EXISTS (
      SELECT 1 FROM invoice_lines
       WHERE tenant_id = OLD.tenant_id AND booking_id = OLD.id
         AND deleted_at IS NULL AND released_at IS NULL
    ) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA002: Le prix de cette réservation est repris par une facture : il ne change plus. Établissez d''abord un avoir.';
    END IF;
  END IF;

  -- Confirmation datée par la base : posée au passage à `confirmed`, jamais
  -- réécrite ensuite.
  IF NEW.status = 'confirmed' AND OLD.status <> 'confirmed' THEN
    SET NEW.confirmed_at = CURRENT_TIMESTAMP(3);
  ELSEIF NOT (NEW.confirmed_at <=> OLD.confirmed_at
              AND NEW.confirmed_by_staff_id <=> OLD.confirmed_by_staff_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'La confirmation d''une réservation est datée par la base : elle ne se réécrit pas.';
  END IF;

  -- Anti-double-réservation (décision 3), seulement si de quoi chevaucher a
  -- bougé et que la ligne occupe encore la ressource.
  IF NEW.status <> 'cancelled'
     AND NOT (NEW.resource_id <=> OLD.resource_id
              AND NEW.starts_at <=> OLD.starts_at
              AND NEW.ends_at <=> OLD.ends_at
              AND NEW.status <=> OLD.status) THEN
    SELECT COUNT(*) INTO v_count
      FROM resources
     WHERE tenant_id = NEW.tenant_id AND id = NEW.resource_id
       FOR UPDATE;
    SELECT COUNT(*) INTO v_count
      FROM bookings
     WHERE resource_id = NEW.resource_id
       AND status <> 'cancelled'
       AND starts_at < NEW.ends_at
       AND ends_at > NEW.starts_at
       AND id <> NEW.id;
    IF v_count > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA000: Ce créneau est déjà occupé sur cette ressource.';
    END IF;
  END IF;
END;
--> statement-breakpoint

-- DELETE : garde d'occupation de contrat (0026) et portée client.
CREATE TRIGGER bookings_before_delete
BEFORE DELETE ON bookings
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL
     AND (OLD.client_id IS NULL OR FIND_IN_SET(OLD.client_id, @app_client_ids) = 0) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Cette réservation n''appartient à aucune entreprise du compte connecté.';
  END IF;
  IF OLD.kind = 'contract' AND COALESCE(@app_contract_occupation_sync, '') <> 'on' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA001: Cette occupation est tenue par son contrat : elle ne se modifie qu''à travers lui.';
  END IF;
END;
