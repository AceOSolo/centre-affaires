-- Règles métier du courrier (module `courrier`, ADR 015, 037, 020).
--
-- Porté des migrations PostgreSQL 0019-0020, 0024, 0026 (portée client), 0041
-- (demandes de courrier CA008). Ce fichier est idempotent : il se rejoue dès
-- que son contenu change (voir `src/db/migrer.ts`).
--
-- Conventions (docs/migration-mysql/conventions.md) :
--
-- - `SIGNAL SQLSTATE '45000'` avec le préfixe `CAnnn:` que lit `dbErrorCode()`.
--   `MESSAGE_TEXT` est limité à 128 caractères : les messages sont plus courts
--   que ceux de PostgreSQL, les codes sont les mêmes.
-- - la RLS n'existe plus : la portée client (`@app_client_ids`) est gardée à
--   l'écriture par ces triggers, et filtrée à la lecture par chaque requête.
--   Un refus de portée lève 42501 (même code que le `WITH CHECK` d'origine).
-- - drapeaux de session : `@app_mail_request_sync` (écritures que la base
--   s'adresse à elle-même), `@app_anonymization` (module rgpd),
--   `@app_journal_purge` (purge échue du journal). Posés puis rendus à leur
--   valeur précédente, y compris sur erreur.
-- - un trigger ne peut pas écrire la table qui l'a déclenché : le résumé du pli
--   à son retrait est donc posé par le BEFORE UPDATE du pli lui-même.

-- ---------------------------------------------------------------------------
-- Journaux d'accès : ajout seul
-- ---------------------------------------------------------------------------
-- Un journal que l'application peut réécrire ne prouve rien. Sous PostgreSQL le
-- droit était retiré au rôle applicatif ; ici ce sont des triggers, vrais pour
-- tout utilisateur. Seule la purge échue (`purge_expired_mail_scan_views()`)
-- supprime, en posant `@app_journal_purge`.

DROP TRIGGER IF EXISTS mail_scan_views_before_update;
--> statement-breakpoint
CREATE TRIGGER mail_scan_views_before_update
BEFORE UPDATE ON mail_scan_views
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
    MESSAGE_TEXT = 'Le journal d''accès aux numérisations ne se modifie pas.';
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS mail_scan_views_before_delete;
--> statement-breakpoint
CREATE TRIGGER mail_scan_views_before_delete
BEFORE DELETE ON mail_scan_views
FOR EACH ROW
BEGIN
  IF COALESCE(@app_journal_purge, '') <> 'on' THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Le journal d''accès aux numérisations ne s''efface que par sa purge échue.';
  END IF;
END;
--> statement-breakpoint

-- Portée client : le journal suit la numérisation, qui suit le pli.
DROP TRIGGER IF EXISTS mail_scan_views_before_insert;
--> statement-breakpoint
CREATE TRIGGER mail_scan_views_before_insert
BEFORE INSERT ON mail_scan_views
FOR EACH ROW
BEGIN
  DECLARE v_client CHAR(36);
  IF @app_client_ids IS NOT NULL THEN
    SELECT i.client_id INTO v_client
      FROM mail_scans AS s
      JOIN mail_items AS i ON i.tenant_id = s.tenant_id AND i.id = s.mail_item_id
     WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.mail_scan_id;
    IF v_client IS NOT NULL AND NOT FIND_IN_SET(v_client, @app_client_ids) THEN
      SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
        MESSAGE_TEXT = 'Écriture refusée : ce document n''appartient pas à votre entreprise.';
    END IF;
  END IF;
END;
--> statement-breakpoint

-- Purge du journal au terme de `tenants.mail_access_log_retention_months`
-- (RGPD, ADR 015) : seule porte d'effacement, qui ne s'ouvre que sur ce qui est
-- échu, pour le centre courant. L'application peut purger, jamais choisir quoi.
DROP FUNCTION IF EXISTS purge_expired_mail_scan_views;
--> statement-breakpoint
CREATE FUNCTION purge_expired_mail_scan_views() RETURNS INT
NOT DETERMINISTIC MODIFIES SQL DATA SQL SECURITY DEFINER
BEGIN
  DECLARE v_count INT DEFAULT 0;
  DECLARE v_previous VARCHAR(16) DEFAULT @app_journal_purge;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @app_journal_purge = v_previous;
    RESIGNAL;
  END;
  SET @app_journal_purge = 'on';
  DELETE views
    FROM mail_scan_views AS views
    JOIN tenants ON tenants.id = views.tenant_id
   WHERE tenants.id = @app_tenant_id
     AND views.viewed_at
         < TIMESTAMPADD(MONTH, -tenants.mail_access_log_retention_months, CURRENT_TIMESTAMP(3));
  SET v_count = ROW_COUNT();
  SET @app_journal_purge = v_previous;
  RETURN v_count;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Numérisations : portée client (par le pli)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS mail_scans_before_insert;
--> statement-breakpoint
CREATE TRIGGER mail_scans_before_insert
BEFORE INSERT ON mail_scans
FOR EACH ROW
BEGIN
  DECLARE v_client CHAR(36);
  IF @app_client_ids IS NOT NULL THEN
    SELECT client_id INTO v_client FROM mail_items
     WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_item_id;
    IF v_client IS NOT NULL AND NOT FIND_IN_SET(v_client, @app_client_ids) THEN
      SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
        MESSAGE_TEXT = 'Écriture refusée : ce courrier n''appartient pas à votre entreprise.';
    END IF;
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS mail_scans_before_update;
--> statement-breakpoint
CREATE TRIGGER mail_scans_before_update
BEFORE UPDATE ON mail_scans
FOR EACH ROW
BEGIN
  DECLARE v_client CHAR(36);
  IF @app_client_ids IS NOT NULL THEN
    SELECT client_id INTO v_client FROM mail_items
     WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_item_id;
    IF v_client IS NOT NULL AND NOT FIND_IN_SET(v_client, @app_client_ids) THEN
      SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
        MESSAGE_TEXT = 'Écriture refusée : ce courrier n''appartient pas à votre entreprise.';
    END IF;
  END IF;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Plis : portée client, reprise des demandes, résumé tenu par la base
-- ---------------------------------------------------------------------------
-- Insertion : portée client ; un pli inséré déjà retiré avec une demande
-- d'ouverture en cours ne naît pas « demandé » (PostgreSQL le corrigeait par un
-- UPDATE après coup, interdit ici : le résumé est posé directement).
DROP TRIGGER IF EXISTS mail_items_before_insert;
--> statement-breakpoint
CREATE TRIGGER mail_items_before_insert
BEFORE INSERT ON mail_items
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL AND NOT FIND_IN_SET(NEW.client_id, @app_client_ids) THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : ce courrier n''appartient pas à votre entreprise.';
  END IF;
  IF NEW.opened_at IS NULL AND NEW.deleted_at IS NOT NULL
     AND NEW.opening_requested_at IS NOT NULL THEN
    SET NEW.status = 'received',
        NEW.opening_requested_at = NULL,
        NEW.opening_requested_by = NULL;
  END IF;
END;
--> statement-breakpoint

-- La demande d'ouverture portée par un pli inséré (import, tests) devient une
-- ligne de `mail_requests` : encore fermé, elle est en cours ; déjà ouvert,
-- elle est faite, à la date et par l'auteur de l'ouverture. Idempotent : une
-- demande déjà reprise (même pli, même date) ne l'est pas deux fois.
DROP TRIGGER IF EXISTS mail_items_after_insert;
--> statement-breakpoint
CREATE TRIGGER mail_items_after_insert
AFTER INSERT ON mail_items
FOR EACH ROW
adopt: BEGIN
  DECLARE v_previous VARCHAR(16) DEFAULT @app_mail_request_sync;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @app_mail_request_sync = v_previous;
    RESIGNAL;
  END;
  IF NEW.opening_requested_at IS NULL OR NEW.opening_requested_by IS NULL THEN
    LEAVE adopt;
  END IF;
  IF EXISTS (
    SELECT 1 FROM mail_requests
     WHERE tenant_id = NEW.tenant_id AND mail_item_id = NEW.id
       AND kind = 'open_and_scan' AND requested_at = NEW.opening_requested_at
  ) THEN
    LEAVE adopt;
  END IF;
  SET @app_mail_request_sync = 'on';
  INSERT INTO mail_requests (
    id, tenant_id, mail_item_id, client_id, kind, status, requested_at,
    requested_by_member_id, completed_at, completed_by_staff_id
  ) VALUES (
    UUID(), NEW.tenant_id, NEW.id, NEW.client_id, 'open_and_scan',
    IF(NEW.opened_at IS NOT NULL, 'done', 'requested'),
    NEW.opening_requested_at, NEW.opening_requested_by,
    NEW.opened_at, NEW.opened_by
  );
  SET @app_mail_request_sync = v_previous;
END;
--> statement-breakpoint

-- Mise à jour : portée client, puis garde du résumé (CA008).
--
-- `mail_items.status = 'opening_requested'` et `opening_requested_*` disent
-- qu'une demande d'ouverture est en cours. Ils suivent `mail_requests` : le
-- code dépose, annule ou refuse la demande, jamais le résumé. L'ouverture
-- (`received`/`opening_requested` → `opened`) reste au code. Le retrait du pli
-- remet le résumé à `received` ici même (ses demandes sont refusées ensuite
-- par `mail_items_after_update`).
DROP TRIGGER IF EXISTS mail_items_before_update;
--> statement-breakpoint
CREATE TRIGGER mail_items_before_update
BEFORE UPDATE ON mail_items
FOR EACH ROW
guard: BEGIN
  IF @app_client_ids IS NOT NULL AND (
       NOT FIND_IN_SET(OLD.client_id, @app_client_ids)
       OR NOT FIND_IN_SET(NEW.client_id, @app_client_ids)) THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : ce courrier n''appartient pas à votre entreprise.';
  END IF;
  IF COALESCE(@app_mail_request_sync, '') = 'on' THEN
    LEAVE guard;
  END IF;
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
     AND OLD.status = 'opening_requested' AND NEW.status = 'opening_requested'
     AND NEW.opened_at IS NULL
     AND NEW.opening_requested_at <=> OLD.opening_requested_at
     AND NEW.opening_requested_by <=> OLD.opening_requested_by THEN
    SET NEW.status = 'received',
        NEW.opening_requested_at = NULL,
        NEW.opening_requested_by = NULL;
    LEAVE guard;
  END IF;
  IF NOT (NEW.opening_requested_at <=> OLD.opening_requested_at)
     OR NOT (NEW.opening_requested_by <=> OLD.opening_requested_by)
     OR (NEW.status = 'opening_requested' AND OLD.status <> 'opening_requested')
     OR (OLD.status = 'opening_requested' AND NEW.status = 'received') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA008: La demande d''ouverture d''un pli se dépose ou s''annule dans mail_requests : son résumé est tenu par la base.';
  END IF;
END;
--> statement-breakpoint

-- Le pli décide de ses demandes en cours :
--
-- - ouvert (`opened_at` posé) : sa demande d'ouverture en cours est faite, à
--   la date et par l'auteur de l'ouverture ;
-- - retiré (`deleted_at` posé) : ses demandes en cours sont refusées par la
--   base, sans auteur, motif « Courrier retiré ».
DROP TRIGGER IF EXISTS mail_items_after_update;
--> statement-breakpoint
CREATE TRIGGER mail_items_after_update
AFTER UPDATE ON mail_items
FOR EACH ROW
follow: BEGIN
  DECLARE v_previous VARCHAR(16) DEFAULT @app_mail_request_sync;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @app_mail_request_sync = v_previous;
    RESIGNAL;
  END;
  IF NOT ((OLD.opened_at IS NULL AND NEW.opened_at IS NOT NULL)
          OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)) THEN
    LEAVE follow;
  END IF;
  SET @app_mail_request_sync = 'on';
  IF OLD.opened_at IS NULL AND NEW.opened_at IS NOT NULL THEN
    UPDATE mail_requests
       SET status = 'done', completed_at = NEW.opened_at, completed_by_staff_id = NEW.opened_by
     WHERE tenant_id = NEW.tenant_id AND mail_item_id = NEW.id
       AND kind = 'open_and_scan' AND status IN ('requested', 'in_progress');
  END IF;
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    UPDATE mail_requests
       SET status = 'refused', refused_at = CURRENT_TIMESTAMP(3), refused_by_staff_id = NULL,
           refusal_reason = 'Courrier retiré : enregistré par erreur.'
     WHERE tenant_id = NEW.tenant_id AND mail_item_id = NEW.id
       AND status IN ('requested', 'in_progress');
  END IF;
  SET @app_mail_request_sync = v_previous;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Demandes de courrier : naissance, transitions, portée client (CA008)
-- ---------------------------------------------------------------------------
-- - une demande naît `requested`, datée par la base, sur un pli ni retiré ni
--   réexpédié ; une ouverture sur un pli fermé, une numérisation seule sur un
--   pli ouvert ; sous portée client, au nom d'une personne de l'entreprise ;
-- - ne changent jamais : pli, client, nature, date et auteur de la demande,
--   consigne, adresse de réexpédition figée ;
-- - transitions : `requested` → `in_progress` ; `requested`/`in_progress` →
--   `done` ou `refused` (motif) ; `requested` → `cancelled`. Chaque date est
--   posée par la base, l'auteur est exigé ;
-- - sous portée client, seule l'annulation d'une demande `requested` ;
-- - faite, une réexpédition garde la main sur ses frais et son numéro de
--   suivi tant qu'aucune facture ne la tient ; tout le reste est figé ;
-- - jamais supprimée.
--
-- `@app_mail_request_sync` laisse passer les écritures de la base elle-même
-- (reprise, ouverture, retrait), `@app_anonymization` celles de l'anonymisation
-- (ADR 040).
DROP TRIGGER IF EXISTS mail_requests_before_delete;
--> statement-breakpoint
CREATE TRIGGER mail_requests_before_delete
BEFORE DELETE ON mail_requests
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
    'CA008: Une demande de courrier ne se supprime pas : elle s''annule ou se refuse, sa trace reste.';
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS mail_requests_before_insert;
--> statement-breakpoint
CREATE TRIGGER mail_requests_before_insert
BEFORE INSERT ON mail_requests
FOR EACH ROW
guard: BEGIN
  DECLARE v_found INT DEFAULT 0;
  DECLARE v_deleted TINYINT DEFAULT 0;
  DECLARE v_opened TINYINT DEFAULT 0;
  DECLARE v_client_space TINYINT DEFAULT 0;

  IF @app_client_ids IS NOT NULL AND NOT FIND_IN_SET(NEW.client_id, @app_client_ids) THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : cette demande n''appartient pas à votre entreprise.';
  END IF;
  IF COALESCE(@app_mail_request_sync, '') = 'on' OR COALESCE(@app_anonymization, '') = 'on' THEN
    LEAVE guard;
  END IF;
  SET v_client_space = (@app_client_ids IS NOT NULL);

  IF NEW.status <> 'requested'
     OR NEW.started_at IS NOT NULL OR NEW.started_by_staff_id IS NOT NULL
     OR NEW.completed_at IS NOT NULL OR NEW.completed_by_staff_id IS NOT NULL
     OR NEW.refused_at IS NOT NULL OR NEW.refused_by_staff_id IS NOT NULL
     OR NEW.refusal_reason IS NOT NULL OR NEW.cancelled_at IS NOT NULL
     OR NEW.cancelled_by_member_id IS NOT NULL OR NEW.cancelled_by_staff_id IS NOT NULL
     OR NEW.postage_cents IS NOT NULL OR NEW.postage_currency IS NOT NULL
     OR NEW.forward_tracking_number IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA008: Une demande naît « demandée » : prise en charge, réalisation, refus ou annulation viennent ensuite.';
  END IF;
  IF v_client_space AND (NEW.requested_by_member_id IS NULL OR NEW.requested_by_staff_id IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA008: Depuis l''espace client, une demande porte la personne de l''entreprise qui la dépose.';
  END IF;
  SET NEW.requested_at = CURRENT_TIMESTAMP(3);

  -- Verrou en partage : le pli ne se retire pas pendant le dépôt.
  SELECT COUNT(*), COALESCE(MAX(deleted_at IS NOT NULL), 0), COALESCE(MAX(opened_at IS NOT NULL), 0)
    INTO v_found, v_deleted, v_opened
    FROM mail_items
   WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_item_id
     FOR SHARE;
  IF v_found = 0 THEN
    -- La clé étrangère le dira, avec son propre code.
    LEAVE guard;
  END IF;
  IF v_deleted = 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA008: Ce courrier a été retiré : aucune demande ne s''y dépose.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM mail_requests
     WHERE tenant_id = NEW.tenant_id AND mail_item_id = NEW.mail_item_id
       AND kind = 'forward' AND status = 'done'
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA008: Ce courrier a été réexpédié : il n''est plus au centre.';
  END IF;
  IF NEW.kind = 'open_and_scan' AND v_opened = 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA008: Ce courrier est déjà ouvert : demandez une numérisation.';
  END IF;
  IF NEW.kind = 'scan' AND v_opened = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA008: Ce courrier est encore fermé : demandez son ouverture et sa numérisation.';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS mail_requests_before_update;
--> statement-breakpoint
CREATE TRIGGER mail_requests_before_update
BEFORE UPDATE ON mail_requests
FOR EACH ROW
guard: BEGIN
  DECLARE v_client_space TINYINT DEFAULT 0;
  DECLARE v_item_found INT DEFAULT 0;
  DECLARE v_item_deleted TINYINT DEFAULT 0;
  DECLARE v_item_opened TINYINT DEFAULT 0;
  -- Tout sauf `updated_at` (tenu par son trigger) : la colonne générée
  -- `pending_live` suit `status`, elle n'est pas comparée.
  DECLARE v_same_but_fees TINYINT DEFAULT 0;
  DECLARE v_same_all TINYINT DEFAULT 0;
  DECLARE v_message VARCHAR(128);

  IF @app_client_ids IS NOT NULL AND (
       NOT FIND_IN_SET(OLD.client_id, @app_client_ids)
       OR NOT FIND_IN_SET(NEW.client_id, @app_client_ids)) THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : cette demande n''appartient pas à votre entreprise.';
  END IF;
  IF COALESCE(@app_mail_request_sync, '') = 'on' OR COALESCE(@app_anonymization, '') = 'on' THEN
    LEAVE guard;
  END IF;
  SET v_client_space = (@app_client_ids IS NOT NULL);

  IF NOT (NEW.id <=> OLD.id AND NEW.tenant_id <=> OLD.tenant_id
          AND NEW.mail_item_id <=> OLD.mail_item_id AND NEW.client_id <=> OLD.client_id
          AND NEW.kind <=> OLD.kind AND NEW.requested_at <=> OLD.requested_at
          AND NEW.requested_by_member_id <=> OLD.requested_by_member_id
          AND NEW.requested_by_staff_id <=> OLD.requested_by_staff_id
          AND NEW.client_note <=> OLD.client_note) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA008: Une demande ne change ni de pli, ni de nature, ni de date, ni d''auteur, ni de consigne.';
  END IF;
  IF NOT (NEW.forward_recipient <=> OLD.forward_recipient
          AND NEW.forward_address_line1 <=> OLD.forward_address_line1
          AND NEW.forward_address_line2 <=> OLD.forward_address_line2
          AND NEW.forward_postal_code <=> OLD.forward_postal_code
          AND NEW.forward_city <=> OLD.forward_city
          AND NEW.forward_country <=> OLD.forward_country) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA008: L''adresse de réexpédition est figée à la demande : annulez et déposez une nouvelle demande.';
  END IF;

  IF NEW.status = OLD.status THEN
    SET v_same_but_fees = (
      NEW.started_at <=> OLD.started_at AND NEW.started_by_staff_id <=> OLD.started_by_staff_id
      AND NEW.completed_at <=> OLD.completed_at
      AND NEW.completed_by_staff_id <=> OLD.completed_by_staff_id
      AND NEW.refused_at <=> OLD.refused_at AND NEW.refused_by_staff_id <=> OLD.refused_by_staff_id
      AND NEW.refusal_reason <=> OLD.refusal_reason
      AND NEW.cancelled_at <=> OLD.cancelled_at
      AND NEW.cancelled_by_member_id <=> OLD.cancelled_by_member_id
      AND NEW.cancelled_by_staff_id <=> OLD.cancelled_by_staff_id
      AND NEW.created_at <=> OLD.created_at);
    SET v_same_all = (v_same_but_fees
      AND NEW.postage_cents <=> OLD.postage_cents
      AND NEW.postage_currency <=> OLD.postage_currency
      AND NEW.forward_tracking_number <=> OLD.forward_tracking_number);
    IF v_same_all THEN
      LEAVE guard;
    END IF;
    IF NOT v_client_space AND OLD.status = 'done' AND OLD.kind = 'forward' AND v_same_but_fees THEN
      IF NOT (NEW.postage_cents <=> OLD.postage_cents AND NEW.postage_currency <=> OLD.postage_currency)
         AND EXISTS (
           SELECT 1 FROM invoice_lines
            WHERE tenant_id = OLD.tenant_id AND mail_request_id = OLD.id
              AND deleted_at IS NULL AND released_at IS NULL
         ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
          'CA008: Cette réexpédition est facturée : ses frais ne changent plus. Établissez d''abord un avoir.';
      END IF;
      LEAVE guard;
    END IF;
    SET v_message = CONCAT('CA008: Cette demande est « ', OLD.status, ' » : elle ne se modifie plus ainsi.');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;

  IF v_client_space AND NOT (
       OLD.status = 'requested' AND NEW.status = 'cancelled'
       AND NEW.cancelled_by_member_id IS NOT NULL AND NEW.cancelled_by_staff_id IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA008: Depuis l''espace client, une demande ne peut qu''être annulée, tant que le centre ne l''a pas prise en charge.';
  END IF;

  IF OLD.status = 'requested' AND NEW.status = 'in_progress' THEN
    IF NEW.started_by_staff_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA008: La prise en charge d''une demande porte son auteur.';
    END IF;
    SET NEW.started_at = CURRENT_TIMESTAMP(3);
  ELSEIF OLD.status IN ('requested', 'in_progress') AND NEW.status = 'done' THEN
    IF NEW.completed_by_staff_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA008: Une demande faite porte l''auteur de sa réalisation.';
    END IF;
    SET NEW.completed_at = CURRENT_TIMESTAMP(3);
    SELECT COUNT(*), COALESCE(MAX(deleted_at IS NOT NULL), 0), COALESCE(MAX(opened_at IS NOT NULL), 0)
      INTO v_item_found, v_item_deleted, v_item_opened
      FROM mail_items
     WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_item_id
       FOR SHARE;
    IF v_item_deleted = 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA008: Ce courrier a été retiré : la demande se refuse.';
    END IF;
    IF NEW.kind = 'open_and_scan' AND v_item_opened = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA008: Ouvrez le pli : sa demande d''ouverture se clôt avec l''ouverture.';
    END IF;
    IF NEW.kind = 'forward' AND EXISTS (
      SELECT 1 FROM mail_requests
       WHERE tenant_id = NEW.tenant_id AND mail_item_id = NEW.mail_item_id
         AND id <> NEW.id AND status IN ('requested', 'in_progress')
    ) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA008: D''autres demandes attendent sur ce pli : traitez-les avant de le réexpédier, il quittera le centre.';
    END IF;
  ELSEIF OLD.status IN ('requested', 'in_progress') AND NEW.status = 'refused' THEN
    IF NEW.refused_by_staff_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA008: Un refus porte son auteur et son motif.';
    END IF;
    SET NEW.refused_at = CURRENT_TIMESTAMP(3);
  ELSEIF OLD.status = 'requested' AND NEW.status = 'cancelled' THEN
    SET NEW.cancelled_at = CURRENT_TIMESTAMP(3);
  ELSE
    SET v_message = CONCAT('CA008: Une demande « ', OLD.status, ' » ne passe pas à « ', NEW.status, ' ».');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;
END;
--> statement-breakpoint

-- Le résumé du pli suit la demande d'ouverture : déposée, le pli est
-- `opening_requested` ; annulée ou refusée, il redevient `received`. Faite, il
-- est déjà `opened` (l'ouverture l'a clôturée). Idempotent. Sans effet quand la
-- base s'écrit à elle-même (`@app_mail_request_sync`) : le pli est déjà à jour,
-- et MySQL interdirait d'écrire le pli depuis l'écriture d'une demande que son
-- propre trigger vient de déclencher.
DROP TRIGGER IF EXISTS mail_requests_after_insert;
--> statement-breakpoint
CREATE TRIGGER mail_requests_after_insert
AFTER INSERT ON mail_requests
FOR EACH ROW
sync: BEGIN
  DECLARE v_previous VARCHAR(16) DEFAULT @app_mail_request_sync;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @app_mail_request_sync = v_previous;
    RESIGNAL;
  END;
  IF NEW.kind <> 'open_and_scan' OR COALESCE(@app_mail_request_sync, '') = 'on' THEN
    LEAVE sync;
  END IF;
  IF NEW.status IN ('requested', 'in_progress') THEN
    SET @app_mail_request_sync = 'on';
    UPDATE mail_items
       SET status = 'opening_requested',
           opening_requested_at = NEW.requested_at,
           opening_requested_by = NEW.requested_by_member_id
     WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_item_id
       AND opened_at IS NULL
       AND NOT (status = 'opening_requested'
                AND opening_requested_at <=> NEW.requested_at
                AND opening_requested_by <=> NEW.requested_by_member_id);
    SET @app_mail_request_sync = v_previous;
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS mail_requests_after_update;
--> statement-breakpoint
CREATE TRIGGER mail_requests_after_update
AFTER UPDATE ON mail_requests
FOR EACH ROW
sync: BEGIN
  DECLARE v_previous VARCHAR(16) DEFAULT @app_mail_request_sync;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @app_mail_request_sync = v_previous;
    RESIGNAL;
  END;
  IF NEW.kind <> 'open_and_scan' OR COALESCE(@app_mail_request_sync, '') = 'on' THEN
    LEAVE sync;
  END IF;
  IF NEW.status IN ('requested', 'in_progress') THEN
    SET @app_mail_request_sync = 'on';
    UPDATE mail_items
       SET status = 'opening_requested',
           opening_requested_at = NEW.requested_at,
           opening_requested_by = NEW.requested_by_member_id
     WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_item_id
       AND opened_at IS NULL
       AND NOT (status = 'opening_requested'
                AND opening_requested_at <=> NEW.requested_at
                AND opening_requested_by <=> NEW.requested_by_member_id);
    SET @app_mail_request_sync = v_previous;
  ELSEIF NEW.status IN ('cancelled', 'refused') THEN
    SET @app_mail_request_sync = 'on';
    UPDATE mail_items
       SET status = 'received', opening_requested_at = NULL, opening_requested_by = NULL
     WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_item_id
       AND status = 'opening_requested'
       AND opening_requested_at <=> NEW.requested_at;
    SET @app_mail_request_sync = v_previous;
  END IF;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Facturation : service du catalogue qui facture une demande faite (ADR 037)
-- ---------------------------------------------------------------------------
-- Une ouverture n'en a pas : elle se facture par son pli (`courrier.ouverture`).
-- Appelée par le garde des lignes de facture (module facturation).
-- Miroir : `serviceCodes` (src/modules/facturation/schema.ts).
DROP FUNCTION IF EXISTS mail_request_service_code;
--> statement-breakpoint
CREATE FUNCTION mail_request_service_code(p_kind VARCHAR(20)) RETURNS VARCHAR(40)
DETERMINISTIC NO SQL
BEGIN
  RETURN CASE p_kind
    WHEN 'scan' THEN 'courrier.numerisation'
    WHEN 'forward' THEN 'courrier.reexpedition'
    ELSE NULL
  END;
END;
