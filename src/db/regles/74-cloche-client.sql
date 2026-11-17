-- Règles de l'espace client, recette du 17/11/2026, lot 4 (ADR 077) :
--
-- 1. client_notification_reads : le « lu » de la cloche de l'espace client ;
-- 2. client_bell_settings : le réglage de la cloche, back-office seul ;
-- 3. client_members.phone : le téléphone saisi dans « Mon compte », effacé à
--    l'anonymisation.
--
-- Refus métier : CA023 (`DB_CLIENT_BELL_REFUSED`, src/db/errors.ts). Portée
-- client : CA015, comme 30-clients.sql. Réglage du back-office : erreur 1142,
-- comme les modèles de messages (70-notifications.sql).
--
-- `@app_client_ids` a la collation de la connexion : copie dans une variable
-- locale avant `FIND_IN_SET` (voir l'en-tête de 30-clients.sql).
--
-- Le message d'un SIGNAL tient en 128 caractères, préfixe compris.
-- Idempotent : chaque objet est supprimé puis recréé.

-- ---------------------------------------------------------------------------
-- 1. Le « lu » de la cloche
-- ---------------------------------------------------------------------------
-- Une personne ne marque lue qu'une nouveauté de son entreprise : une ligne
-- du journal des messages adressée au client (`audience = 'client'`), à
-- l'entreprise de l'accès, dans le même centre. La clé étrangère vers
-- `client_members` tient déjà l'accès dans son entreprise.
DROP TRIGGER IF EXISTS client_notification_reads_before_insert;
--> statement-breakpoint
CREATE TRIGGER client_notification_reads_before_insert
BEFORE INSERT ON client_notification_reads
FOR EACH ROW
BEGIN
  DECLARE v_ids text;
  DECLARE v_found int DEFAULT 0;
  SET v_ids = @app_client_ids;
  IF v_ids IS NOT NULL AND (NOT FIND_IN_SET(NEW.client_id, v_ids)) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA015: Écriture refusée : cette ligne n''appartient pas aux entreprises de votre compte.';
  END IF;
  SELECT COUNT(*) INTO v_found
    FROM notification_deliveries AS d
   WHERE d.id = NEW.delivery_id
     AND d.tenant_id = NEW.tenant_id
     AND d.audience = 'client'
     AND d.client_id = NEW.client_id;
  IF v_found = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA023: Cette nouveauté n''est pas adressée à l''entreprise de cet accès.';
  END IF;
END;
--> statement-breakpoint

-- Une lecture reste celle de sa nouveauté et de sa personne.
DROP TRIGGER IF EXISTS client_notification_reads_before_update;
--> statement-breakpoint
CREATE TRIGGER client_notification_reads_before_update
BEFORE UPDATE ON client_notification_reads
FOR EACH ROW
BEGIN
  DECLARE v_ids text;
  SET v_ids = @app_client_ids;
  IF v_ids IS NOT NULL AND (NOT FIND_IN_SET(OLD.client_id, v_ids) OR NOT FIND_IN_SET(NEW.client_id, v_ids)) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA015: Écriture refusée : cette ligne n''appartient pas aux entreprises de votre compte.';
  END IF;
  IF NOT (NEW.delivery_id <=> OLD.delivery_id) OR NOT (NEW.client_id <=> OLD.client_id)
     OR NOT (NEW.client_member_id <=> OLD.client_member_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA023: Une lecture reste celle de sa nouveauté et de sa personne.';
  END IF;
END;
--> statement-breakpoint

-- Depuis l'espace client, une nouveauté lue ne redevient pas non lue. La
-- purge du journal efface ses lectures par la clé étrangère en cascade, qui
-- ne passe pas par ce trigger.
DROP TRIGGER IF EXISTS client_notification_reads_before_delete;
--> statement-breakpoint
CREATE TRIGGER client_notification_reads_before_delete
BEFORE DELETE ON client_notification_reads
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA023: Une nouveauté lue ne redevient pas non lue.';
  END IF;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Réglage de la cloche : back-office seul
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS client_bell_settings_before_insert;
--> statement-breakpoint
CREATE TRIGGER client_bell_settings_before_insert
BEFORE INSERT ON client_bell_settings
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Le réglage de la cloche de l''espace client est réservé au back-office.';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS client_bell_settings_before_update;
--> statement-breakpoint
CREATE TRIGGER client_bell_settings_before_update
BEFORE UPDATE ON client_bell_settings
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Le réglage de la cloche de l''espace client est réservé au back-office.';
  END IF;
END;
--> statement-breakpoint

-- Revenir aux valeurs par défaut, c'est les réécrire : pas de suppression.
DROP TRIGGER IF EXISTS client_bell_settings_before_delete;
--> statement-breakpoint
CREATE TRIGGER client_bell_settings_before_delete
BEFORE DELETE ON client_bell_settings
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'CA023: Le réglage de la cloche se réécrit, il ne se supprime pas.';
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Téléphone, prénom et nom d'un accès : effacés à l'anonymisation
-- ---------------------------------------------------------------------------
-- Les routines d'anonymisation (90-rgpd.sql) effacent l'adresse et le nom
-- complet ; ce trigger efface le téléphone, et le prénom et le nom saisis
-- séparément (ADR 084), dans la même écriture, sans les modifier. Les
-- contraintes `client_members_anonymized_no_phone` et
-- `client_members_anonymized_no_names` le vérifient ensuite.
DROP TRIGGER IF EXISTS client_members_clear_phone_when_anonymized;
--> statement-breakpoint
CREATE TRIGGER client_members_clear_phone_when_anonymized
BEFORE UPDATE ON client_members
FOR EACH ROW
BEGIN
  IF NEW.anonymized_at IS NOT NULL THEN
    SET NEW.phone = NULL;
    SET NEW.first_name = NULL;
    SET NEW.last_name = NULL;
  END IF;
END;
