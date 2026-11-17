-- Courrier côté équipe (ADR 079) : le contenu numérisé se valide avant
-- d'être montré au client. Idempotent : rejoué par le migrateur dès que le
-- fichier change.
--
-- L'accueil dépose le contenu d'une ouverture ou d'une numérisation demandée
-- (`mail_scans.pending_validation` vrai), le relit dans l'aperçu, le remplace
-- au besoin, puis le valide : c'est à ce moment seulement que le pli est
-- ouvert ou la demande faite, que le client voit le document et qu'il en est
-- prévenu. Ce que la base tient, quel que soit le chemin d'écriture —
-- SQLSTATE `CA025` :
--
-- - un dépôt à valider ne naît que sur un pli présent, pour une demande en
--   cours, ou pour une ouverture d'un pli encore fermé ;
-- - un contenu validé ne redevient jamais « à valider » ;
-- - un dépôt remplacé ou purgé (`deleted_at`) ne se valide plus ;
-- - la validation suit le geste qu'elle publie : le pli est ouvert (ouverture,
--   demandée ou d'office), ou la numérisation demandée est faite ;
-- - rien de tout cela ne s'écrit depuis l'espace client.
--
-- Les triggers de `60-courrier.sql` sur `mail_scans` (portée client, nombre de
-- pages) restent : ceux-ci s'y ajoutent, MySQL en enchaîne plusieurs par
-- événement.

DROP TRIGGER IF EXISTS mail_scans_validation_before_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS mail_scans_validation_before_update;
--> statement-breakpoint

CREATE TRIGGER mail_scans_validation_before_insert
BEFORE INSERT ON mail_scans
FOR EACH ROW
BEGIN
  DECLARE v_found INT DEFAULT 0;
  DECLARE v_deleted TINYINT DEFAULT 0;
  DECLARE v_opened TINYINT DEFAULT 0;
  DECLARE v_status VARCHAR(16);
  IF NEW.pending_validation THEN
    IF @app_client_ids IS NOT NULL THEN
      SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
        MESSAGE_TEXT = 'Écriture refusée : le contenu d''un courrier se dépose au centre.';
    END IF;
    SELECT COUNT(*), COALESCE(MAX(deleted_at IS NOT NULL), 0), COALESCE(MAX(opened_at IS NOT NULL), 0)
      INTO v_found, v_deleted, v_opened
      FROM mail_items
     WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_item_id;
    IF v_found = 0 OR v_deleted = 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA025: Ce courrier a été retiré : aucun contenu ne s''y dépose.';
    END IF;
    IF NEW.mail_request_id IS NULL THEN
      IF v_opened = 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
          'CA025: Ce courrier est déjà ouvert : son contenu a déjà été validé.';
      END IF;
    ELSE
      SELECT status INTO v_status
        FROM mail_requests
       WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_request_id;
      IF v_status IS NULL OR v_status NOT IN ('requested', 'in_progress') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
          'CA025: Cette demande n''est plus en cours : aucun contenu ne s''y dépose.';
      END IF;
    END IF;
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER mail_scans_validation_before_update
BEFORE UPDATE ON mail_scans
FOR EACH ROW
BEGIN
  DECLARE v_opened TINYINT DEFAULT 0;
  DECLARE v_kind VARCHAR(16);
  DECLARE v_status VARCHAR(16);
  IF NOT (NEW.pending_validation <=> OLD.pending_validation) THEN
    IF @app_client_ids IS NOT NULL THEN
      SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
        MESSAGE_TEXT = 'Écriture refusée : le contenu d''un courrier se valide au centre.';
    END IF;
    IF NEW.pending_validation THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA025: Un contenu validé ne redevient pas à valider.';
    END IF;
    IF NEW.deleted_at IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA025: Ce dépôt a été remplacé ou purgé : il ne se valide plus.';
    END IF;
    SELECT COALESCE(MAX(opened_at IS NOT NULL), 0) INTO v_opened
      FROM mail_items
     WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_item_id AND deleted_at IS NULL;
    IF NEW.mail_request_id IS NOT NULL THEN
      SELECT kind, status INTO v_kind, v_status
        FROM mail_requests
       WHERE tenant_id = NEW.tenant_id AND id = NEW.mail_request_id;
    END IF;
    IF v_kind = 'scan' THEN
      IF v_status <> 'done' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
          'CA025: Une numérisation demandée se valide en faisant la demande.';
      END IF;
    ELSEIF v_opened = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA025: Le contenu d''une ouverture se valide en ouvrant le pli.';
    END IF;
  END IF;
END;
