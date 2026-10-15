-- Règles du module clients (tables `clients`, `client_members`, `client_contacts`).
-- Porté des migrations PostgreSQL 0005-0006, 0019-0020, 0025-0026.
--
-- Rien de métier dans ces tables côté base, hormis la portée client (ADR 019) :
-- PostgreSQL la tenait par des politiques RESTRICTIVE (lecture et écriture).
-- MySQL n'a pas de RLS : les LECTURES sont filtrées par le code (chaque requête
-- sous `withClientScope()` porte `inArray(clientId, clientIds)`, conventions
-- §6) ; les ÉCRITURES sont gardées ici, par trigger.
--
-- `@app_client_ids` : NULL hors portée (back-office), `''` portée vide, sinon
-- `id1,id2`. Une portée vide ne laisse rien passer (FIND_IN_SET rend 0).
-- Refus : CA015 (`DB_CLIENT_SCOPE_REFUSED`, même code que la facturation).
-- `MESSAGE_TEXT` : 128 caractères au plus, préfixe compris.
--
-- `@app_client_ids` a la collation de la connexion : `FIND_IN_SET` entre elle
-- et une colonne `utf8mb4_0900_as_ci` lève l'erreur 1267 si la connexion est
-- en `utf8mb4_general_ci`. Les triggers en prennent donc une copie dans une
-- variable locale, qui a la collation de la base.

DROP TRIGGER IF EXISTS clients_guard_client_scope_insert;
--> statement-breakpoint
CREATE TRIGGER clients_guard_client_scope_insert
BEFORE INSERT ON clients
FOR EACH ROW
BEGIN
  DECLARE v_ids text;
  SET v_ids = @app_client_ids;
  IF v_ids IS NOT NULL AND (NOT FIND_IN_SET(NEW.id, v_ids)) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA015: Écriture refusée : cette ligne n''appartient pas aux entreprises de votre compte.';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS clients_guard_client_scope_update;
--> statement-breakpoint
CREATE TRIGGER clients_guard_client_scope_update
BEFORE UPDATE ON clients
FOR EACH ROW
BEGIN
  DECLARE v_ids text;
  SET v_ids = @app_client_ids;
  IF v_ids IS NOT NULL AND (NOT FIND_IN_SET(OLD.id, v_ids) OR NOT FIND_IN_SET(NEW.id, v_ids)) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA015: Écriture refusée : cette ligne n''appartient pas aux entreprises de votre compte.';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS clients_guard_client_scope_delete;
--> statement-breakpoint
CREATE TRIGGER clients_guard_client_scope_delete
BEFORE DELETE ON clients
FOR EACH ROW
BEGIN
  DECLARE v_ids text;
  SET v_ids = @app_client_ids;
  IF v_ids IS NOT NULL AND (NOT FIND_IN_SET(OLD.id, v_ids)) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA015: Écriture refusée : cette ligne n''appartient pas aux entreprises de votre compte.';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS client_members_guard_client_scope_insert;
--> statement-breakpoint
CREATE TRIGGER client_members_guard_client_scope_insert
BEFORE INSERT ON client_members
FOR EACH ROW
BEGIN
  DECLARE v_ids text;
  SET v_ids = @app_client_ids;
  IF v_ids IS NOT NULL AND (NOT FIND_IN_SET(NEW.client_id, v_ids)) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA015: Écriture refusée : cette ligne n''appartient pas aux entreprises de votre compte.';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS client_members_guard_client_scope_update;
--> statement-breakpoint
CREATE TRIGGER client_members_guard_client_scope_update
BEFORE UPDATE ON client_members
FOR EACH ROW
BEGIN
  DECLARE v_ids text;
  SET v_ids = @app_client_ids;
  IF v_ids IS NOT NULL AND (NOT FIND_IN_SET(OLD.client_id, v_ids) OR NOT FIND_IN_SET(NEW.client_id, v_ids)) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA015: Écriture refusée : cette ligne n''appartient pas aux entreprises de votre compte.';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS client_members_guard_client_scope_delete;
--> statement-breakpoint
CREATE TRIGGER client_members_guard_client_scope_delete
BEFORE DELETE ON client_members
FOR EACH ROW
BEGIN
  DECLARE v_ids text;
  SET v_ids = @app_client_ids;
  IF v_ids IS NOT NULL AND (NOT FIND_IN_SET(OLD.client_id, v_ids)) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA015: Écriture refusée : cette ligne n''appartient pas aux entreprises de votre compte.';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS client_contacts_guard_client_scope_insert;
--> statement-breakpoint
CREATE TRIGGER client_contacts_guard_client_scope_insert
BEFORE INSERT ON client_contacts
FOR EACH ROW
BEGIN
  DECLARE v_ids text;
  SET v_ids = @app_client_ids;
  IF v_ids IS NOT NULL AND (NOT FIND_IN_SET(NEW.client_id, v_ids)) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA015: Écriture refusée : cette ligne n''appartient pas aux entreprises de votre compte.';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS client_contacts_guard_client_scope_update;
--> statement-breakpoint
CREATE TRIGGER client_contacts_guard_client_scope_update
BEFORE UPDATE ON client_contacts
FOR EACH ROW
BEGIN
  DECLARE v_ids text;
  SET v_ids = @app_client_ids;
  IF v_ids IS NOT NULL AND (NOT FIND_IN_SET(OLD.client_id, v_ids) OR NOT FIND_IN_SET(NEW.client_id, v_ids)) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA015: Écriture refusée : cette ligne n''appartient pas aux entreprises de votre compte.';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS client_contacts_guard_client_scope_delete;
--> statement-breakpoint
CREATE TRIGGER client_contacts_guard_client_scope_delete
BEFORE DELETE ON client_contacts
FOR EACH ROW
BEGIN
  DECLARE v_ids text;
  SET v_ids = @app_client_ids;
  IF v_ids IS NOT NULL AND (NOT FIND_IN_SET(OLD.client_id, v_ids)) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA015: Écriture refusée : cette ligne n''appartient pas aux entreprises de votre compte.';
  END IF;
END;
