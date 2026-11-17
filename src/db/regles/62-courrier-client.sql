-- Courrier côté client, recette du 17/11/2026 (ADR 078) : catégories
-- proposées réglées par le centre et par chaque personne, carnet d'adresses de
-- réexpédition de l'entreprise. Idempotent : rejoué par le migrateur dès que
-- le fichier change (`src/db/migrer.ts`).
--
-- Ce que la base tient, quel que soit le chemin d'écriture — SQLSTATE `CA024` :
--
-- - portée client : une personne n'écrit que pour les entreprises de son
--   compte (42501, comme `60-courrier.sql`) ; les réglages du centre ne
--   s'écrivent jamais sous portée client ;
-- - un réglage de catégorie reste celui de sa personne et de sa catégorie ;
--   une adresse du carnet reste celle de son entreprise ;
-- - RGPD : le carnet d'adresses s'efface avec l'entreprise anonymisée, et les
--   noms donnés aux catégories proposées — du texte libre — avec la personne
--   ou l'entreprise anonymisée. Triggers `AFTER UPDATE` sur `clients` et
--   `client_members`, plutôt qu'une retouche de `90-rgpd.sql` : ils suivent
--   `anonymized_at`, posé par toutes les anonymisations (fiche, accès retiré,
--   tâche de nuit).
--
-- Au plus une adresse par défaut par entreprise : index unique
-- `mail_forward_addresses_default_key`, dans la structure.

-- ---------------------------------------------------------------------------
-- Catégories proposées, réglées par le centre
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS mail_category_defaults_before_insert;
--> statement-breakpoint
CREATE TRIGGER mail_category_defaults_before_insert
BEFORE INSERT ON mail_category_defaults
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : les catégories proposées sont réglées par le centre.';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS mail_category_defaults_before_update;
--> statement-breakpoint
CREATE TRIGGER mail_category_defaults_before_update
BEFORE UPDATE ON mail_category_defaults
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : les catégories proposées sont réglées par le centre.';
  END IF;
  IF NOT (NEW.category <=> OLD.category) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA024: Un réglage du centre reste celui de sa catégorie.';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS mail_category_defaults_before_delete;
--> statement-breakpoint
CREATE TRIGGER mail_category_defaults_before_delete
BEFORE DELETE ON mail_category_defaults
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : les catégories proposées sont réglées par le centre.';
  END IF;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Catégories proposées, réglées par une personne de l'espace client
-- ---------------------------------------------------------------------------
-- Même portée que le classement (ADR 044) : la clé étrangère tient la personne
-- dans son entreprise, les triggers refusent une entreprise hors de la portée.
DROP TRIGGER IF EXISTS mail_member_category_prefs_before_insert;
--> statement-breakpoint
CREATE TRIGGER mail_member_category_prefs_before_insert
BEFORE INSERT ON mail_member_category_prefs
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL AND NOT FIND_IN_SET(NEW.client_id, @app_client_ids) THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : ce réglage n''appartient pas à votre entreprise.';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS mail_member_category_prefs_before_update;
--> statement-breakpoint
CREATE TRIGGER mail_member_category_prefs_before_update
BEFORE UPDATE ON mail_member_category_prefs
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL AND (
       NOT FIND_IN_SET(OLD.client_id, @app_client_ids)
       OR NOT FIND_IN_SET(NEW.client_id, @app_client_ids)) THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : ce réglage n''appartient pas à votre entreprise.';
  END IF;
  IF NOT (NEW.client_id <=> OLD.client_id)
     OR NOT (NEW.client_member_id <=> OLD.client_member_id)
     OR NOT (NEW.category <=> OLD.category) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA024: Un réglage de catégorie reste celui de sa personne et de sa catégorie.';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS mail_member_category_prefs_before_delete;
--> statement-breakpoint
CREATE TRIGGER mail_member_category_prefs_before_delete
BEFORE DELETE ON mail_member_category_prefs
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL AND NOT FIND_IN_SET(OLD.client_id, @app_client_ids) THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : ce réglage n''appartient pas à votre entreprise.';
  END IF;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Carnet d'adresses de réexpédition de l'entreprise
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS mail_forward_addresses_before_insert;
--> statement-breakpoint
CREATE TRIGGER mail_forward_addresses_before_insert
BEFORE INSERT ON mail_forward_addresses
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL AND NOT FIND_IN_SET(NEW.client_id, @app_client_ids) THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : cette adresse n''appartient pas à votre entreprise.';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS mail_forward_addresses_before_update;
--> statement-breakpoint
CREATE TRIGGER mail_forward_addresses_before_update
BEFORE UPDATE ON mail_forward_addresses
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL AND (
       NOT FIND_IN_SET(OLD.client_id, @app_client_ids)
       OR NOT FIND_IN_SET(NEW.client_id, @app_client_ids)) THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : cette adresse n''appartient pas à votre entreprise.';
  END IF;
  IF NOT (NEW.client_id <=> OLD.client_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA024: Une adresse du carnet reste celle de son entreprise.';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS mail_forward_addresses_before_delete;
--> statement-breakpoint
CREATE TRIGGER mail_forward_addresses_before_delete
BEFORE DELETE ON mail_forward_addresses
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL AND NOT FIND_IN_SET(OLD.client_id, @app_client_ids) THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : cette adresse n''appartient pas à votre entreprise.';
  END IF;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RGPD : ce qui part avec l'entreprise ou la personne anonymisée
-- ---------------------------------------------------------------------------
-- Les demandes de réexpédition gardent leur adresse figée, anonymisée par
-- `anonymize_client` (`90-rgpd.sql`) ; le carnet, lui, n'a plus d'usage : il
-- est effacé. Les noms donnés aux catégories proposées redeviennent ceux du
-- centre ; masquage et rang restent, comme le classement.
DROP TRIGGER IF EXISTS clients_after_update_mail_client;
--> statement-breakpoint
CREATE TRIGGER clients_after_update_mail_client
AFTER UPDATE ON clients
FOR EACH ROW
BEGIN
  IF NEW.anonymized_at IS NOT NULL AND OLD.anonymized_at IS NULL THEN
    DELETE FROM mail_forward_addresses
     WHERE tenant_id = NEW.tenant_id AND client_id = NEW.id;
    UPDATE mail_member_category_prefs
       SET name = NULL
     WHERE tenant_id = NEW.tenant_id AND client_id = NEW.id AND name IS NOT NULL;
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS client_members_after_update_mail_client;
--> statement-breakpoint
CREATE TRIGGER client_members_after_update_mail_client
AFTER UPDATE ON client_members
FOR EACH ROW
BEGIN
  IF NEW.anonymized_at IS NOT NULL AND OLD.anonymized_at IS NULL THEN
    UPDATE mail_member_category_prefs
       SET name = NULL
     WHERE tenant_id = NEW.tenant_id AND client_member_id = NEW.id AND name IS NOT NULL;
  END IF;
END;
