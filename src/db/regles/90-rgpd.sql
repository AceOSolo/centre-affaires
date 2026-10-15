-- Anonymisation RGPD des clients, contacts, accès et membres de l'équipe
-- retirés (R29, ADR 040 et 041). Porte les migrations PostgreSQL 0043 et 0044
-- (état final : anonymisation tracée, demandes d'offre).
--
-- Anonymiser, jamais supprimer (décision 6) : la ligne reste, ses champs
-- personnels partent. Les factures émises, leurs lignes et leurs instantanés
-- d'acheteur ne sont jamais touchés : obligation de conservation de 10 ans
-- (art. L.123-22 du Code de commerce). Les documents de contrat archivés et
-- le journal des relances non plus : pièces justificatives (ADR 028, 034).
--
-- Les fonctions sont `SQL SECURITY DEFINER` : l'application déclenche, la
-- fonction choisit quoi. Refusées sous portée client (`@app_client_ids` non
-- nul) : c'est une tâche du back-office (CA012).
--
-- Écarts avec PostgreSQL (voir docs/migration-mysql/routines-rgpd.md) :
--
-- - `set_config('app.anonymization', …)` devient la variable de session
--   `@app_anonymization`, posée par `anonymize_client_rows` et
--   `anonymize_member_rows`, remise à sa valeur précédente (NULL) en sortie, y
--   compris sur erreur (EXIT HANDLER) ;
-- - une fonction MySQL ne rend pas « void » : les routines qui n'avaient pas de
--   valeur rendent 1 ;
-- - `MESSAGE_TEXT` tient en 128 caractères, préfixe `CAnnn: ` compris, et ne
--   prend qu'une variable ou un littéral ;
-- - `greatest()`/`least()` rendent NULL dès qu'un argument l'est : chaque
--   argument est ramené à une date plancher ou à l'autre borne ;
-- - `now()` est constant par instruction, non par transaction : le code
--   compte les lignes par différence avant/après.
--
-- - une variable de session (`@app_tenant_id`) a la collation de la CONNEXION ;
--   la comparer à une colonne `utf8mb4_0900_as_ci` lève l'erreur 1267 si la
--   connexion est en `utf8mb4_general_ci`. Chaque routine en prend donc une
--   copie dans une variable locale (`v_ctx`), qui a la collation de la base.
--
-- Les tables sont créées avant ce fichier ; les routines des autres modules
-- aussi (`derive_accounting_code` : 50-facturation.sql).

-- ---------------------------------------------------------------------------
-- 0. Jour du centre
-- ---------------------------------------------------------------------------
-- Le jour civil, dans le fuseau du centre, d'un instant UTC. Utilise les
-- tables de fuseaux de MySQL (`mysql_tzinfo_to_sql`). Repli pour
-- `Europe/Paris` seulement, quand elles sont absentes : heure d'été de
-- l'Union européenne (dernier dimanche de mars à 01:00 UTC jusqu'au dernier
-- dimanche d'octobre à 01:00 UTC). Tout autre fuseau sans tables : erreur
-- explicite plutôt qu'un jour faux.
DROP FUNCTION IF EXISTS rgpd_local_date;
--> statement-breakpoint
CREATE FUNCTION rgpd_local_date(p_instant datetime(3), p_timezone varchar(64))
RETURNS date
READS SQL DATA
BEGIN
  DECLARE v_local datetime(3);
  DECLARE v_year int;
  DECLARE v_march date;
  DECLARE v_october date;
  DECLARE v_dst_start datetime;
  DECLARE v_dst_end datetime;

  IF p_instant IS NULL THEN
    RETURN NULL;
  END IF;
  SET v_local = CONVERT_TZ(p_instant, '+00:00', p_timezone);
  IF v_local IS NULL THEN
    IF p_timezone = 'Europe/Paris' THEN
      SET v_year = YEAR(p_instant);
      SET v_march = DATE(CONCAT(v_year, '-03-31'));
      SET v_october = DATE(CONCAT(v_year, '-10-31'));
      SET v_dst_start = TIMESTAMP(DATE_SUB(v_march, INTERVAL (DAYOFWEEK(v_march) - 1) DAY), '01:00:00');
      SET v_dst_end = TIMESTAMP(DATE_SUB(v_october, INTERVAL (DAYOFWEEK(v_october) - 1) DAY), '01:00:00');
      IF p_instant >= v_dst_start AND p_instant < v_dst_end THEN
        SET v_local = DATE_ADD(p_instant, INTERVAL 2 HOUR);
      ELSE
        SET v_local = DATE_ADD(p_instant, INTERVAL 1 HOUR);
      END IF;
    ELSE
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Fuseaux horaires de MySQL non chargés : exécutez mysql_tzinfo_to_sql.';
    END IF;
  END IF;
  RETURN DATE(v_local);
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. Garde des lignes anonymisées
-- ---------------------------------------------------------------------------
-- `anonymized_at` n'est posé que par les routines `anonymize_*` (qui lèvent
-- `@app_anonymization`), et une ligne anonymisée ne change plus (CA012). Un
-- trigger MySQL n'a pas de `to_jsonb(NEW)` : la comparaison de « la ligne n'a
-- pas changé hors `updated_at` » est écrite colonne par colonne, avec `<=>`
-- (égalité qui tient compte des NULL). Les colonnes générées (`live`,
-- `primary_live`) en dérivent et ne sont pas comparées.

-- clients
DROP TRIGGER IF EXISTS clients_guard_anonymized_insert;
--> statement-breakpoint
CREATE TRIGGER clients_guard_anonymized_insert
BEFORE INSERT ON clients
FOR EACH ROW
BEGIN
  IF COALESCE(@app_anonymization, '') <> 'on' AND NEW.anonymized_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA012: L''anonymisation est posée par la base (fonctions anonymize_*), jamais à l''écriture.';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS clients_guard_anonymized_update;
--> statement-breakpoint
CREATE TRIGGER clients_guard_anonymized_update
BEFORE UPDATE ON clients
FOR EACH ROW
BEGIN
  DECLARE v_message varchar(128);
  IF COALESCE(@app_anonymization, '') <> 'on' THEN
    IF NOT (NEW.anonymized_at <=> OLD.anonymized_at) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'CA012: L''anonymisation est posée par la base (fonctions anonymize_*) : elle ne s''écrit ni ne s''efface.';
    END IF;
    IF OLD.anonymized_at IS NOT NULL AND NOT (
          NEW.id <=> OLD.id AND NEW.tenant_id <=> OLD.tenant_id AND NEW.name <=> OLD.name
      AND NEW.legal_form <=> OLD.legal_form AND NEW.siret <=> OLD.siret
      AND NEW.vat_number <=> OLD.vat_number AND NEW.email <=> OLD.email
      AND NEW.phone <=> OLD.phone AND NEW.address_line1 <=> OLD.address_line1
      AND NEW.address_line2 <=> OLD.address_line2 AND NEW.postal_code <=> OLD.postal_code
      AND NEW.city <=> OLD.city AND NEW.country <=> OLD.country AND NEW.status <=> OLD.status
      AND NEW.notes <=> OLD.notes AND NEW.accounting_code <=> OLD.accounting_code
      AND NEW.last_contact_on <=> OLD.last_contact_on AND NEW.created_at <=> OLD.created_at
      AND NEW.deleted_at <=> OLD.deleted_at AND NEW.anonymized_by <=> OLD.anonymized_by
      AND NEW.anonymization_basis <=> OLD.anonymization_basis
      AND NEW.erasure_requested_on <=> OLD.erasure_requested_on
    ) THEN
      SET v_message = CONCAT('CA012: Cette ligne a été anonymisée le ', DATE_FORMAT(OLD.anonymized_at, '%d/%m/%Y'), ' : elle ne change plus.');
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
    END IF;
  END IF;
END;
--> statement-breakpoint

-- client_contacts
DROP TRIGGER IF EXISTS client_contacts_guard_anonymized_insert;
--> statement-breakpoint
CREATE TRIGGER client_contacts_guard_anonymized_insert
BEFORE INSERT ON client_contacts
FOR EACH ROW
BEGIN
  IF COALESCE(@app_anonymization, '') <> 'on' AND NEW.anonymized_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA012: L''anonymisation est posée par la base (fonctions anonymize_*), jamais à l''écriture.';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS client_contacts_guard_anonymized_update;
--> statement-breakpoint
CREATE TRIGGER client_contacts_guard_anonymized_update
BEFORE UPDATE ON client_contacts
FOR EACH ROW
BEGIN
  DECLARE v_message varchar(128);
  IF COALESCE(@app_anonymization, '') <> 'on' THEN
    IF NOT (NEW.anonymized_at <=> OLD.anonymized_at) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'CA012: L''anonymisation est posée par la base (fonctions anonymize_*) : elle ne s''écrit ni ne s''efface.';
    END IF;
    IF OLD.anonymized_at IS NOT NULL AND NOT (
          NEW.id <=> OLD.id AND NEW.tenant_id <=> OLD.tenant_id AND NEW.client_id <=> OLD.client_id
      AND NEW.full_name <=> OLD.full_name AND NEW.job_title <=> OLD.job_title
      AND NEW.email <=> OLD.email AND NEW.phone <=> OLD.phone
      AND NEW.is_primary <=> OLD.is_primary AND NEW.is_billing <=> OLD.is_billing
      AND NEW.notes <=> OLD.notes AND NEW.created_at <=> OLD.created_at
      AND NEW.deleted_at <=> OLD.deleted_at
    ) THEN
      SET v_message = CONCAT('CA012: Cette ligne a été anonymisée le ', DATE_FORMAT(OLD.anonymized_at, '%d/%m/%Y'), ' : elle ne change plus.');
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
    END IF;
  END IF;
END;
--> statement-breakpoint

-- client_members
DROP TRIGGER IF EXISTS client_members_guard_anonymized_insert;
--> statement-breakpoint
CREATE TRIGGER client_members_guard_anonymized_insert
BEFORE INSERT ON client_members
FOR EACH ROW
BEGIN
  IF COALESCE(@app_anonymization, '') <> 'on' AND NEW.anonymized_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA012: L''anonymisation est posée par la base (fonctions anonymize_*), jamais à l''écriture.';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS client_members_guard_anonymized_update;
--> statement-breakpoint
CREATE TRIGGER client_members_guard_anonymized_update
BEFORE UPDATE ON client_members
FOR EACH ROW
BEGIN
  DECLARE v_message varchar(128);
  IF COALESCE(@app_anonymization, '') <> 'on' THEN
    IF NOT (NEW.anonymized_at <=> OLD.anonymized_at) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'CA012: L''anonymisation est posée par la base (fonctions anonymize_*) : elle ne s''écrit ni ne s''efface.';
    END IF;
    IF OLD.anonymized_at IS NOT NULL AND NOT (
          NEW.id <=> OLD.id AND NEW.tenant_id <=> OLD.tenant_id AND NEW.client_id <=> OLD.client_id
      AND NEW.auth_user_id <=> OLD.auth_user_id AND NEW.email <=> OLD.email
      AND NEW.full_name <=> OLD.full_name AND NEW.created_at <=> OLD.created_at
      AND NEW.deleted_at <=> OLD.deleted_at AND NEW.anonymized_by <=> OLD.anonymized_by
      AND NEW.anonymization_basis <=> OLD.anonymization_basis
      AND NEW.erasure_requested_on <=> OLD.erasure_requested_on
    ) THEN
      SET v_message = CONCAT('CA012: Cette ligne a été anonymisée le ', DATE_FORMAT(OLD.anonymized_at, '%d/%m/%Y'), ' : elle ne change plus.');
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
    END IF;
  END IF;
END;
--> statement-breakpoint

-- staff_members (table de src/db/staff.ts, garde portée ici avec le reste de 0043)
DROP TRIGGER IF EXISTS staff_members_guard_anonymized_insert;
--> statement-breakpoint
CREATE TRIGGER staff_members_guard_anonymized_insert
BEFORE INSERT ON staff_members
FOR EACH ROW
BEGIN
  IF COALESCE(@app_anonymization, '') <> 'on' AND NEW.anonymized_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA012: L''anonymisation est posée par la base (fonctions anonymize_*), jamais à l''écriture.';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS staff_members_guard_anonymized_update;
--> statement-breakpoint
CREATE TRIGGER staff_members_guard_anonymized_update
BEFORE UPDATE ON staff_members
FOR EACH ROW
BEGIN
  DECLARE v_message varchar(128);
  IF COALESCE(@app_anonymization, '') <> 'on' THEN
    IF NOT (NEW.anonymized_at <=> OLD.anonymized_at) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'CA012: L''anonymisation est posée par la base (fonctions anonymize_*) : elle ne s''écrit ni ne s''efface.';
    END IF;
    IF OLD.anonymized_at IS NOT NULL AND NOT (
          NEW.id <=> OLD.id AND NEW.tenant_id <=> OLD.tenant_id
      AND NEW.auth_user_id <=> OLD.auth_user_id AND NEW.email <=> OLD.email
      AND NEW.full_name <=> OLD.full_name AND NEW.role <=> OLD.role
      AND NEW.created_at <=> OLD.created_at AND NEW.deleted_at <=> OLD.deleted_at
      AND NEW.anonymized_by <=> OLD.anonymized_by
      AND NEW.anonymization_basis <=> OLD.anonymization_basis
      AND NEW.erasure_requested_on <=> OLD.erasure_requested_on
    ) THEN
      SET v_message = CONCAT('CA012: Cette ligne a été anonymisée le ', DATE_FORMAT(OLD.anonymized_at, '%d/%m/%Y'), ' : elle ne change plus.');
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
    END IF;
  END IF;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Fin de la relation
-- ---------------------------------------------------------------------------
-- Dernier jour d'activité d'une entreprise, jour civil du centre : la date
-- dont part la durée de conservation (prospect sans contact, client après la
-- fin de la relation). Le plus tardif de :
--
-- - la création de la fiche, et le dernier contact noté (`last_contact_on`) ;
-- - pour chaque contrat : son dernier jour (le plus proche de la fin et de la
--   résiliation), aujourd'hui s'il est sans terme, la date de sa dernière
--   modification s'il est brouillon, la date d'archivage s'il est archivé ;
-- - la fin de la dernière réservation, ou son annulation si elle est
--   antérieure ;
-- - la réception du dernier pli, la dernière demande de courrier et la
--   dernière demande d'offre ;
-- - la dernière facture émise et le dernier paiement pointé ;
-- - le dernier état des lieux.
--
-- NULL pour un client inconnu du centre courant (`@app_tenant_id`).
-- Chaque terme est ramené à un plancher quand il est nul : `GREATEST` de
-- MySQL rend NULL dès qu'un argument l'est. `least(a, b)` de PostgreSQL
-- ignorait les nuls : `LEAST(COALESCE(a, b), COALESCE(b, a))`.
DROP FUNCTION IF EXISTS client_last_activity_on;
--> statement-breakpoint
CREATE FUNCTION client_last_activity_on(p_client_id char(36))
RETURNS date
READS SQL DATA
BEGIN
  DECLARE v_ctx char(36);
  SET v_ctx = @app_tenant_id;
  RETURN (
    SELECT GREATEST(
      rgpd_local_date(cl.created_at, t.timezone),
      COALESCE(cl.last_contact_on, DATE '1000-01-01'),
      COALESCE((SELECT MAX(CASE
                    WHEN k.deleted_at IS NOT NULL THEN rgpd_local_date(k.deleted_at, t.timezone)
                    WHEN k.status = 'draft' THEN rgpd_local_date(k.updated_at, t.timezone)
                    ELSE COALESCE(
                      LEAST(COALESCE(k.ends_on, k.terminated_on), COALESCE(k.terminated_on, k.ends_on)),
                      rgpd_local_date(CURRENT_TIMESTAMP(3), t.timezone))
                  END)
                  FROM contracts AS k
                 WHERE k.tenant_id = cl.tenant_id AND k.client_id = cl.id), DATE '1000-01-01'),
      COALESCE((SELECT MAX(rgpd_local_date(
                    CASE WHEN b.status = 'cancelled'
                         THEN LEAST(COALESCE(b.cancelled_at, b.ends_at), b.ends_at)
                         ELSE b.ends_at END, t.timezone))
                  FROM bookings AS b
                 WHERE b.tenant_id = cl.tenant_id AND b.client_id = cl.id AND b.kind = 'booking'),
               DATE '1000-01-01'),
      COALESCE((SELECT MAX(rgpd_local_date(m.received_at, t.timezone))
                  FROM mail_items AS m
                 WHERE m.tenant_id = cl.tenant_id AND m.client_id = cl.id), DATE '1000-01-01'),
      COALESCE((SELECT MAX(rgpd_local_date(r.requested_at, t.timezone))
                  FROM mail_requests AS r
                 WHERE r.tenant_id = cl.tenant_id AND r.client_id = cl.id), DATE '1000-01-01'),
      COALESCE((SELECT MAX(rgpd_local_date(o.requested_at, t.timezone))
                  FROM offer_requests AS o
                 WHERE o.tenant_id = cl.tenant_id AND o.client_id = cl.id), DATE '1000-01-01'),
      COALESCE((SELECT MAX(i.issue_date)
                  FROM invoices AS i
                 WHERE i.tenant_id = cl.tenant_id AND i.client_id = cl.id AND i.status <> 'draft'),
               DATE '1000-01-01'),
      COALESCE((SELECT MAX(p.paid_on)
                  FROM payments AS p
                  JOIN invoices AS i ON i.tenant_id = p.tenant_id AND i.id = p.invoice_id
                 WHERE p.tenant_id = cl.tenant_id AND i.client_id = cl.id AND p.cancelled_at IS NULL),
               DATE '1000-01-01'),
      COALESCE((SELECT MAX(rgpd_local_date(x.performed_at, t.timezone))
                  FROM inspections AS x
                 WHERE x.tenant_id = cl.tenant_id AND x.client_id = cl.id AND x.deleted_at IS NULL),
               DATE '1000-01-01')
    )
    FROM clients AS cl
    JOIN tenants AS t ON t.id = cl.tenant_id
   WHERE cl.id = p_client_id AND cl.tenant_id = v_ctx
  );
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Exclusions
-- ---------------------------------------------------------------------------
-- Ce qui empêche d'anonymiser une entreprise, en phrases pour l'écran, dans
-- un tableau JSON ; `[]` : rien ne l'empêche. NULL pour un client inconnu du
-- centre courant.
--
-- Une relation vivante, ou une obligation en cours, n'est jamais anonymisée :
-- facture non soldée ou brouillon de facture, contrat vivant (brouillon, en
-- cours, ou résilié à une date à venir), réservation à venir ou en cours,
-- service souscrit en cours, mandat de prélèvement actif, demande de courrier
-- en cours, demande d'offre à traiter, état des lieux en saisie. Une fiche
-- déjà anonymisée ne l'est pas deux fois.
--
-- Aucun `SELECT … INTO` qui pourrait ne rien rendre : un NOT FOUND non géré
-- remonterait au `CONTINUE HANDLER` des fonctions appelantes (boucles).
DROP FUNCTION IF EXISTS client_anonymization_blockers;
--> statement-breakpoint
CREATE FUNCTION client_anonymization_blockers(p_client_id char(36))
RETURNS json
READS SQL DATA
BEGIN
  DECLARE v_ctx char(36);
  DECLARE v_tenant char(36);
  DECLARE v_today date;
  DECLARE v_text text;
  DECLARE v_blockers json;

  SET v_ctx = @app_tenant_id;
  SET v_tenant = (SELECT cl.tenant_id FROM clients AS cl
                   WHERE cl.id = p_client_id AND cl.tenant_id = v_ctx);
  IF v_tenant IS NULL THEN
    RETURN NULL;
  END IF;
  SET v_today = rgpd_local_date(CURRENT_TIMESTAMP(3),
                                (SELECT t.timezone FROM tenants AS t WHERE t.id = v_tenant));
  SET v_blockers = JSON_ARRAY();

  IF (SELECT cl.anonymized_at FROM clients AS cl WHERE cl.id = p_client_id) IS NOT NULL THEN
    SET v_blockers = JSON_ARRAY_APPEND(v_blockers, '$', 'Fiche déjà anonymisée.');
  END IF;

  SET v_text = (SELECT CONCAT('Facture non soldée : ', GROUP_CONCAT(i.number ORDER BY i.number SEPARATOR ', '), '.')
                  FROM invoices AS i
                 WHERE i.tenant_id = v_tenant AND i.client_id = p_client_id AND i.kind = 'invoice'
                   AND i.status IN ('issued', 'partially_paid') AND i.deleted_at IS NULL);
  IF v_text IS NOT NULL THEN
    SET v_blockers = JSON_ARRAY_APPEND(v_blockers, '$', v_text);
  END IF;

  SET v_text = (SELECT IF(COUNT(*) > 0, 'Brouillon de facture ou d''avoir à émettre ou à abandonner.', NULL)
                  FROM invoices AS i
                 WHERE i.tenant_id = v_tenant AND i.client_id = p_client_id
                   AND i.status = 'draft' AND i.deleted_at IS NULL);
  IF v_text IS NOT NULL THEN
    SET v_blockers = JSON_ARRAY_APPEND(v_blockers, '$', v_text);
  END IF;

  SET v_text = (SELECT CONCAT('Contrat vivant : ', GROUP_CONCAT(k.reference ORDER BY k.reference SEPARATOR ', '), '.')
                  FROM contracts AS k
                 WHERE k.tenant_id = v_tenant AND k.client_id = p_client_id AND k.deleted_at IS NULL
                   AND (k.status = 'draft'
                        OR COALESCE(LEAST(COALESCE(k.ends_on, k.terminated_on),
                                          COALESCE(k.terminated_on, k.ends_on)),
                                    DATE '9999-12-31') >= v_today));
  IF v_text IS NOT NULL THEN
    SET v_blockers = JSON_ARRAY_APPEND(v_blockers, '$', v_text);
  END IF;

  SET v_text = (SELECT IF(COUNT(*) > 0, 'Réservation à venir ou en cours.', NULL)
                  FROM bookings AS b
                 WHERE b.tenant_id = v_tenant AND b.client_id = p_client_id AND b.kind = 'booking'
                   AND b.status <> 'cancelled' AND b.ends_at > CURRENT_TIMESTAMP(3));
  IF v_text IS NOT NULL THEN
    SET v_blockers = JSON_ARRAY_APPEND(v_blockers, '$', v_text);
  END IF;

  SET v_text = (SELECT IF(COUNT(*) > 0, 'Service souscrit en cours.', NULL)
                  FROM subscribed_services AS s
                 WHERE s.tenant_id = v_tenant AND s.client_id = p_client_id AND s.deleted_at IS NULL
                   AND (s.ends_on IS NULL OR s.ends_on >= v_today));
  IF v_text IS NOT NULL THEN
    SET v_blockers = JSON_ARRAY_APPEND(v_blockers, '$', v_text);
  END IF;

  SET v_text = (SELECT IF(COUNT(*) > 0, 'Mandat de prélèvement actif.', NULL)
                  FROM sepa_mandates AS m
                 WHERE m.tenant_id = v_tenant AND m.client_id = p_client_id
                   AND m.status = 'active' AND m.deleted_at IS NULL);
  IF v_text IS NOT NULL THEN
    SET v_blockers = JSON_ARRAY_APPEND(v_blockers, '$', v_text);
  END IF;

  SET v_text = (SELECT IF(COUNT(*) > 0, 'Demande de courrier en cours.', NULL)
                  FROM mail_requests AS r
                 WHERE r.tenant_id = v_tenant AND r.client_id = p_client_id
                   AND r.status IN ('requested', 'in_progress'));
  IF v_text IS NOT NULL THEN
    SET v_blockers = JSON_ARRAY_APPEND(v_blockers, '$', v_text);
  END IF;

  SET v_text = (SELECT IF(COUNT(*) > 0, 'Demande d''offre à traiter.', NULL)
                  FROM offer_requests AS o
                 WHERE o.tenant_id = v_tenant AND o.client_id = p_client_id AND o.status = 'requested');
  IF v_text IS NOT NULL THEN
    SET v_blockers = JSON_ARRAY_APPEND(v_blockers, '$', v_text);
  END IF;

  SET v_text = (SELECT IF(COUNT(*) > 0, 'État des lieux en saisie.', NULL)
                  FROM inspections AS x
                 WHERE x.tenant_id = v_tenant AND x.client_id = p_client_id
                   AND x.status = 'draft' AND x.deleted_at IS NULL);
  IF v_text IS NOT NULL THEN
    SET v_blockers = JSON_ARRAY_APPEND(v_blockers, '$', v_text);
  END IF;

  RETURN v_blockers;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Ce qu'une anonymisation à la demande doit dire
-- ---------------------------------------------------------------------------
-- Son fondement — demande d'effacement ou fin de la relation, jamais « au
-- terme », qui est celui de la tâche de nuit —, le membre vivant de l'équipe
-- qui la décide, et pour une demande d'effacement le jour où le centre l'a
-- reçue, jamais à venir. Un mois court depuis ce jour (art. 12-3 du RGPD).
-- Rend 1 (PostgreSQL : void) ; les refus sont des CA012.
DROP FUNCTION IF EXISTS anonymization_request_check;
--> statement-breakpoint
CREATE FUNCTION anonymization_request_check(
  p_by char(36),
  p_basis varchar(32),
  p_erasure_requested_on date
)
RETURNS int
READS SQL DATA
BEGIN
  DECLARE v_ctx char(36);
  SET v_ctx = @app_tenant_id;
  IF p_basis IS NULL OR p_basis NOT IN ('erasure_request', 'relationship_ended') THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA012: Une anonymisation à la demande dit son fondement : demande d''effacement, ou fin de la relation constatée.';
  END IF;
  IF p_by IS NULL OR NOT EXISTS (
    SELECT 1 FROM staff_members
     WHERE tenant_id = v_ctx AND id = p_by AND deleted_at IS NULL
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA012: Une anonymisation à la demande porte le membre de l''équipe qui la décide.';
  END IF;
  IF p_basis = 'erasure_request' AND p_erasure_requested_on IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA012: Une demande d''effacement se date : le jour où le centre l''a reçue.';
  END IF;
  IF p_basis <> 'erasure_request' AND p_erasure_requested_on IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA012: Seule une demande d''effacement porte une date de demande.';
  END IF;
  IF p_erasure_requested_on > rgpd_local_date(
       CURRENT_TIMESTAMP(3), (SELECT timezone FROM tenants WHERE id = v_ctx)
     ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA012: La demande d''effacement ne peut pas être datée d''un jour à venir.';
  END IF;
  RETURN 1;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Anonymisation d'un client
-- ---------------------------------------------------------------------------
-- Le geste lui-même, sans contrôle : réservé aux fonctions qui suivent, qui
-- vérifient le centre, la portée et les exclusions. Ce qui part :
--
-- - la fiche : raison sociale remplacée (« Client anonymisé » et le début de
--   l'identifiant, pour distinguer deux fiches dans un historique), forme,
--   SIRET, TVA, coordonnées, adresse, notes, dernier contact ; passée
--   `inactive`, archivée. Le compte auxiliaire (`accounting_code`) reste, et
--   est figé avant que la raison sociale ne parte : un client facturé sans
--   compte saisi garde celui que l'export lui donnait, dérivé de son ancien
--   nom (`derive_accounting_code`). Les assignations d'un `UPDATE` MySQL sont
--   évaluées de gauche à droite : `accounting_code` est donc écrit **avant**
--   `name` (PostgreSQL lisait l'ancienne ligne partout) ;
-- - ses contacts et ses accès : noms, coordonnées, notes ; les accès sont
--   détachés de leur compte et reçoivent une adresse inexistante
--   (`.invalid`, RFC 2606), avec l'auteur, le fondement et la date de la
--   demande ;
-- - ses plis : expéditeur et note ; ses demandes de courrier : consigne et
--   adresse de réexpédition ;
-- - ses réservations : coordonnées de demandeur et notes (l'objet reste) ;
--   (la date est posée avant d'effacer les coordonnées : assignations de gauche à droite) ;
-- - ses contrats : notes et motif de résiliation ;
-- - ses mandats non actifs : le nom du titulaire (l'IBAN reste chiffré, sa
--   durée propre est à construire, ADR 034) ;
-- - ses demandes d'offre : le motif d'un refus, saisi librement ;
-- - les messages journalisés à son sujet : destinataires et objet.
--
-- Restent intacts : factures, avoirs, lignes, paiements, instantanés,
-- relances, documents de contrat, états des lieux (pièces probantes).
DROP FUNCTION IF EXISTS anonymize_client_rows;
--> statement-breakpoint
CREATE FUNCTION anonymize_client_rows(
  p_client_id char(36),
  p_by char(36),
  p_basis varchar(32),
  p_erasure_requested_on date
)
RETURNS int
DETERMINISTIC
MODIFIES SQL DATA
SQL SECURITY DEFINER
BEGIN
  DECLARE v_previous varchar(16);
  DECLARE v_tenant char(36);
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @app_anonymization = v_previous;
    RESIGNAL;
  END;

  SET v_previous = @app_anonymization;
  SET v_tenant = (SELECT tenant_id FROM clients WHERE id = p_client_id);
  SET @app_anonymization = 'on';

  UPDATE clients
     SET accounting_code = COALESCE(accounting_code, CASE
           WHEN EXISTS (
             SELECT 1 FROM invoices AS i
              WHERE i.tenant_id = v_tenant AND i.client_id = p_client_id AND i.status <> 'draft'
           ) THEN derive_accounting_code(name)
         END),
         name = CONCAT('Client anonymisé ', LEFT(p_client_id, 8)),
         legal_form = NULL, siret = NULL, vat_number = NULL,
         email = NULL, phone = NULL,
         address_line1 = NULL, address_line2 = NULL, postal_code = NULL, city = NULL,
         notes = NULL, last_contact_on = NULL,
         status = 'inactive',
         anonymized_at = CURRENT_TIMESTAMP(3),
         anonymized_by = p_by,
         anonymization_basis = p_basis,
         erasure_requested_on = p_erasure_requested_on,
         deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP(3))
   WHERE tenant_id = v_tenant AND id = p_client_id;

  UPDATE client_contacts
     SET full_name = 'Contact anonymisé', job_title = NULL, email = NULL, phone = NULL,
         notes = NULL, is_primary = false, is_billing = false,
         anonymized_at = CURRENT_TIMESTAMP(3),
         deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP(3))
   WHERE tenant_id = v_tenant AND client_id = p_client_id AND anonymized_at IS NULL;

  UPDATE client_members
     SET email = CONCAT('anonyme-', id, '@anonymise.invalid'),
         full_name = 'Personne anonymisée',
         auth_user_id = NULL,
         anonymized_at = CURRENT_TIMESTAMP(3),
         anonymized_by = p_by,
         anonymization_basis = p_basis,
         erasure_requested_on = p_erasure_requested_on,
         deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP(3))
   WHERE tenant_id = v_tenant AND client_id = p_client_id AND anonymized_at IS NULL;

  UPDATE mail_items
     SET sender = NULL, note = NULL, sender_anonymized_at = CURRENT_TIMESTAMP(3)
   WHERE tenant_id = v_tenant AND client_id = p_client_id AND sender_anonymized_at IS NULL;

  UPDATE mail_requests
     SET client_note = NULL,
         forward_recipient = CASE WHEN kind = 'forward' THEN 'Destinataire anonymisé' END,
         forward_address_line1 = CASE WHEN kind = 'forward' THEN 'Adresse anonymisée' END,
         forward_address_line2 = NULL
   WHERE tenant_id = v_tenant AND client_id = p_client_id;

  UPDATE bookings
     SET requester_anonymized_at = CASE
           WHEN requester_name IS NOT NULL OR requester_email IS NOT NULL OR requester_phone IS NOT NULL
             THEN COALESCE(requester_anonymized_at, CURRENT_TIMESTAMP(3))
           ELSE requester_anonymized_at
         END,
         requester_name = NULL, requester_email = NULL, requester_phone = NULL,
         notes = NULL
   WHERE tenant_id = v_tenant AND client_id = p_client_id AND kind <> 'contract'
     AND (requester_name IS NOT NULL OR requester_email IS NOT NULL
          OR requester_phone IS NOT NULL OR notes IS NOT NULL);

  UPDATE contracts
     SET notes = NULL, termination_reason = NULL
   WHERE tenant_id = v_tenant AND client_id = p_client_id
     AND (notes IS NOT NULL OR termination_reason IS NOT NULL);

  UPDATE sepa_mandates
     SET debtor_name = 'Titulaire anonymisé'
   WHERE tenant_id = v_tenant AND client_id = p_client_id AND status <> 'active'
     AND debtor_name <> 'Titulaire anonymisé';

  UPDATE offer_requests
     SET dismissal_reason = NULL
   WHERE tenant_id = v_tenant AND client_id = p_client_id AND dismissal_reason IS NOT NULL;

  -- `array_fill` : autant d'adresses anonymes que de destinataires.
  UPDATE notification_deliveries
     SET recipients = IF(recipients IS NULL, NULL, CAST(CONCAT('[',
           TRIM(TRAILING ',' FROM REPEAT('"destinataire@anonymise.invalid",', JSON_LENGTH(recipients))),
         ']') AS JSON)),
         failed_recipients = IF(failed_recipients IS NULL, NULL, CAST(CONCAT('[',
           TRIM(TRAILING ',' FROM REPEAT('"destinataire@anonymise.invalid",', JSON_LENGTH(failed_recipients))),
         ']') AS JSON)),
         subject = 'Objet anonymisé'
   WHERE tenant_id = v_tenant AND client_id = p_client_id;

  SET @app_anonymization = v_previous;
  RETURN 1;
END;
--> statement-breakpoint

-- Anonymisation d'une entreprise à la demande (droit à l'effacement, fin de
-- relation constatée) : sans attendre sa durée, mais jamais contre une
-- exclusion — refus CA012, le message les énumère (abrégé à 128 caractères :
-- le code relit la liste complète par `client_anonymization_blockers`). La
-- fiche est verrouillée le temps du geste : une réservation ou une facture
-- créée en même temps attend, puis voit la fiche archivée.
DROP FUNCTION IF EXISTS anonymize_client;
--> statement-breakpoint
CREATE FUNCTION anonymize_client(
  p_client_id char(36),
  p_staff_member_id char(36),
  p_basis varchar(32),
  p_erasure_requested_on date
)
RETURNS int
DETERMINISTIC
MODIFIES SQL DATA
SQL SECURITY DEFINER
BEGIN
  DECLARE v_ctx char(36);
  DECLARE v_id char(36);
  DECLARE v_blockers json;
  DECLARE v_text text;
  DECLARE v_message varchar(600);

  SET v_ctx = @app_tenant_id;
  IF v_ctx IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA012: Anonymisation impossible hors du contexte d''un centre (@app_tenant_id).';
  END IF;
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA012: L''anonymisation est une tâche du back-office.';
  END IF;
  DO anonymization_request_check(p_staff_member_id, p_basis, p_erasure_requested_on);

  SET v_id = (SELECT id FROM clients
               WHERE tenant_id = v_ctx AND id = p_client_id
                 FOR UPDATE);
  IF v_id IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA012: Client introuvable dans ce centre.';
  END IF;

  SET v_blockers = client_anonymization_blockers(p_client_id);
  IF JSON_LENGTH(v_blockers) > 0 THEN
    SET v_text = (SELECT GROUP_CONCAT(jt.reason ORDER BY jt.n SEPARATOR ' ')
                    FROM JSON_TABLE(v_blockers, '$[*]'
                           COLUMNS (n FOR ORDINALITY, reason VARCHAR(500) PATH '$')) AS jt);
    SET v_message = CONCAT('CA012: Anonymisation refusée : ', v_text);
    IF CHAR_LENGTH(v_message) > 128 THEN
      SET v_message = CONCAT(LEFT(v_message, 127), '…');
    END IF;
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;

  DO anonymize_client_rows(p_client_id, p_staff_member_id, p_basis, p_erasure_requested_on);
  RETURN 1;
END;
--> statement-breakpoint

-- Anonymisation au terme des durées du centre (tâche nocturne) : un prospect
-- dont la dernière activité date de plus de `prospect_retention_months`, un
-- client (actif ou inactif) dont la relation a pris fin depuis plus de
-- `client_retention_months`. Les entreprises sous exclusion sont passées
-- sans erreur ; une fiche verrouillée par une autre transaction l'est au
-- passage suivant (`SKIP LOCKED`). Fondement « au terme », sans auteur. Rend
-- le nombre d'entreprises anonymisées.
DROP FUNCTION IF EXISTS anonymize_expired_clients;
--> statement-breakpoint
CREATE FUNCTION anonymize_expired_clients()
RETURNS int
DETERMINISTIC
MODIFIES SQL DATA
SQL SECURITY DEFINER
BEGIN
  DECLARE v_ctx char(36);
  DECLARE v_prospect_months int;
  DECLARE v_client_months int;
  DECLARE v_today date;
  DECLARE v_id char(36);
  DECLARE v_status varchar(16);
  DECLARE v_count int DEFAULT 0;
  DECLARE v_done int DEFAULT 0;
  DECLARE c_clients CURSOR FOR
    SELECT id, status FROM clients
     WHERE tenant_id = v_ctx AND anonymized_at IS NULL
     ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_done = 1;

  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA012: L''anonymisation est une tâche du back-office.';
  END IF;
  SET v_ctx = @app_tenant_id;
  SET v_prospect_months = (SELECT prospect_retention_months FROM tenants WHERE id = v_ctx);
  SET v_client_months = (SELECT client_retention_months FROM tenants WHERE id = v_ctx);
  IF v_prospect_months IS NULL THEN
    RETURN 0;
  END IF;
  SET v_today = rgpd_local_date(CURRENT_TIMESTAMP(3),
                                (SELECT timezone FROM tenants WHERE id = v_ctx));

  OPEN c_clients;
  clients_loop: LOOP
    FETCH c_clients INTO v_id, v_status;
    IF v_done = 1 THEN
      LEAVE clients_loop;
    END IF;
    -- Activité plus récente que la durée : la fiche reste.
    IF client_last_activity_on(v_id) >= DATE_SUB(
         v_today, INTERVAL IF(v_status = 'prospect', v_prospect_months, v_client_months) MONTH
       ) THEN
      ITERATE clients_loop;
    END IF;
    IF JSON_LENGTH(client_anonymization_blockers(v_id)) > 0 THEN
      ITERATE clients_loop;
    END IF;
    DO anonymize_client_rows(v_id, NULL, 'retention', NULL);
    SET v_count = v_count + 1;
  END LOOP;
  CLOSE c_clients;
  RETURN v_count;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Membres retirés : équipe et espace client
-- ---------------------------------------------------------------------------
-- Un membre retiré garde sa ligne : elle signe des plis, des numérisations,
-- des factures, des demandes, des consultations. Au terme de
-- `removed_member_retention_months` après son retrait, son nom et son adresse
-- partent, son compte est détaché. Un membre actif ne s'anonymise pas : il
-- faut d'abord le retirer. Rend 1 si la ligne a été anonymisée, 0 sinon.
DROP FUNCTION IF EXISTS anonymize_member_rows;
--> statement-breakpoint
CREATE FUNCTION anonymize_member_rows(
  p_table varchar(32),
  p_id char(36),
  p_by char(36),
  p_basis varchar(32),
  p_erasure_requested_on date
)
RETURNS int
DETERMINISTIC
MODIFIES SQL DATA
SQL SECURITY DEFINER
BEGIN
  DECLARE v_previous varchar(16);
  DECLARE v_ctx char(36);
  DECLARE v_done int DEFAULT 0;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @app_anonymization = v_previous;
    RESIGNAL;
  END;

  SET v_previous = @app_anonymization;
  SET v_ctx = @app_tenant_id;
  SET @app_anonymization = 'on';
  IF p_table = 'client_members' THEN
    UPDATE client_members
       SET email = CONCAT('anonyme-', id, '@anonymise.invalid'),
           full_name = 'Personne anonymisée', auth_user_id = NULL,
           anonymized_at = CURRENT_TIMESTAMP(3),
           anonymized_by = p_by, anonymization_basis = p_basis,
           erasure_requested_on = p_erasure_requested_on
     WHERE tenant_id = v_ctx AND id = p_id
       AND deleted_at IS NOT NULL AND anonymized_at IS NULL;
    SET v_done = ROW_COUNT();
  ELSE
    UPDATE staff_members
       SET email = CONCAT('anonyme-', id, '@anonymise.invalid'),
           full_name = 'Membre anonymisé', auth_user_id = NULL,
           anonymized_at = CURRENT_TIMESTAMP(3),
           anonymized_by = p_by, anonymization_basis = p_basis,
           erasure_requested_on = p_erasure_requested_on
     WHERE tenant_id = v_ctx AND id = p_id
       AND deleted_at IS NOT NULL AND anonymized_at IS NULL;
    SET v_done = ROW_COUNT();
  END IF;
  SET @app_anonymization = v_previous;
  RETURN IF(v_done > 0, 1, 0);
END;
--> statement-breakpoint

-- Membres retirés depuis plus que la durée du centre, des deux populations.
-- Rend le nombre de membres anonymisés.
DROP FUNCTION IF EXISTS anonymize_removed_members;
--> statement-breakpoint
CREATE FUNCTION anonymize_removed_members()
RETURNS int
DETERMINISTIC
MODIFIES SQL DATA
SQL SECURITY DEFINER
BEGIN
  DECLARE v_ctx char(36);
  DECLARE v_months int;
  DECLARE v_id char(36);
  DECLARE v_count int DEFAULT 0;
  DECLARE v_done int DEFAULT 0;
  DECLARE c_accesses CURSOR FOR
    SELECT id FROM client_members
     WHERE tenant_id = v_ctx AND anonymized_at IS NULL AND deleted_at IS NOT NULL
       AND deleted_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL v_months MONTH);
  DECLARE c_staff CURSOR FOR
    SELECT id FROM staff_members
     WHERE tenant_id = v_ctx AND anonymized_at IS NULL AND deleted_at IS NOT NULL
       AND deleted_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL v_months MONTH);
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_done = 1;

  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA012: L''anonymisation est une tâche du back-office.';
  END IF;
  SET v_ctx = @app_tenant_id;
  SET v_months = (SELECT removed_member_retention_months FROM tenants WHERE id = v_ctx);
  IF v_months IS NULL THEN
    RETURN 0;
  END IF;

  OPEN c_accesses;
  accesses_loop: LOOP
    FETCH c_accesses INTO v_id;
    IF v_done = 1 THEN
      LEAVE accesses_loop;
    END IF;
    SET v_count = v_count + anonymize_member_rows('client_members', v_id, NULL, 'retention', NULL);
  END LOOP;
  CLOSE c_accesses;

  SET v_done = 0;
  OPEN c_staff;
  staff_loop: LOOP
    FETCH c_staff INTO v_id;
    IF v_done = 1 THEN
      LEAVE staff_loop;
    END IF;
    SET v_count = v_count + anonymize_member_rows('staff_members', v_id, NULL, 'retention', NULL);
  END LOOP;
  CLOSE c_staff;
  RETURN v_count;
END;
--> statement-breakpoint

-- À la demande, sans attendre la durée : un accès client déjà retiré (refus
-- CA012 sinon).
DROP FUNCTION IF EXISTS anonymize_client_member;
--> statement-breakpoint
CREATE FUNCTION anonymize_client_member(
  p_member_id char(36),
  p_staff_member_id char(36),
  p_basis varchar(32),
  p_erasure_requested_on date
)
RETURNS int
DETERMINISTIC
MODIFIES SQL DATA
SQL SECURITY DEFINER
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA012: L''anonymisation est une tâche du back-office.';
  END IF;
  DO anonymization_request_check(p_staff_member_id, p_basis, p_erasure_requested_on);
  IF anonymize_member_rows('client_members', p_member_id, p_staff_member_id, p_basis, p_erasure_requested_on) = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA012: Seul un accès retiré, et pas encore anonymisé, s''anonymise : retirez-le d''abord.';
  END IF;
  RETURN 1;
END;
--> statement-breakpoint

-- Un membre de l'équipe déjà retiré, à sa demande.
DROP FUNCTION IF EXISTS anonymize_staff_member;
--> statement-breakpoint
CREATE FUNCTION anonymize_staff_member(
  p_staff_member_id char(36),
  p_by char(36),
  p_basis varchar(32),
  p_erasure_requested_on date
)
RETURNS int
DETERMINISTIC
MODIFIES SQL DATA
SQL SECURITY DEFINER
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA012: L''anonymisation est une tâche du back-office.';
  END IF;
  DO anonymization_request_check(p_by, p_basis, p_erasure_requested_on);
  IF anonymize_member_rows('staff_members', p_staff_member_id, p_by, p_basis, p_erasure_requested_on) = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'CA012: Seul un membre retiré de l''équipe, et pas encore anonymisé, s''anonymise : retirez-le d''abord.';
  END IF;
  RETURN 1;
END;
