-- Règles métier du module contrats (MySQL 8). Porté des migrations
-- PostgreSQL 0026/0027 (occupation sous contrat, référence automatique, portée
-- client), 0031 (contrats versionnés : lignes, avenants, documents, segments,
-- prix par version), 0032 (avenant et période déjà facturée), 0033/0034
-- (journal des reconductions) et 0044 (demandes d'offre). Voir
-- docs/migration-mysql/routines-contrats.md.
--
-- Un trigger MySQL ne porte qu'un événement : les triggers d'origine sont
-- éclatés par événement. Les triggers `updated_at` et `<table>_guard_tenant_*`
-- sont posés par le migrateur. Les messages de SIGNAL tiennent en 128
-- caractères (limite de MESSAGE_TEXT) : le code `CAnnn:` en préfixe est ce que
-- lit dbErrorCode().
--
-- Ce que la RLS faisait pour les lectures n'existe plus (conventions §6) : les
-- requêtes filtrent elles-mêmes. Ses `WITH CHECK` deviennent des gardes
-- d'écriture `FIND_IN_SET(client_id, @app_client_ids)` (CA015).

DROP TRIGGER IF EXISTS contracts_before_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contracts_before_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contracts_after_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contracts_after_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contract_lines_before_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contract_lines_before_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contract_lines_before_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contract_lines_after_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contract_lines_after_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contract_amendments_before_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contract_amendments_before_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contract_amendments_before_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contract_amendments_after_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contract_amendments_after_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contract_documents_before_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contract_documents_before_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contract_documents_before_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contract_renewals_before_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contract_renewals_before_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contract_renewals_before_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS offer_requests_before_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS offer_requests_before_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS offer_requests_before_delete;
--> statement-breakpoint
DROP PROCEDURE IF EXISTS apply_contract_occupation;
--> statement-breakpoint
DROP PROCEDURE IF EXISTS backfill_contract_occupations;
--> statement-breakpoint
DROP PROCEDURE IF EXISTS contract_lines_check;
--> statement-breakpoint
DROP PROCEDURE IF EXISTS contract_lines_sync_amount;
--> statement-breakpoint
DROP PROCEDURE IF EXISTS contract_amendment_assert_signable;
--> statement-breakpoint
DROP FUNCTION IF EXISTS contract_version_lines_amount;
--> statement-breakpoint
DROP FUNCTION IF EXISTS contract_earliest_end_on;
--> statement-breakpoint
DROP VIEW IF EXISTS contract_price_versions;
--> statement-breakpoint
DROP VIEW IF EXISTS contract_segments;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. Vues : versions de prix et segments de ressource (ADR 025)
-- ---------------------------------------------------------------------------
-- Dernier jour d'un contrat : le plus proche du terme prévu et de la
-- résiliation ; nul : sans terme. `LEAST` de MySQL rend NULL dès qu'un argument
-- l'est (PostgreSQL les ignorait) : d'où le CASE. Le NULL typé de la version
-- initiale s'écrit `NULLIF(k.id, k.id)` : un `CAST(NULL AS CHAR)` prendrait la
-- collation de la connexion et ferait échouer l'UNION (erreur 1271).

-- Segments d'occupation d'un contrat (ADR 025) : la ressource de la version
-- initiale depuis le premier jour, puis celle de chaque avenant signé qui la
-- change, à sa date d'effet, chacun jusqu'à la veille du suivant ; le dernier
-- jusqu'au dernier jour du contrat (nul : sans terme). Un avenant qui prend
-- effet après le dernier jour, ou un contrat résilié avant son début, ne donne
-- aucun segment. `resource_id` nul : rien n'est occupé sur le segment.
CREATE VIEW contract_segments AS
WITH bounds AS (
  SELECT k.tenant_id, k.id AS contract_id, k.starts_on AS first_day,
         CASE WHEN k.ends_on IS NULL THEN k.terminated_on
              WHEN k.terminated_on IS NULL THEN k.ends_on
              ELSE LEAST(k.ends_on, k.terminated_on) END AS last_day
    FROM contracts AS k
), changes AS (
  SELECT k.tenant_id, k.id AS contract_id,
         NULLIF(k.id, k.id) AS change_id,
         CAST(NULL AS SIGNED) AS change_number,
         k.resource_id AS change_resource,
         k.starts_on AS change_start
    FROM contracts AS k
  UNION ALL
  SELECT a.tenant_id, a.contract_id, a.id, a.number, a.resource_id, a.effective_on
    FROM contract_amendments AS a
    JOIN bounds AS b ON b.tenant_id = a.tenant_id AND b.contract_id = a.contract_id
   WHERE a.status = 'signed'
     AND a.changes_resource
     AND a.effective_on > b.first_day
     AND (b.last_day IS NULL OR a.effective_on <= b.last_day)
), ordered AS (
  SELECT c.*,
         LEAD(c.change_start) OVER (PARTITION BY c.contract_id ORDER BY c.change_start) AS next_start
    FROM changes AS c
)
SELECT o.tenant_id, o.contract_id,
       o.change_id AS amendment_id,
       o.change_number AS amendment_number,
       o.change_resource AS resource_id,
       o.change_start AS starts_on,
       CASE WHEN o.next_start IS NOT NULL THEN DATE_SUB(o.next_start, INTERVAL 1 DAY)
            ELSE b.last_day END AS ends_on
  FROM ordered AS o
  JOIN bounds AS b ON b.tenant_id = o.tenant_id AND b.contract_id = o.contract_id
 WHERE b.last_day IS NULL OR b.last_day >= b.first_day;
--> statement-breakpoint

-- Versions de prix d'un contrat (ADR 025) : la version initiale
-- (`contracts.amount_cents`) puis chaque avenant signé qui porte un montant,
-- de sa date d'effet à la veille du suivant ; la dernière jusqu'au dernier
-- jour du contrat (nul : sans terme). Les lignes d'une version sont les
-- `contract_lines` vivantes de même `amendment_id` (nul pour l'initiale) ;
-- sans ligne, la version se facture d'un montant, à `contracts.vat_rate_bp`.
CREATE VIEW contract_price_versions AS
WITH bounds AS (
  SELECT k.tenant_id, k.id AS contract_id, k.starts_on AS first_day,
         CASE WHEN k.ends_on IS NULL THEN k.terminated_on
              WHEN k.terminated_on IS NULL THEN k.ends_on
              ELSE LEAST(k.ends_on, k.terminated_on) END AS last_day
    FROM contracts AS k
), versions AS (
  SELECT k.tenant_id, k.id AS contract_id,
         NULLIF(k.id, k.id) AS version_id,
         CAST(NULL AS SIGNED) AS version_number,
         k.starts_on AS version_start,
         k.amount_cents AS version_amount
    FROM contracts AS k
  UNION ALL
  SELECT a.tenant_id, a.contract_id, a.id, a.number, a.effective_on, a.amount_cents
    FROM contract_amendments AS a
    JOIN bounds AS b ON b.tenant_id = a.tenant_id AND b.contract_id = a.contract_id
   WHERE a.status = 'signed'
     AND a.amount_cents IS NOT NULL
     AND a.effective_on > b.first_day
     AND (b.last_day IS NULL OR a.effective_on <= b.last_day)
), ordered AS (
  SELECT v.*,
         LEAD(v.version_start) OVER (PARTITION BY v.contract_id ORDER BY v.version_start) AS next_start
    FROM versions AS v
)
SELECT o.tenant_id, o.contract_id,
       o.version_id AS amendment_id,
       o.version_number AS amendment_number,
       o.version_start AS starts_on,
       CASE WHEN o.next_start IS NOT NULL THEN DATE_SUB(o.next_start, INTERVAL 1 DAY)
            ELSE b.last_day END AS ends_on,
       o.version_amount AS amount_cents
  FROM ordered AS o
  JOIN bounds AS b ON b.tenant_id = o.tenant_id AND b.contract_id = o.contract_id
 WHERE b.last_day IS NULL OR b.last_day >= b.first_day;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Fonctions de lecture
-- ---------------------------------------------------------------------------
-- Montant HT par période d'une version, tiré de ses lignes récurrentes
-- vivantes ; nul si elle n'en a aucune (le montant saisi vaut alors).
CREATE FUNCTION contract_version_lines_amount(
  p_tenant_id char(36),
  p_contract_id char(36),
  p_amendment_id char(36)
) RETURNS int
READS SQL DATA
BEGIN
  DECLARE v_count int;
  DECLARE v_sum bigint;
  SELECT COUNT(*), SUM(net_amount_cents)
    INTO v_count, v_sum
    FROM contract_lines
   WHERE tenant_id = p_tenant_id
     AND contract_id = p_contract_id
     AND amendment_id <=> p_amendment_id
     AND deleted_at IS NULL
     AND is_recurring = 1;
  RETURN IF(v_count = 0, NULL, v_sum);
END;
--> statement-breakpoint

-- Dernier jour possible d'un contrat si le préavis est donné ce jour-là
-- (R10, ADR 023) : le plus tardif du terme du préavis (jour de la demande
-- compris, comme `noticeEndsOn`) et du dernier jour d'engagement. `GREATEST`
-- de MySQL rend NULL sans engagement : d'où le IF.
CREATE FUNCTION contract_earliest_end_on(p_contract_id char(36), p_notice_on date) RETURNS date
READS SQL DATA
BEGIN
  DECLARE v_notice_days int;
  DECLARE v_commitment_ends_on date;
  DECLARE v_notice_end date;
  SELECT MAX(notice_days), MAX(commitment_ends_on)
    INTO v_notice_days, v_commitment_ends_on
    FROM contracts
   WHERE id = p_contract_id;
  SET v_notice_end = DATE_ADD(p_notice_on, INTERVAL GREATEST(v_notice_days - 1, 0) DAY);
  RETURN IF(v_commitment_ends_on IS NULL, v_notice_end, GREATEST(v_notice_end, v_commitment_ends_on));
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Occupation des ressources sous contrat (R02, R04, D6, ADR 018, ADR 025)
-- ---------------------------------------------------------------------------
-- Aligne l'occupation d'un contrat sur ses segments : une ligne de `bookings`
-- par segment qui désigne une ressource, clé (contract_id,
-- contract_amendment_id). Idempotente : ne réécrit que ce qui diffère.
--
-- Occupé : contrat non archivé, `active` ou `terminated`, et dont le dernier
-- jour n'est pas antérieur au premier. Un contrat résilié garde son occupation
-- jusqu'à sa date de résiliation : la ressource redevient libre le lendemain,
-- l'historique reste.
--
-- Les dates du contrat sont des jours civils du centre, bornes comprises
-- (ADR 006) : l'occupation va de minuit, heure du centre, au premier jour à
-- minuit le lendemain du dernier jour — bornes `[)` comme toute réservation.
-- Sans terme : `booking_open_end()`.
--
-- Trois temps, pour que le contrôle de chevauchement ne voie jamais deux
-- segments du même contrat se chevaucher : (1) annuler ce qui disparaît ou se
-- déplace, (2) réécrire les occupations dont le segment subsiste, (3) créer
-- celles qui manquent.
--
-- Pose `@app_contract_occupation_sync` le temps de l'écriture (le garde de
-- `bookings`, CA001, la lit), et la remet à NULL en sortie, erreur comprise.
-- Rapportée en PROCEDURE : elle écrit (une FUNCTION modifiante est refusée
-- sous binlog) et MySQL n'a pas de type ligne.
CREATE PROCEDURE apply_contract_occupation(IN p_contract_id char(36))
SQL SECURITY DEFINER
main: BEGIN
  DECLARE v_tenant_id char(36);
  DECLARE v_client_id char(36);
  DECLARE v_reference varchar(64);
  DECLARE v_status varchar(20);
  DECLARE v_starts_on date;
  DECLARE v_ends_on date;
  DECLARE v_terminated_on date;
  DECLARE v_deleted_at datetime(3);
  DECLARE v_resource_id char(36);
  DECLARE v_last_day date;
  DECLARE v_occupied tinyint DEFAULT 0;
  DECLARE v_time_zone varchar(64);
  DECLARE v_open_end datetime(3) DEFAULT booking_open_end();
  DECLARE v_message varchar(255);
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @app_contract_occupation_sync = NULL;
    RESIGNAL;
  END;

  -- Agrégats : un contrat introuvable donne des NULL, sans condition NOT FOUND.
  SELECT MAX(tenant_id), MAX(client_id), MAX(reference), MAX(status), MAX(starts_on),
         MAX(ends_on), MAX(terminated_on), MAX(deleted_at), MAX(resource_id)
    INTO v_tenant_id, v_client_id, v_reference, v_status, v_starts_on,
         v_ends_on, v_terminated_on, v_deleted_at, v_resource_id
    FROM contracts
   WHERE id = p_contract_id;
  IF v_tenant_id IS NULL THEN
    LEAVE main;
  END IF;

  SET v_last_day = CASE
    WHEN v_ends_on IS NULL THEN v_terminated_on
    WHEN v_terminated_on IS NULL THEN v_ends_on
    ELSE LEAST(v_ends_on, v_terminated_on)
  END;
  SET v_occupied = IF(
    v_deleted_at IS NULL
    AND v_status IN ('active', 'terminated')
    AND (v_last_day IS NULL OR v_last_day >= v_starts_on), 1, 0);

  IF v_occupied = 1 THEN
    SELECT MAX(timezone) INTO v_time_zone FROM tenants WHERE id = v_tenant_id;
    IF v_time_zone IS NULL THEN
      SET v_message = LEFT(CONCAT(
        'Fuseau du centre introuvable : impossible de dater l''occupation du contrat ',
        LEFT(v_reference, 40), '.'), 128);
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
    END IF;
    IF CONVERT_TZ('2000-01-01 00:00:00', v_time_zone, '+00:00') IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'Fuseaux horaires MySQL non chargés (mysql_tzinfo_to_sql) : occupation du contrat non datée.';
    END IF;
  END IF;

  SET @app_contract_occupation_sync = 'on';

  -- 1. Annuler ce qui ne doit plus occuper, libérer ce qui se déplace.
  UPDATE bookings AS b
    LEFT JOIN (
      SELECT s.amendment_id, s.resource_id,
             CONVERT_TZ(CAST(s.starts_on AS DATETIME), v_time_zone, '+00:00') AS range_start,
             IF(s.ends_on IS NULL, v_open_end,
                CONVERT_TZ(CAST(DATE_ADD(s.ends_on, INTERVAL 1 DAY) AS DATETIME),
                           v_time_zone, '+00:00')) AS range_end
        FROM contract_segments AS s
       WHERE v_occupied = 1
         AND s.tenant_id = v_tenant_id
         AND s.contract_id = p_contract_id
         AND s.resource_id IS NOT NULL
    ) AS w ON w.amendment_id <=> b.contract_amendment_id
     SET b.status = 'cancelled',
         b.cancelled_at = CURRENT_TIMESTAMP(3),
         b.cancellation_reason = CASE
           WHEN v_occupied = 1 AND w.resource_id IS NOT NULL THEN 'Occupation en cours de mise à jour'
           WHEN v_deleted_at IS NOT NULL THEN 'Contrat archivé'
           WHEN v_status = 'draft' THEN 'Contrat repassé en brouillon'
           WHEN v_last_day IS NOT NULL AND v_last_day < v_starts_on THEN 'Contrat résilié avant son début'
           WHEN b.contract_amendment_id IS NULL AND v_resource_id IS NULL THEN 'Ressource retirée du contrat'
           WHEN b.contract_amendment_id IS NOT NULL
             THEN 'Contrat résilié avant la date d''effet de l''avenant'
           ELSE 'Occupation remplacée par avenant'
         END
   WHERE b.tenant_id = v_tenant_id
     AND b.contract_id = p_contract_id
     AND b.kind = 'contract'
     AND b.status <> 'cancelled'
     AND (w.resource_id IS NULL
          OR b.resource_id <> w.resource_id
          OR b.starts_at <> w.range_start
          OR b.ends_at <> w.range_end);

  IF v_occupied = 1 THEN
    -- 2. Réécrire les occupations dont le segment subsiste, si elles diffèrent.
    UPDATE bookings AS b
      JOIN (
        SELECT s.amendment_id, s.resource_id,
               CONVERT_TZ(CAST(s.starts_on AS DATETIME), v_time_zone, '+00:00') AS range_start,
               IF(s.ends_on IS NULL, v_open_end,
                  CONVERT_TZ(CAST(DATE_ADD(s.ends_on, INTERVAL 1 DAY) AS DATETIME),
                             v_time_zone, '+00:00')) AS range_end,
               IF(s.amendment_id IS NULL,
                  CONCAT('Contrat ', v_reference),
                  CONCAT('Contrat ', v_reference, ' — avenant n° ', s.amendment_number)) AS title
          FROM contract_segments AS s
         WHERE s.tenant_id = v_tenant_id
           AND s.contract_id = p_contract_id
           AND s.resource_id IS NOT NULL
      ) AS w ON w.amendment_id <=> b.contract_amendment_id
       SET b.resource_id = w.resource_id,
           b.client_id = v_client_id,
           b.title = w.title,
           b.starts_at = w.range_start,
           b.ends_at = w.range_end,
           b.status = 'confirmed',
           b.cancelled_at = NULL,
           b.cancellation_reason = NULL
     WHERE b.tenant_id = v_tenant_id
       AND b.contract_id = p_contract_id
       AND b.kind = 'contract'
       AND (b.status <> 'confirmed'
            OR b.resource_id <> w.resource_id
            OR b.starts_at <> w.range_start
            OR b.ends_at <> w.range_end
            OR NOT (b.client_id <=> v_client_id)
            OR b.title <> w.title);

    -- 3. Créer l'occupation des segments qui n'en ont pas.
    INSERT INTO bookings (
      tenant_id, resource_id, contract_id, contract_amendment_id, client_id, kind, channel,
      status, title, starts_at, ends_at
    )
    SELECT v_tenant_id, w.resource_id, p_contract_id, w.amendment_id, v_client_id, 'contract',
           'staff', 'confirmed', w.title, w.range_start, w.range_end
      FROM (
        SELECT s.amendment_id, s.resource_id,
               CONVERT_TZ(CAST(s.starts_on AS DATETIME), v_time_zone, '+00:00') AS range_start,
               IF(s.ends_on IS NULL, v_open_end,
                  CONVERT_TZ(CAST(DATE_ADD(s.ends_on, INTERVAL 1 DAY) AS DATETIME),
                             v_time_zone, '+00:00')) AS range_end,
               IF(s.amendment_id IS NULL,
                  CONCAT('Contrat ', v_reference),
                  CONCAT('Contrat ', v_reference, ' — avenant n° ', s.amendment_number)) AS title
          FROM contract_segments AS s
         WHERE s.tenant_id = v_tenant_id
           AND s.contract_id = p_contract_id
           AND s.resource_id IS NOT NULL
      ) AS w
     WHERE NOT EXISTS (
       SELECT 1 FROM bookings AS e
        WHERE e.tenant_id = v_tenant_id
          AND e.contract_id = p_contract_id
          AND e.kind = 'contract'
          AND e.contract_amendment_id <=> w.amendment_id
     );
  END IF;

  SET @app_contract_occupation_sync = NULL;
END;
--> statement-breakpoint

-- Pose l'occupation de tous les contrats qui en appellent une (reprise de
-- données, ou rejeu après avoir résolu un conflit). Un contrat dont la
-- ressource est déjà occupée sur sa période (deux contrats actifs sur le même
-- bureau, une réservation horaire pendant le contrat) est compté dans
-- `p_skipped` et laissé sans occupation, au lieu de tout interrompre : c'est à
-- l'équipe de trancher. Les plus anciens contrats passent d'abord.
CREATE PROCEDURE backfill_contract_occupations(OUT p_skipped int)
SQL SECURITY DEFINER
BEGIN
  DECLARE v_id char(36);
  DECLARE v_done tinyint DEFAULT 0;
  DECLARE v_message text;
  DECLARE v_contracts CURSOR FOR
    SELECT id FROM contracts
     WHERE deleted_at IS NULL
       AND status IN ('active', 'terminated')
       AND resource_id IS NOT NULL
     ORDER BY starts_on, created_at, id;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_done = 1;

  SET p_skipped = 0;
  OPEN v_contracts;
  contracts_loop: LOOP
    FETCH v_contracts INTO v_id;
    IF v_done = 1 THEN
      LEAVE contracts_loop;
    END IF;
    BEGIN
      -- Seul le chevauchement (CA000) est toléré ; toute autre erreur remonte.
      DECLARE CONTINUE HANDLER FOR SQLSTATE '45000'
      BEGIN
        GET DIAGNOSTICS CONDITION 1 v_message = MESSAGE_TEXT;
        IF v_message LIKE 'CA000:%' THEN
          SET p_skipped = p_skipped + 1;
        ELSE
          RESIGNAL;
        END IF;
      END;
      CALL apply_contract_occupation(v_id);
    END;
  END LOOP;
  CLOSE v_contracts;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Contrats : référence automatique, version figée, occupation
-- ---------------------------------------------------------------------------
-- INSERT : référence attribuée quand elle est omise (valeur repère '@auto',
-- `CONTRACT_REFERENCE_AUTO`) : la suivante de la série du centre, en sautant
-- les numéros déjà portés par un contrat saisi à la main, archivé compris —
-- sans cela, une référence manuelle égale au numéro suivant bloquerait la
-- numérotation pour toujours. Un numéro sauté n'est pas un trou : il est porté
-- par ce contrat. Puis garde de portée client (WITH CHECK de
-- `contracts_client_scope`).
CREATE TRIGGER contracts_before_insert
BEFORE INSERT ON contracts
FOR EACH ROW
BEGIN
  DECLARE v_reference varchar(32);
  DECLARE v_taken int DEFAULT 1;

  IF NEW.reference = '@auto' THEN
    WHILE v_taken > 0 DO
      SET v_reference = next_document_number('contract');
      SELECT COUNT(*) INTO v_taken
        FROM contracts
       WHERE tenant_id = COALESCE(@app_tenant_id, NEW.tenant_id) AND reference = v_reference;
    END WHILE;
    SET NEW.reference = v_reference;
  END IF;

  IF @app_client_ids IS NOT NULL AND NOT FIND_IN_SET(NEW.client_id, @app_client_ids) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Écriture refusée : ce contrat n''appartient à aucune entreprise du compte connecté.';
  END IF;
END;
--> statement-breakpoint

-- UPDATE (contracts_guard_version, 0031) :
-- - le montant d'un brouillon suit ses lignes quand il en a (la valeur écrite
--   est ignorée) ;
-- - hors brouillon, prix, TVA, période, devise et engagement sont figés : ils
--   changent par avenant (CA004) ;
-- - un contrat qui a des avenants signés ne change plus de date de début.
CREATE TRIGGER contracts_before_update
BEFORE UPDATE ON contracts
FOR EACH ROW
BEGIN
  DECLARE v_amount int;
  DECLARE v_message varchar(255);

  IF OLD.status <> 'draft' THEN
    IF NOT (NEW.amount_cents <=> OLD.amount_cents
            AND NEW.vat_rate_bp <=> OLD.vat_rate_bp
            AND NEW.billing_period <=> OLD.billing_period
            AND NEW.currency <=> OLD.currency
            AND NEW.commitment_months <=> OLD.commitment_months) THEN
      SET v_message = LEFT(CONCAT('CA004: Le contrat ', LEFT(OLD.reference, 40),
        ' est engagé : son prix et son engagement changent par avenant.'), 128);
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
    END IF;
  ELSE
    -- Brouillon : le montant suit les lignes, la valeur écrite est ignorée.
    SET v_amount = contract_version_lines_amount(NEW.tenant_id, NEW.id, NULL);
    IF v_amount IS NOT NULL THEN
      SET NEW.amount_cents = v_amount;
    END IF;
  END IF;

  IF NEW.starts_on <> OLD.starts_on AND EXISTS (
    SELECT 1 FROM contract_amendments
     WHERE tenant_id = OLD.tenant_id AND contract_id = OLD.id AND status = 'signed'
  ) THEN
    SET v_message = LEFT(CONCAT('CA004: Le contrat ', LEFT(OLD.reference, 40),
      ' a des avenants signés : sa date de début ne change plus.'), 128);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;

  IF @app_client_ids IS NOT NULL
     AND (NOT FIND_IN_SET(OLD.client_id, @app_client_ids)
          OR NOT FIND_IN_SET(NEW.client_id, @app_client_ids)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Écriture refusée : ce contrat n''appartient à aucune entreprise du compte connecté.';
  END IF;
END;
--> statement-breakpoint

-- Après l'écriture du contrat : un chevauchement fait échouer l'activation, la
-- résiliation ou le changement de ressource lui-même (CA000), jamais une
-- écriture à moitié faite.
CREATE TRIGGER contracts_after_insert
AFTER INSERT ON contracts
FOR EACH ROW
BEGIN
  CALL apply_contract_occupation(NEW.id);
END;
--> statement-breakpoint

CREATE TRIGGER contracts_after_update
AFTER UPDATE ON contracts
FOR EACH ROW
BEGIN
  CALL apply_contract_occupation(NEW.id);
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Lignes de contrat
-- ---------------------------------------------------------------------------
-- Garde des lignes : seules celles d'un brouillon (contrat non archivé, ou
-- avenant non signé et non abandonné) s'écrivent. Verrouille le contrat (et
-- l'avenant) le temps de la transaction. Portée client : par le contrat.
CREATE PROCEDURE contract_lines_check(
  IN p_tenant_id char(36),
  IN p_contract_id char(36),
  IN p_amendment_id char(36)
)
BEGIN
  DECLARE v_found int;
  DECLARE v_status varchar(20);
  DECLARE v_deleted_at datetime(3);
  DECLARE v_reference varchar(64);
  DECLARE v_client_id char(36);
  DECLARE v_a_found int;
  DECLARE v_a_status varchar(20);
  DECLARE v_a_deleted_at datetime(3);
  DECLARE v_a_number int;
  DECLARE v_message varchar(255);

  SELECT COUNT(*), MAX(status), MAX(deleted_at), MAX(reference), MAX(client_id)
    INTO v_found, v_status, v_deleted_at, v_reference, v_client_id
    FROM contracts
   WHERE tenant_id = p_tenant_id AND id = p_contract_id
     FOR UPDATE;
  -- Contrat introuvable : la clé étrangère le dira, avec son propre code.
  IF v_found > 0 THEN
    IF p_amendment_id IS NULL THEN
      IF v_status <> 'draft' OR v_deleted_at IS NOT NULL THEN
        SET v_message = LEFT(CONCAT('CA004: Le contrat ', LEFT(v_reference, 40),
          ' est engagé : ses lignes changent par avenant.'), 128);
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
      END IF;
    ELSE
      SELECT COUNT(*), MAX(status), MAX(deleted_at), MAX(number)
        INTO v_a_found, v_a_status, v_a_deleted_at, v_a_number
        FROM contract_amendments
       WHERE tenant_id = p_tenant_id AND id = p_amendment_id
         FOR UPDATE;
      IF v_a_found > 0 AND (v_a_status <> 'draft' OR v_a_deleted_at IS NOT NULL) THEN
        SET v_message = LEFT(CONCAT('CA004: L''avenant n° ', v_a_number, ' du contrat ',
          LEFT(v_reference, 30), ' est signé ou abandonné : ses lignes ne changent plus.'), 128);
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
      END IF;
    END IF;

    IF @app_client_ids IS NOT NULL AND NOT FIND_IN_SET(v_client_id, @app_client_ids) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA015: Écriture refusée : ce contrat n''appartient à aucune entreprise du compte connecté.';
    END IF;
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER contract_lines_before_insert
BEFORE INSERT ON contract_lines
FOR EACH ROW
BEGIN
  CALL contract_lines_check(NEW.tenant_id, NEW.contract_id, NEW.amendment_id);
END;
--> statement-breakpoint

CREATE TRIGGER contract_lines_before_update
BEFORE UPDATE ON contract_lines
FOR EACH ROW
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.contract_id <> OLD.contract_id
     OR NOT (NEW.amendment_id <=> OLD.amendment_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA004: Une ligne ne change ni de contrat ni d''avenant.';
  END IF;
  CALL contract_lines_check(NEW.tenant_id, NEW.contract_id, NEW.amendment_id);
END;
--> statement-breakpoint

-- Pas de suppression physique (décision 6) : remplace `REVOKE DELETE`.
CREATE TRIGGER contract_lines_before_delete
BEFORE DELETE ON contract_lines
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
    'CA004: Une ligne de contrat ne se supprime pas : retirez-la d''un brouillon (deleted_at).';
END;
--> statement-breakpoint

-- Après l'écriture d'une ligne : le montant de sa version suit. Les UPDATE
-- ciblent une autre table que celle du trigger, ce que MySQL permet.
CREATE PROCEDURE contract_lines_sync_amount(
  IN p_tenant_id char(36),
  IN p_contract_id char(36),
  IN p_amendment_id char(36)
)
BEGIN
  DECLARE v_amount int;
  SET v_amount = contract_version_lines_amount(p_tenant_id, p_contract_id, p_amendment_id);
  IF v_amount IS NOT NULL THEN
    IF p_amendment_id IS NULL THEN
      UPDATE contracts SET amount_cents = v_amount
       WHERE tenant_id = p_tenant_id AND id = p_contract_id AND amount_cents <> v_amount;
    ELSE
      UPDATE contract_amendments SET amount_cents = v_amount
       WHERE tenant_id = p_tenant_id AND id = p_amendment_id
         AND NOT (amount_cents <=> v_amount);
    END IF;
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER contract_lines_after_insert
AFTER INSERT ON contract_lines
FOR EACH ROW
BEGIN
  CALL contract_lines_sync_amount(NEW.tenant_id, NEW.contract_id, NEW.amendment_id);
END;
--> statement-breakpoint

CREATE TRIGGER contract_lines_after_update
AFTER UPDATE ON contract_lines
FOR EACH ROW
BEGIN
  CALL contract_lines_sync_amount(NEW.tenant_id, NEW.contract_id, NEW.amendment_id);
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Avenants
-- ---------------------------------------------------------------------------
-- Un avenant peut-il être signé ? Refus (CA005) : contrat qui n'est pas en
-- cours ; date d'effet qui n'est pas strictement après le premier jour du
-- contrat, qui suit son dernier jour, ou qui ne suit pas le dernier avenant
-- signé ; avenant qui ne change rien ; avenant de prix qui prend effet sur une
-- période déjà facturée (ADR 032) — un avenant de ressource seule ne change
-- pas ce qui est dû, il reste permis.
CREATE PROCEDURE contract_amendment_assert_signable(
  IN p_tenant_id char(36),
  IN p_contract_id char(36),
  IN p_amendment_id char(36),
  IN p_effective_on date,
  IN p_changes_resource tinyint,
  IN p_amount_cents int,
  IN p_deleted_at datetime(3)
)
BEGIN
  DECLARE v_status varchar(20);
  DECLARE v_deleted_at datetime(3);
  DECLARE v_reference varchar(64);
  DECLARE v_starts_on date;
  DECLARE v_ends_on date;
  DECLARE v_terminated_on date;
  DECLARE v_last_day date;
  DECLARE v_billed_through date;
  DECLARE v_has_lines int;
  DECLARE v_other int;
  DECLARE v_message varchar(255);

  SELECT MAX(status), MAX(deleted_at), MAX(reference), MAX(starts_on), MAX(ends_on),
         MAX(terminated_on)
    INTO v_status, v_deleted_at, v_reference, v_starts_on, v_ends_on, v_terminated_on
    FROM contracts
   WHERE tenant_id = p_tenant_id AND id = p_contract_id;
  SET v_last_day = CASE
    WHEN v_ends_on IS NULL THEN v_terminated_on
    WHEN v_terminated_on IS NULL THEN v_ends_on
    ELSE LEAST(v_ends_on, v_terminated_on)
  END;

  IF v_status <> 'active' OR v_deleted_at IS NOT NULL THEN
    SET v_message = LEFT(CONCAT('CA005: Le contrat ', LEFT(v_reference, 40),
      ' n''est pas en cours : l''avenant ne se signe pas.'), 128);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;
  IF p_deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA005: Cet avenant a été abandonné.';
  END IF;
  IF p_effective_on <= v_starts_on THEN
    SET v_message = LEFT(CONCAT('CA005: La date d''effet doit suivre le premier jour du contrat (',
      DATE_FORMAT(v_starts_on, '%d/%m/%Y'), ').'), 128);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;
  IF v_last_day IS NOT NULL AND p_effective_on > v_last_day THEN
    SET v_message = LEFT(CONCAT('CA005: La date d''effet suit le dernier jour du contrat (',
      DATE_FORMAT(v_last_day, '%d/%m/%Y'), ').'), 128);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;

  SELECT COUNT(*) INTO v_other
    FROM contract_amendments AS other
   WHERE other.tenant_id = p_tenant_id AND other.contract_id = p_contract_id
     AND other.status = 'signed' AND other.id <> p_amendment_id
     AND other.effective_on >= p_effective_on;
  IF v_other > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA005: Un avenant signé prend déjà effet à cette date ou après : les avenants se suivent dans le temps.';
  END IF;

  SELECT COUNT(*) INTO v_has_lines
    FROM contract_lines AS l
   WHERE l.tenant_id = p_tenant_id AND l.amendment_id = p_amendment_id AND l.deleted_at IS NULL;
  IF NOT p_changes_resource AND p_amount_cents IS NULL AND v_has_lines = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA005: Cet avenant ne change ni le prix ni la ressource.';
  END IF;

  IF p_amount_cents IS NOT NULL OR v_has_lines > 0 THEN
    SET v_billed_through = contract_billed_through(p_contract_id);
    IF v_billed_through IS NOT NULL AND p_effective_on <= v_billed_through THEN
      SET v_message = LEFT(CONCAT('CA005: Contrat ', LEFT(v_reference, 20),
        ' déjà facturé jusqu''au ', DATE_FORMAT(v_billed_through, '%d/%m/%Y'),
        ' : nouveau prix au plus tôt le ',
        DATE_FORMAT(DATE_ADD(v_billed_through, INTERVAL 1 DAY), '%d/%m/%Y'), '.'), 128);
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
    END IF;
  END IF;
END;
--> statement-breakpoint

-- INSERT : numéro attribué par la base (le suivant du contrat, sous verrou du
-- contrat) sur un contrat en cours seulement ; le montant suit les lignes ;
-- l'avenant naît brouillon ou signé, la signature est alors vérifiée.
CREATE TRIGGER contract_amendments_before_insert
BEFORE INSERT ON contract_amendments
FOR EACH ROW
BEGIN
  DECLARE v_found int;
  DECLARE v_status varchar(20);
  DECLARE v_deleted_at datetime(3);
  DECLARE v_client_id char(36);
  DECLARE v_number int;
  DECLARE v_amount int;

  SELECT COUNT(*), MAX(status), MAX(deleted_at), MAX(client_id)
    INTO v_found, v_status, v_deleted_at, v_client_id
    FROM contracts
   WHERE tenant_id = NEW.tenant_id AND id = NEW.contract_id
     FOR UPDATE;
  IF v_found > 0 THEN
    IF v_status <> 'active' OR v_deleted_at IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA005: Un avenant s''établit sur un contrat en cours : un brouillon se modifie directement.';
    END IF;

    SELECT COALESCE(MAX(number), 0) + 1 INTO v_number
      FROM contract_amendments
     WHERE tenant_id = NEW.tenant_id AND contract_id = NEW.contract_id;
    SET NEW.number = v_number;

    SET v_amount = contract_version_lines_amount(NEW.tenant_id, NEW.contract_id, NEW.id);
    IF v_amount IS NOT NULL THEN
      SET NEW.amount_cents = v_amount;
    END IF;

    IF NEW.status = 'signed' THEN
      CALL contract_amendment_assert_signable(NEW.tenant_id, NEW.contract_id, NEW.id,
        NEW.effective_on, NEW.changes_resource, NEW.amount_cents, NEW.deleted_at);
      SET NEW.signed_at = COALESCE(NEW.signed_at, CURRENT_TIMESTAMP(3));
    ELSE
      SET NEW.signed_at = NULL;
    END IF;

    IF @app_client_ids IS NOT NULL AND NOT FIND_IN_SET(v_client_id, @app_client_ids) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA015: Écriture refusée : ce contrat n''appartient à aucune entreprise du compte connecté.';
    END IF;
  END IF;
END;
--> statement-breakpoint

-- UPDATE : un avenant signé ou abandonné ne change plus (CA004) ; le numéro ne
-- bouge pas ; le montant suit les lignes ; la signature est vérifiée et
-- datée par la base.
CREATE TRIGGER contract_amendments_before_update
BEFORE UPDATE ON contract_amendments
FOR EACH ROW
BEGIN
  DECLARE v_found int;
  DECLARE v_client_id char(36);
  DECLARE v_amount int;
  DECLARE v_message varchar(255);

  IF OLD.status = 'signed' THEN
    SET v_message = LEFT(CONCAT('CA004: L''avenant n° ', OLD.number,
      ' est signé : il ne change plus.'), 128);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA004: Cet avenant a été abandonné : il ne change plus.';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.contract_id <> OLD.contract_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA004: Un avenant ne change pas de contrat.';
  END IF;
  SET NEW.number = OLD.number;

  SELECT COUNT(*), MAX(client_id)
    INTO v_found, v_client_id
    FROM contracts
   WHERE tenant_id = NEW.tenant_id AND id = NEW.contract_id
     FOR UPDATE;
  IF v_found > 0 THEN
    SET v_amount = contract_version_lines_amount(NEW.tenant_id, NEW.contract_id, NEW.id);
    IF v_amount IS NOT NULL THEN
      SET NEW.amount_cents = v_amount;
    END IF;

    IF NEW.status = 'signed' THEN
      CALL contract_amendment_assert_signable(NEW.tenant_id, NEW.contract_id, NEW.id,
        NEW.effective_on, NEW.changes_resource, NEW.amount_cents, NEW.deleted_at);
      SET NEW.signed_at = COALESCE(NEW.signed_at, CURRENT_TIMESTAMP(3));
    ELSE
      SET NEW.signed_at = NULL;
    END IF;

    IF @app_client_ids IS NOT NULL AND NOT FIND_IN_SET(v_client_id, @app_client_ids) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA015: Écriture refusée : ce contrat n''appartient à aucune entreprise du compte connecté.';
    END IF;
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER contract_amendments_before_delete
BEFORE DELETE ON contract_amendments
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
    'CA004: Un avenant ne se supprime pas : un brouillon s''abandonne (deleted_at).';
END;
--> statement-breakpoint

-- Après la signature d'un avenant qui change la ressource : l'occupation du
-- contrat est recalculée par segments.
CREATE TRIGGER contract_amendments_after_insert
AFTER INSERT ON contract_amendments
FOR EACH ROW
BEGIN
  IF NEW.status = 'signed' AND NEW.changes_resource THEN
    CALL apply_contract_occupation(NEW.contract_id);
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER contract_amendments_after_update
AFTER UPDATE ON contract_amendments
FOR EACH ROW
BEGIN
  IF NEW.status = 'signed' AND NEW.changes_resource AND OLD.status <> 'signed' THEN
    CALL apply_contract_occupation(NEW.contract_id);
  END IF;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. Documents de contrat
-- ---------------------------------------------------------------------------
-- Version attribuée par la base (la suivante du contrat, sous verrou du
-- contrat), empreinte SHA-256 calculée sur la forme canonique de l'instantané
-- (`CAST(json AS CHAR)`, UTF-8). Un document ne change jamais.
CREATE TRIGGER contract_documents_before_insert
BEFORE INSERT ON contract_documents
FOR EACH ROW
BEGIN
  DECLARE v_found int;
  DECLARE v_client_id char(36);
  DECLARE v_version int;

  SELECT COUNT(*), MAX(client_id)
    INTO v_found, v_client_id
    FROM contracts
   WHERE tenant_id = NEW.tenant_id AND id = NEW.contract_id
     FOR UPDATE;
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version
    FROM contract_documents
   WHERE tenant_id = NEW.tenant_id AND contract_id = NEW.contract_id;
  SET NEW.version = v_version;
  SET NEW.sha256 = SHA2(CAST(NEW.snapshot AS CHAR CHARACTER SET utf8mb4), 256);
  SET NEW.created_at = CURRENT_TIMESTAMP(3);

  IF v_found > 0 AND @app_client_ids IS NOT NULL
     AND NOT FIND_IN_SET(v_client_id, @app_client_ids) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Écriture refusée : ce contrat n''appartient à aucune entreprise du compte connecté.';
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER contract_documents_before_update
BEFORE UPDATE ON contract_documents
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
    'CA004: Un document de contrat remis ne se réécrit pas.';
END;
--> statement-breakpoint

CREATE TRIGGER contract_documents_before_delete
BEFORE DELETE ON contract_documents
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
    'CA004: Un document de contrat remis ne se réécrit pas.';
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. Journal des reconductions tacites (0033, 0034)
-- ---------------------------------------------------------------------------
-- Réservé au back-office, en ajout seul : le rôle applicatif n'avait que la
-- lecture et l'insertion. Même code que le refus de droit d'origine (42501).
CREATE TRIGGER contract_renewals_before_insert
BEFORE INSERT ON contract_renewals
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Le journal des reconductions est réservé au back-office.';
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER contract_renewals_before_update
BEFORE UPDATE ON contract_renewals
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
    MESSAGE_TEXT = 'Le journal des reconductions ne se réécrit pas.';
END;
--> statement-breakpoint

CREATE TRIGGER contract_renewals_before_delete
BEFORE DELETE ON contract_renewals
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
    MESSAGE_TEXT = 'Le journal des reconductions ne se supprime pas.';
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. Demandes d'offre (ADR 041, 0044, CA013)
-- ---------------------------------------------------------------------------
-- - une demande naît « à traiter », datée par la base, sur une offre
--   présentée dans l'espace client (vivante, `client_visible`) ;
-- - ne changent jamais : entreprise, offre, auteur, date ;
-- - se clôt une fois, au centre : par un contrat tiré de cette offre pour
--   cette entreprise (la clé étrangère tient l'entreprise), ou écartée par un
--   membre de l'équipe ; la date de clôture est posée par la base ;
-- - sous portée client, seul le dépôt passe ;
-- - ne se supprime pas.
--
-- `@app_anonymization` laisse passer l'effacement du motif (ADR 040). La
-- portée client (WITH CHECK de `offer_requests_client_scope`) s'applique en
-- dernier, comme la politique après le trigger.
CREATE TRIGGER offer_requests_before_insert
BEFORE INSERT ON offer_requests
FOR EACH ROW
BEGIN
  DECLARE v_offers int;

  IF COALESCE(@app_anonymization, '') <> 'on' THEN
    IF NEW.status <> 'requested'
       OR (NEW.contract_id IS NOT NULL) + (NEW.closed_at IS NOT NULL)
          + (NEW.closed_by_staff_id IS NOT NULL) + (NEW.dismissal_reason IS NOT NULL) > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA013: Une demande d''offre naît « à traiter » : le contrat ou le refus viennent ensuite.';
    END IF;
    SELECT COUNT(*) INTO v_offers
      FROM offers
     WHERE tenant_id = NEW.tenant_id AND id = NEW.offer_id
       AND deleted_at IS NULL AND client_visible = 1;
    IF v_offers = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA013: Cette offre n''est pas proposée dans l''espace client.';
    END IF;
    SET NEW.requested_at = CURRENT_TIMESTAMP(3);
  END IF;

  IF @app_client_ids IS NOT NULL AND NOT FIND_IN_SET(NEW.client_id, @app_client_ids) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Écriture refusée : cette demande n''appartient à aucune entreprise du compte connecté.';
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER offer_requests_before_update
BEFORE UPDATE ON offer_requests
FOR EACH ROW
BEGIN
  DECLARE v_offer_id char(36);
  DECLARE v_found int;

  IF COALESCE(@app_anonymization, '') <> 'on' THEN
    IF NOT (NEW.id <=> OLD.id AND NEW.tenant_id <=> OLD.tenant_id
            AND NEW.client_id <=> OLD.client_id AND NEW.offer_id <=> OLD.offer_id
            AND NEW.requested_by_member_id <=> OLD.requested_by_member_id
            AND NEW.requested_at <=> OLD.requested_at) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA013: Une demande d''offre ne change ni d''entreprise, ni d''offre, ni d''auteur, ni de date.';
    END IF;
    -- Hors `updated_at` (posé par le migrateur), rien ne change : sans effet.
    IF NOT (NEW.status <=> OLD.status AND NEW.contract_id <=> OLD.contract_id
            AND NEW.closed_at <=> OLD.closed_at
            AND NEW.closed_by_staff_id <=> OLD.closed_by_staff_id
            AND NEW.dismissal_reason <=> OLD.dismissal_reason
            AND NEW.created_at <=> OLD.created_at) THEN
      IF @app_client_ids IS NOT NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA013: Une demande d''offre se traite au centre.';
      END IF;
      IF OLD.status <> 'requested' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA013: Cette demande d''offre est déjà traitée.';
      END IF;
      IF NEW.status = 'contracted' THEN
        SELECT COUNT(*), MAX(offer_id) INTO v_found, v_offer_id
          FROM contracts
         WHERE tenant_id = NEW.tenant_id AND id = NEW.contract_id;
        IF v_found = 0 OR NOT (v_offer_id <=> NEW.offer_id) OR v_offer_id IS NULL THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
            'CA013: Seul un contrat tiré de cette offre pour cette entreprise clôt la demande.';
        END IF;
      ELSEIF NEW.status = 'dismissed' THEN
        IF NEW.closed_by_staff_id IS NULL THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
            'CA013: Une demande écartée porte le membre de l''équipe qui l''écarte.';
        END IF;
      ELSE
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
          'CA013: Une demande d''offre « à traiter » passe à « contrat établi » ou « écartée ».';
      END IF;
      SET NEW.closed_at = CURRENT_TIMESTAMP(3);
    END IF;
  END IF;

  IF @app_client_ids IS NOT NULL
     AND (NOT FIND_IN_SET(OLD.client_id, @app_client_ids)
          OR NOT FIND_IN_SET(NEW.client_id, @app_client_ids)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Écriture refusée : cette demande n''appartient à aucune entreprise du compte connecté.';
  END IF;
END;
--> statement-breakpoint

CREATE TRIGGER offer_requests_before_delete
BEFORE DELETE ON offer_requests
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
    'CA013: Une demande d''offre ne se supprime pas : elle s''écarte, et sa trace reste.';
END;
