-- Règles du module notifications (R26, ADR 038) : notification_templates,
-- notification_deliveries, notification_preferences.
--
-- Portées des migrations PostgreSQL 0039 (fonctions de classement des
-- événements), 0040 (contraintes) et 0042 (portée client, ajout seul, purge).
-- Voir docs/migration-mysql/routines-notifications.md.
--
-- Contraintes `CHECK` : dans le schéma Drizzle, sauf `audience_matches`, qui
-- appelle une fonction stockée (interdit dans un `CHECK` MySQL) : trigger.
--
-- Le message d'un SIGNAL tient en 128 caractères.

DROP TRIGGER IF EXISTS notification_deliveries_before_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS notification_deliveries_before_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS notification_deliveries_before_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS notification_templates_before_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS notification_templates_before_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS notification_templates_before_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS notification_preferences_before_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS notification_preferences_before_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS notification_preferences_before_delete;
--> statement-breakpoint
DROP PROCEDURE IF EXISTS purge_expired_notification_deliveries;
--> statement-breakpoint
DROP FUNCTION IF EXISTS notification_event_audience;
--> statement-breakpoint
DROP FUNCTION IF EXISTS notification_event_category;
--> statement-breakpoint
DROP FUNCTION IF EXISTS notification_event_unknown;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. Classement des événements (migration 0039)
-- ---------------------------------------------------------------------------
-- Erreur commune des deux fonctions suivantes : un événement ajouté à
-- l'énumération sans être classé fait échouer l'écriture au lieu de passer
-- (un `NULL` satisferait la comparaison).
CREATE FUNCTION notification_event_unknown(p_event varchar(64)) RETURNS varchar(16)
DETERMINISTIC NO SQL
BEGIN
  DECLARE v_message varchar(128);
  SET v_message = LEFT(CONCAT('Événement de notification inconnu : « ', COALESCE(p_event, ''),
    ' ». Classez-le dans notification_event_audience().'), 128);
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  RETURN NULL;
END
--> statement-breakpoint

-- À qui s'adresse un événement : `client` (les personnes de l'entreprise) ou
-- `centre` (l'adresse du centre). Miroir : `notificationEventAudience`
-- (src/modules/notifications/schema.ts).
CREATE FUNCTION notification_event_audience(p_event varchar(64)) RETURNS varchar(16)
DETERMINISTIC NO SQL
BEGIN
  RETURN CASE p_event
    WHEN 'mail_received' THEN 'client'
    WHEN 'mail_scanned' THEN 'client'
    WHEN 'mail_request_submitted' THEN 'centre'
    WHEN 'mail_request_done' THEN 'client'
    WHEN 'mail_request_refused' THEN 'client'
    WHEN 'booking_request_submitted' THEN 'centre'
    WHEN 'booking_request_accepted' THEN 'client'
    WHEN 'booking_request_refused' THEN 'client'
    WHEN 'booking_confirmed' THEN 'client'
    WHEN 'booking_cancelled' THEN 'client'
    WHEN 'invoice_issued' THEN 'client'
    WHEN 'invoice_reminder' THEN 'client'
    WHEN 'contract_activated' THEN 'client'
    WHEN 'inspection_to_sign' THEN 'client'
    WHEN 'inspection_signed' THEN 'centre'
    WHEN 'member_invited' THEN 'client'
    WHEN 'offer_requested' THEN 'centre'
    WHEN 'mail_batch_received' THEN 'client'
    WHEN 'mail_none' THEN 'client'
    WHEN 'domiciliation_request_submitted' THEN 'centre'
    ELSE notification_event_unknown(p_event)
  END;
END
--> statement-breakpoint

-- Catégorie de préférence d'un événement, ou NULL : l'événement part toujours
-- (accès ouvert, messages au centre). Miroir : `notificationEventCategory`.
CREATE FUNCTION notification_event_category(p_event varchar(64)) RETURNS varchar(16)
DETERMINISTIC NO SQL
BEGIN
  RETURN CASE p_event
    WHEN 'mail_received' THEN 'mail'
    WHEN 'mail_scanned' THEN 'mail'
    WHEN 'mail_request_done' THEN 'mail'
    WHEN 'mail_request_refused' THEN 'mail'
    WHEN 'booking_request_accepted' THEN 'bookings'
    WHEN 'booking_request_refused' THEN 'bookings'
    WHEN 'booking_confirmed' THEN 'bookings'
    WHEN 'booking_cancelled' THEN 'bookings'
    WHEN 'invoice_issued' THEN 'invoices'
    WHEN 'invoice_reminder' THEN 'invoices'
    WHEN 'contract_activated' THEN 'contracts'
    WHEN 'inspection_to_sign' THEN 'inspections'
    WHEN 'mail_batch_received' THEN 'mail'
    WHEN 'mail_none' THEN 'mail_none'
    WHEN 'mail_request_submitted' THEN NULL
    WHEN 'booking_request_submitted' THEN NULL
    WHEN 'inspection_signed' THEN NULL
    WHEN 'member_invited' THEN NULL
    WHEN 'offer_requested' THEN NULL
    WHEN 'domiciliation_request_submitted' THEN NULL
    ELSE notification_event_unknown(p_event)
  END;
END
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Journal des envois : ajout seul, audience fixée par l'événement
-- ---------------------------------------------------------------------------
-- Sous portée client (`@app_client_ids` non NULL), on n'écrit que pour une
-- entreprise de la liste et pour un message adressé au client : c'était la
-- politique restrictive de la migration 0042. Erreur 1142 : c'est le code que
-- PostgreSQL rendait (42501, violation de politique).
-- Ensuite, l'audience doit être celle de l'événement (ex-CHECK) : erreur 3819,
-- celle d'une contrainte CHECK.
CREATE TRIGGER notification_deliveries_before_insert
BEFORE INSERT ON notification_deliveries
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL AND NOT (
       NEW.audience = 'client'
       AND NEW.client_id IS NOT NULL
       AND FIND_IN_SET(NEW.client_id, @app_client_ids) > 0) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : hors de la portée client de ce compte.';
  END IF;
  IF NEW.audience <> notification_event_audience(NEW.event) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 3819,
      MESSAGE_TEXT = 'Check constraint ''notification_deliveries_audience_matches'' is violated.';
  END IF;
END
--> statement-breakpoint

-- Le journal ne se réécrit pas. Seules passent les routines qui posent
-- `@app_notification_purge` (purge) ou `@app_anonymization = 'on'`
-- (réécriture des destinataires d'un client anonymisé, module rgpd).
CREATE TRIGGER notification_deliveries_before_update
BEFORE UPDATE ON notification_deliveries
FOR EACH ROW
BEGIN
  IF @app_notification_purge IS NULL AND COALESCE(@app_anonymization, '') <> 'on' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Le journal des envois est en ajout seul : une ligne ne se modifie pas.';
  END IF;
  IF NEW.audience <> notification_event_audience(NEW.event) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 3819,
      MESSAGE_TEXT = 'Check constraint ''notification_deliveries_audience_matches'' is violated.';
  END IF;
END
--> statement-breakpoint

CREATE TRIGGER notification_deliveries_before_delete
BEFORE DELETE ON notification_deliveries
FOR EACH ROW
BEGIN
  IF @app_notification_purge IS NULL AND COALESCE(@app_anonymization, '') <> 'on' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Le journal des envois est en ajout seul : purge par la routine prévue.';
  END IF;
END
--> statement-breakpoint

-- Purge du journal au terme de `tenants.notification_log_retention_months`,
-- comptée depuis l'envoi, pour le centre courant (`@app_tenant_id`). Seule
-- porte d'effacement du journal : l'application peut purger, jamais choisir
-- quoi (modèle : purge du journal du courrier, migration 0024). Rend le
-- nombre de lignes effacées dans `p_count`. Procédure et non fonction : elle
-- écrit (voir routines-notifications.md).
CREATE PROCEDURE purge_expired_notification_deliveries(OUT p_count int)
SQL SECURITY DEFINER
BEGIN
  -- Le verrou du journal est remis, y compris sur erreur.
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @app_notification_purge = NULL;
    RESIGNAL;
  END;

  SET p_count = 0;
  SET @app_notification_purge = 1;
  DELETE d
    FROM notification_deliveries AS d
    JOIN tenants AS t ON t.id = d.tenant_id
   WHERE t.id = @app_tenant_id
     AND d.sent_at < TIMESTAMPADD(MONTH, -t.notification_log_retention_months, CURRENT_TIMESTAMP(3));
  SET p_count = ROW_COUNT();
  SET @app_notification_purge = NULL;
END
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Modèles : réglage du back-office, sans suppression
-- ---------------------------------------------------------------------------
CREATE TRIGGER notification_templates_before_insert
BEFORE INSERT ON notification_templates
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Les modèles de messages sont réservés au back-office.';
  END IF;
END
--> statement-breakpoint

CREATE TRIGGER notification_templates_before_update
BEFORE UPDATE ON notification_templates
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Les modèles de messages sont réservés au back-office.';
  END IF;
END
--> statement-breakpoint

-- Revenir au texte par défaut, c'est le réécrire : pas de suppression.
CREATE TRIGGER notification_templates_before_delete
BEFORE DELETE ON notification_templates
FOR EACH ROW
BEGIN
  IF @app_notification_purge IS NULL AND COALESCE(@app_anonymization, '') <> 'on' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Un modèle de message ne se supprime pas : réécrivez-le.';
  END IF;
END
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Préférences : une personne règle les siennes, sous portée client
-- ---------------------------------------------------------------------------
CREATE TRIGGER notification_preferences_before_insert
BEFORE INSERT ON notification_preferences
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL AND FIND_IN_SET(NEW.client_id, @app_client_ids) = 0 THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : hors de la portée client de ce compte.';
  END IF;
END
--> statement-breakpoint

CREATE TRIGGER notification_preferences_before_update
BEFORE UPDATE ON notification_preferences
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL
     AND (FIND_IN_SET(NEW.client_id, @app_client_ids) = 0
          OR FIND_IN_SET(OLD.client_id, @app_client_ids) = 0) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : hors de la portée client de ce compte.';
  END IF;
END
--> statement-breakpoint

-- Une préférence se change (upsert), elle ne se supprime pas.
CREATE TRIGGER notification_preferences_before_delete
BEFORE DELETE ON notification_preferences
FOR EACH ROW
BEGIN
  IF @app_notification_purge IS NULL AND COALESCE(@app_anonymization, '') <> 'on' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Une préférence se change, elle ne se supprime pas.';
  END IF;
END
