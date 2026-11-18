-- Pièces justificatives de la domiciliation (ADR 075) : client_document_kinds,
-- client_documents, client_document_views. Code d'erreur : CA021.
--
-- Idempotent : rejoué par le migrateur dès que le fichier change.
--
-- Ce que la base garantit, quelles que soient les erreurs du code :
--
-- - la liste des pièces demandées est un réglage du back-office : jamais
--   écrite depuis l'espace client, jamais supprimée ;
-- - une pièce se dépose « reçue », pour une entreprise de la portée client,
--   et pas tant qu'une autre du même type attend sa vérification ou est
--   validée (le dépôt d'une entreprise est sérialisé par le verrou de sa
--   fiche) ;
-- - le fichier d'une pièce ne se remplace pas ; seule l'équipe la valide ou
--   la refuse (reçue → validée ou refusée ; validée → refusée) ;
-- - une pièce ne se supprime pas ; son fichier s'efface au terme de sa
--   conservation, par `mark_client_document_purged()`, qui revérifie
--   l'échéance ;
-- - le journal des consultations est en ajout seul, purgé à son terme.
--
-- Le message d'un SIGNAL tient en 128 caractères.

-- ---------------------------------------------------------------------------
-- 1. Liste des pièces demandées : réglage du back-office
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS client_document_kinds_before_insert;
--> statement-breakpoint
CREATE TRIGGER client_document_kinds_before_insert
BEFORE INSERT ON client_document_kinds
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'La liste des pièces demandées est un réglage du back-office.';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS client_document_kinds_before_update;
--> statement-breakpoint
CREATE TRIGGER client_document_kinds_before_update
BEFORE UPDATE ON client_document_kinds
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'La liste des pièces demandées est un réglage du back-office.';
  END IF;
  -- Les pièces déposées citent le code : il ne change pas.
  IF NOT (NEW.code <=> OLD.code) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA021: Le code d''une pièce de la liste ne change pas : renommez-la.';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS client_document_kinds_before_delete;
--> statement-breakpoint
CREATE TRIGGER client_document_kinds_before_delete
BEFORE DELETE ON client_document_kinds
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
    'CA021: Une pièce de la liste se retire, elle ne se supprime pas.';
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Pièces déposées
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS client_documents_before_insert;
--> statement-breakpoint
CREATE TRIGGER client_documents_before_insert
BEFORE INSERT ON client_documents
FOR EACH ROW
BEGIN
  DECLARE v_locked INT DEFAULT 0;
  DECLARE v_live INT DEFAULT 0;

  IF @app_client_ids IS NOT NULL AND FIND_IN_SET(NEW.client_id, @app_client_ids) = 0 THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : hors de la portée client de ce compte.';
  END IF;
  IF NEW.status <> 'received' OR NEW.deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA021: Une pièce se dépose à vérifier : l''accueil la valide ou la refuse ensuite.';
  END IF;

  -- Deux dépôts simultanés de la même entreprise passent l'un après l'autre.
  -- `COUNT(*)` rend toujours une ligne : pas de NOT FOUND à gérer.
  SELECT COUNT(*) INTO v_locked
    FROM clients
   WHERE tenant_id = NEW.tenant_id AND id = NEW.client_id
     FOR UPDATE;

  SELECT COUNT(*) INTO v_live
    FROM client_documents
   WHERE tenant_id = NEW.tenant_id AND client_id = NEW.client_id
     AND kind_code = NEW.kind_code
     AND status IN ('received', 'accepted') AND deleted_at IS NULL;
  IF v_live > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA021: Cette pièce est déjà déposée : elle attend sa vérification ou elle est validée.';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS client_documents_before_update;
--> statement-breakpoint
CREATE TRIGGER client_documents_before_update
BEFORE UPDATE ON client_documents
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Une pièce déposée se vérifie au centre : l''espace client ne la modifie pas.';
  END IF;

  IF NOT (NEW.id <=> OLD.id AND NEW.tenant_id <=> OLD.tenant_id
          AND NEW.client_id <=> OLD.client_id AND NEW.kind_code <=> OLD.kind_code
          AND NEW.kind_label <=> OLD.kind_label AND NEW.storage_key <=> OLD.storage_key
          AND NEW.encryption_key_version <=> OLD.encryption_key_version
          AND NEW.content_type <=> OLD.content_type AND NEW.byte_size <=> OLD.byte_size
          AND NEW.uploaded_by_member_id <=> OLD.uploaded_by_member_id
          AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA021: Le fichier d''une pièce déposée ne se remplace pas : le client en dépose une autre.';
  END IF;

  IF OLD.deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA021: Cette pièce a été effacée au terme de sa conservation : elle ne change plus.';
  END IF;
  IF NEW.deleted_at IS NOT NULL AND COALESCE(@app_client_document_purge, '') <> 'on' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA021: Une pièce ne s''efface qu''au terme de sa conservation.';
  END IF;

  IF NOT (NEW.status <=> OLD.status) THEN
    IF NOT ((OLD.status = 'received' AND NEW.status IN ('accepted', 'refused'))
            OR (OLD.status = 'accepted' AND NEW.status = 'refused')) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA021: Passage impossible : une pièce reçue se valide ou se refuse, une pièce validée peut être refusée.';
    END IF;
  ELSEIF NOT (NEW.refusal_reason <=> OLD.refusal_reason AND NEW.reviewed_at <=> OLD.reviewed_at
              AND NEW.reviewed_by <=> OLD.reviewed_by) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA021: Une vérification ne se réécrit pas : changez l''état de la pièce.';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS client_documents_before_delete;
--> statement-breakpoint
CREATE TRIGGER client_documents_before_delete
BEFORE DELETE ON client_documents
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
    'CA021: Une pièce déposée ne se supprime pas : son fichier s''efface au terme de sa conservation.';
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Journal des consultations : ajout seul, portée client
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS client_document_views_before_insert;
--> statement-breakpoint
CREATE TRIGGER client_document_views_before_insert
BEFORE INSERT ON client_document_views
FOR EACH ROW
BEGIN
  DECLARE v_mine INT DEFAULT 0;
  IF @app_client_ids IS NOT NULL THEN
    SELECT COUNT(*) INTO v_mine
      FROM client_documents
     WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id
       AND FIND_IN_SET(client_id, @app_client_ids) > 0;
    IF NEW.viewer <> 'client' OR v_mine = 0 THEN
      SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
        MESSAGE_TEXT = 'Écriture refusée : cette pièce n''appartient pas à votre entreprise.';
    END IF;
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS client_document_views_before_update;
--> statement-breakpoint
CREATE TRIGGER client_document_views_before_update
BEFORE UPDATE ON client_document_views
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
    MESSAGE_TEXT = 'Le journal des consultations des pièces ne se modifie pas.';
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS client_document_views_before_delete;
--> statement-breakpoint
CREATE TRIGGER client_document_views_before_delete
BEFORE DELETE ON client_document_views
FOR EACH ROW
BEGIN
  IF COALESCE(@app_journal_purge, '') <> 'on' THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Le journal des consultations des pièces ne s''efface que par sa purge échue.';
  END IF;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Conservation (RGPD, ADR 020, ADR 075)
-- ---------------------------------------------------------------------------
-- Échéance d'une pièce, pour le centre courant (`@app_tenant_id`) : 1 si son
-- fichier peut être effacé.
--
-- - entreprise anonymisée : tout de suite ;
-- - pièce refusée : `refused_client_document_retention_months` après le refus ;
-- - pièce reçue ou validée : `client_document_retention_months` après la fin de
--   la relation, la dernière activité du client (`client_last_activity_on`,
--   `90-rgpd.sql`, résolue à l'exécution).
DROP FUNCTION IF EXISTS client_document_expired;
--> statement-breakpoint
CREATE FUNCTION client_document_expired(p_document_id CHAR(36)) RETURNS TINYINT
NOT DETERMINISTIC READS SQL DATA
BEGIN
  DECLARE v_found INT DEFAULT 0;
  DECLARE v_client CHAR(36);
  DECLARE v_status VARCHAR(16);
  DECLARE v_reviewed DATETIME(3);
  DECLARE v_anonymized INT DEFAULT 0;
  DECLARE v_months INT;
  DECLARE v_refused_months INT;
  DECLARE v_timezone VARCHAR(64);

  SELECT COUNT(*), MAX(d.client_id), MAX(d.status), MAX(d.reviewed_at),
         MAX(c.anonymized_at IS NOT NULL), MAX(t.client_document_retention_months),
         MAX(t.refused_client_document_retention_months), MAX(t.timezone)
    INTO v_found, v_client, v_status, v_reviewed, v_anonymized, v_months, v_refused_months, v_timezone
    FROM client_documents AS d
    JOIN clients AS c ON c.tenant_id = d.tenant_id AND c.id = d.client_id
    JOIN tenants AS t ON t.id = d.tenant_id
   WHERE d.id = p_document_id AND d.tenant_id = @app_tenant_id AND d.deleted_at IS NULL;
  IF v_found = 0 THEN
    RETURN 0;
  END IF;
  IF v_anonymized = 1 THEN
    RETURN 1;
  END IF;
  IF v_status = 'refused' THEN
    RETURN IF(v_reviewed < TIMESTAMPADD(MONTH, -v_refused_months, CURRENT_TIMESTAMP(3)), 1, 0);
  END IF;
  RETURN IF(client_last_activity_on(v_client) < DATE_SUB(
              rgpd_local_date(CURRENT_TIMESTAMP(3), v_timezone), INTERVAL v_months MONTH), 1, 0);
END;
--> statement-breakpoint

-- Marque une pièce purgée, une fois son fichier effacé du stockage. Revérifie
-- l'échéance : l'application peut purger, jamais choisir quoi. Rend 1 si la
-- pièce était échue et vient d'être marquée.
DROP FUNCTION IF EXISTS mark_client_document_purged;
--> statement-breakpoint
CREATE FUNCTION mark_client_document_purged(p_document_id CHAR(36)) RETURNS TINYINT
NOT DETERMINISTIC MODIFIES SQL DATA SQL SECURITY DEFINER
BEGIN
  DECLARE v_previous VARCHAR(16) DEFAULT @app_client_document_purge;
  DECLARE v_done TINYINT DEFAULT 0;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @app_client_document_purge = v_previous;
    RESIGNAL;
  END;
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA021: La purge des pièces est une tâche du back-office.';
  END IF;
  IF client_document_expired(p_document_id) = 0 THEN
    RETURN 0;
  END IF;
  SET @app_client_document_purge = 'on';
  UPDATE client_documents
     SET deleted_at = CURRENT_TIMESTAMP(3)
   WHERE id = p_document_id AND tenant_id = @app_tenant_id AND deleted_at IS NULL;
  SET v_done = IF(ROW_COUNT() > 0, 1, 0);
  SET @app_client_document_purge = v_previous;
  RETURN v_done;
END;
--> statement-breakpoint

-- Purge du journal des consultations des pièces, au terme de
-- `tenants.client_document_access_log_retention_months` (modèle :
-- `purge_expired_inspection_photo_views()`). Pour le centre courant seulement.
DROP FUNCTION IF EXISTS purge_expired_client_document_views;
--> statement-breakpoint
CREATE FUNCTION purge_expired_client_document_views() RETURNS INT
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
    FROM client_document_views AS views
    JOIN tenants ON tenants.id = views.tenant_id
   WHERE tenants.id = @app_tenant_id
     AND views.viewed_at
         < TIMESTAMPADD(MONTH, -tenants.client_document_access_log_retention_months, CURRENT_TIMESTAMP(3));
  SET v_count = ROW_COUNT();
  SET @app_journal_purge = v_previous;
  RETURN v_count;
END;
