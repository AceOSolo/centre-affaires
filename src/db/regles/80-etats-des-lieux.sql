-- Règles métier des états des lieux (module `etats-des-lieux`, ADR 039, 041).
--
-- Porté des migrations PostgreSQL 0039 (fonctions de validation), 0042 (tables,
-- gardes, conservation) et 0044 (rechiffrement des photos). Fichier idempotent,
-- rejoué par `src/db/migrer.ts` dès que son contenu change.
--
-- Conventions (docs/migration-mysql/conventions.md) :
--
-- - `SIGNAL SQLSTATE '45000'` avec le préfixe `CAnnn:` que lit `dbErrorCode()`.
--   `MESSAGE_TEXT` est limité à 128 caractères : les messages sont abrégés par
--   rapport à PostgreSQL, les codes (CA010, CA011) sont les mêmes. Le message
--   complet d'une erreur de saisie est celui que produit déjà le code
--   (`champs.ts`, miroir TypeScript de `inspection_values_error()`).
-- - la RLS n'existe plus : la portée client (`@app_client_ids`) est gardée à
--   l'écriture par ces triggers, filtrée à la lecture par les requêtes. Un refus
--   de portée lève 42501 (même code que le `WITH CHECK` d'origine).
-- - drapeaux de session : `@app_anonymization` (module rgpd),
--   `@app_inspection_photo_purge`, `@app_inspection_photo_rekey`,
--   `@app_journal_purge`. Posés puis rendus à leur valeur précédente, y compris
--   sur erreur.
-- - la validation « valeur conforme au modèle » (CA011) est faite ici, en SQL,
--   sur les types JSON de MySQL (`JSON_TYPE`, `JSON_EXTRACT`, `JSON_KEYS`…).

-- ---------------------------------------------------------------------------
-- Validation des champs d'un modèle
-- ---------------------------------------------------------------------------
-- Première erreur d'une liste de champs, ou NULL si elle est valide. Règles :
-- `InspectionField` (src/modules/etats-des-lieux/schema.ts), miroir TypeScript
-- `fieldsError` (champs.ts). Les comparaisons de chaînes sont binaires : la
-- collation de la base ignore la casse, pas la règle (`^[a-z]…`, options
-- « Neuf » et « neuf » distinctes).
DROP FUNCTION IF EXISTS inspection_fields_error;
--> statement-breakpoint
CREATE FUNCTION inspection_fields_error(p_fields JSON) RETURNS TEXT
DETERMINISTIC NO SQL
BEGIN
  DECLARE v_index INT DEFAULT 0;
  DECLARE v_count INT;
  DECLARE v_field JSON;
  DECLARE v_keys JSON;
  DECLARE v_key_index INT;
  DECLARE v_key_count INT;
  DECLARE v_key VARCHAR(255);
  DECLARE v_ids JSON DEFAULT JSON_ARRAY();
  DECLARE v_id VARCHAR(255);
  DECLARE v_type VARCHAR(255);
  DECLARE v_options JSON;
  DECLARE v_option_index INT;
  DECLARE v_option_count INT;
  DECLARE v_option JSON;
  DECLARE v_option_text TEXT;
  DECLARE v_seen JSON;
  DECLARE v_text TEXT;

  IF p_fields IS NULL OR JSON_TYPE(p_fields) <> 'ARRAY' THEN
    RETURN 'Le modèle doit être une liste de champs.';
  END IF;
  SET v_count = JSON_LENGTH(p_fields);
  IF v_count = 0 THEN
    RETURN 'Le modèle doit compter au moins un champ.';
  END IF;
  IF v_count > 100 THEN
    RETURN 'Un modèle compte au plus 100 champs.';
  END IF;

  WHILE v_index < v_count DO
    SET v_field = JSON_EXTRACT(p_fields, CONCAT('$[', v_index, ']'));
    SET v_index = v_index + 1;
    IF JSON_TYPE(v_field) <> 'OBJECT' THEN
      RETURN CONCAT('Champ n° ', v_index, ' : un objet est attendu.');
    END IF;

    SET v_keys = JSON_KEYS(v_field);
    SET v_key_count = JSON_LENGTH(v_keys);
    SET v_key_index = 0;
    WHILE v_key_index < v_key_count DO
      SET v_key = JSON_UNQUOTE(JSON_EXTRACT(v_keys, CONCAT('$[', v_key_index, ']')));
      SET v_key_index = v_key_index + 1;
      IF BINARY v_key NOT IN ('id', 'label', 'type', 'required', 'unit', 'options', 'help') THEN
        RETURN CONCAT('Champ n° ', v_index, ' : propriété inconnue « ', v_key, ' ».');
      END IF;
    END WHILE;

    SET v_id = JSON_UNQUOTE(JSON_EXTRACT(v_field, '$.id'));
    IF COALESCE(JSON_TYPE(JSON_EXTRACT(v_field, '$.id')), '') <> 'STRING'
       OR NOT REGEXP_LIKE(v_id, '^[a-z][a-z0-9_]{0,62}$', 'c') THEN
      RETURN CONCAT('Champ n° ', v_index,
        ' : identifiant invalide (une lettre minuscule, puis minuscules, chiffres ou _).');
    END IF;
    IF JSON_CONTAINS(v_ids, JSON_QUOTE(v_id)) THEN
      RETURN CONCAT('Champ « ', v_id, ' » : identifiant en double.');
    END IF;
    SET v_ids = JSON_ARRAY_APPEND(v_ids, '$', v_id);

    SET v_text = JSON_UNQUOTE(JSON_EXTRACT(v_field, '$.label'));
    IF COALESCE(JSON_TYPE(JSON_EXTRACT(v_field, '$.label')), '') <> 'STRING'
       OR TRIM(v_text) = '' OR CHAR_LENGTH(v_text) > 200 THEN
      RETURN CONCAT('Champ « ', v_id, ' » : libellé manquant ou de plus de 200 caractères.');
    END IF;

    SET v_type = JSON_UNQUOTE(JSON_EXTRACT(v_field, '$.type'));
    IF COALESCE(JSON_TYPE(JSON_EXTRACT(v_field, '$.type')), '') <> 'STRING'
       OR BINARY v_type NOT IN ('text', 'number', 'choice', 'checkbox', 'condition') THEN
      RETURN CONCAT('Champ « ', v_id,
        ' » : type inconnu (texte, nombre, choix, case ou note d''état).');
    END IF;

    IF COALESCE(JSON_TYPE(JSON_EXTRACT(v_field, '$.required')), '') <> 'BOOLEAN' THEN
      RETURN CONCAT('Champ « ', v_id, ' » : dire s''il est obligatoire.');
    END IF;

    IF JSON_CONTAINS_PATH(v_field, 'one', '$.unit') THEN
      IF BINARY v_type <> 'number' THEN
        RETURN CONCAT('Champ « ', v_id, ' » : seul un nombre a une unité.');
      END IF;
      SET v_text = JSON_UNQUOTE(JSON_EXTRACT(v_field, '$.unit'));
      IF COALESCE(JSON_TYPE(JSON_EXTRACT(v_field, '$.unit')), '') <> 'STRING'
         OR TRIM(v_text) = '' OR CHAR_LENGTH(v_text) > 20 THEN
        RETURN CONCAT('Champ « ', v_id, ' » : unité vide ou de plus de 20 caractères.');
      END IF;
    END IF;

    IF BINARY v_type = 'choice' THEN
      IF COALESCE(JSON_TYPE(JSON_EXTRACT(v_field, '$.options')), '') <> 'ARRAY' THEN
        RETURN CONCAT('Champ « ', v_id, ' » : un choix liste ses options.');
      END IF;
      SET v_options = JSON_EXTRACT(v_field, '$.options');
      SET v_option_count = JSON_LENGTH(v_options);
      SET v_option_index = 0;
      SET v_seen = JSON_ARRAY();
      WHILE v_option_index < v_option_count DO
        SET v_option = JSON_EXTRACT(v_options, CONCAT('$[', v_option_index, ']'));
        SET v_option_index = v_option_index + 1;
        SET v_option_text = JSON_UNQUOTE(v_option);
        IF JSON_TYPE(v_option) <> 'STRING'
           OR TRIM(v_option_text) = '' OR CHAR_LENGTH(v_option_text) > 100 THEN
          RETURN CONCAT('Champ « ', v_id, ' » : option vide ou de plus de 100 caractères.');
        END IF;
        IF JSON_CONTAINS(v_seen, v_option) THEN
          RETURN CONCAT('Champ « ', v_id, ' » : option « ', v_option_text, ' » en double.');
        END IF;
        SET v_seen = JSON_ARRAY_APPEND(v_seen, '$', v_option_text);
      END WHILE;
      IF v_option_count NOT BETWEEN 2 AND 50 THEN
        RETURN CONCAT('Champ « ', v_id, ' » : un choix propose de 2 à 50 options.');
      END IF;
    ELSEIF JSON_CONTAINS_PATH(v_field, 'one', '$.options') THEN
      RETURN CONCAT('Champ « ', v_id, ' » : seul un choix a des options.');
    END IF;

    IF JSON_CONTAINS_PATH(v_field, 'one', '$.help') THEN
      SET v_text = JSON_UNQUOTE(JSON_EXTRACT(v_field, '$.help'));
      IF COALESCE(JSON_TYPE(JSON_EXTRACT(v_field, '$.help')), '') <> 'STRING'
         OR TRIM(v_text) = '' OR CHAR_LENGTH(v_text) > 500 THEN
        RETURN CONCAT('Champ « ', v_id, ' » : aide vide ou de plus de 500 caractères.');
      END IF;
    END IF;
  END WHILE;

  RETURN NULL;
END;
--> statement-breakpoint

-- Première erreur des valeurs d'un état des lieux face aux champs de sa
-- version de modèle, ou NULL. Une valeur `null` ou absente vaut « non
-- renseigné ». Avec `p_complete` (clôture), chaque champ obligatoire doit être
-- renseigné — un texte, non vide.
--
-- texte : chaîne de 5 000 caractères au plus ; nombre : nombre JSON ; choix :
-- l'une des options ; case : booléen ; note d'état : neuf, bon, usage ou
-- mauvais (`inspectionConditionLevels`, schema.ts).
DROP FUNCTION IF EXISTS inspection_values_error;
--> statement-breakpoint
CREATE FUNCTION inspection_values_error(p_fields JSON, p_values JSON, p_complete TINYINT)
RETURNS TEXT
DETERMINISTIC NO SQL
BEGIN
  DECLARE v_keys JSON;
  DECLARE v_key_index INT DEFAULT 0;
  DECLARE v_key_count INT;
  DECLARE v_key VARCHAR(255);
  DECLARE v_value JSON;
  DECLARE v_value_type VARCHAR(32);
  DECLARE v_text TEXT;
  DECLARE v_field JSON;
  DECLARE v_found JSON;
  DECLARE v_field_index INT;
  DECLARE v_field_count INT;
  DECLARE v_label TEXT;
  DECLARE v_kind VARCHAR(32);

  IF p_values IS NULL OR JSON_TYPE(p_values) <> 'OBJECT' THEN
    RETURN 'Les valeurs d''un état des lieux forment un objet, par identifiant de champ.';
  END IF;
  SET v_field_count = JSON_LENGTH(p_fields);
  SET v_keys = JSON_KEYS(p_values);
  SET v_key_count = COALESCE(JSON_LENGTH(v_keys), 0);

  values_loop: WHILE v_key_index < v_key_count DO
    SET v_key = JSON_UNQUOTE(JSON_EXTRACT(v_keys, CONCAT('$[', v_key_index, ']')));
    SET v_key_index = v_key_index + 1;

    -- Le champ du modèle qui porte cet identifiant (comparaison binaire).
    SET v_found = NULL;
    SET v_field_index = 0;
    WHILE v_found IS NULL AND v_field_index < v_field_count DO
      SET v_field = JSON_EXTRACT(p_fields, CONCAT('$[', v_field_index, ']'));
      SET v_field_index = v_field_index + 1;
      IF BINARY JSON_UNQUOTE(JSON_EXTRACT(v_field, '$.id')) = BINARY v_key THEN
        SET v_found = v_field;
      END IF;
    END WHILE;
    IF v_found IS NULL THEN
      RETURN CONCAT('Valeur pour un champ que le modèle ne connaît pas : « ', v_key, ' ».');
    END IF;

    SET v_value = JSON_EXTRACT(p_values, CONCAT('$.', JSON_QUOTE(v_key)));
    SET v_value_type = JSON_TYPE(v_value);
    IF v_value_type = 'NULL' THEN
      ITERATE values_loop;
    END IF;
    SET v_label = JSON_UNQUOTE(JSON_EXTRACT(v_found, '$.label'));
    SET v_kind = JSON_UNQUOTE(JSON_EXTRACT(v_found, '$.type'));

    IF BINARY v_kind = 'text' THEN
      IF v_value_type <> 'STRING' OR CHAR_LENGTH(JSON_UNQUOTE(v_value)) > 5000 THEN
        RETURN CONCAT('« ', v_label, ' » : un texte de 5 000 caractères au plus est attendu.');
      END IF;
    ELSEIF BINARY v_kind = 'number' THEN
      IF v_value_type NOT IN ('INTEGER', 'UNSIGNED INTEGER', 'DOUBLE', 'DECIMAL') THEN
        RETURN CONCAT('« ', v_label, ' » : un nombre est attendu.');
      END IF;
    ELSEIF BINARY v_kind = 'choice' THEN
      IF v_value_type <> 'STRING' OR NOT JSON_CONTAINS(JSON_EXTRACT(v_found, '$.options'), v_value) THEN
        RETURN CONCAT('« ', v_label, ' » : choisissez l''une des options proposées.');
      END IF;
    ELSEIF BINARY v_kind = 'checkbox' THEN
      IF v_value_type <> 'BOOLEAN' THEN
        RETURN CONCAT('« ', v_label, ' » : coché ou non coché.');
      END IF;
    ELSEIF BINARY v_kind = 'condition' THEN
      IF v_value_type <> 'STRING'
         OR BINARY JSON_UNQUOTE(v_value) NOT IN ('neuf', 'bon', 'usage', 'mauvais') THEN
        RETURN CONCAT('« ', v_label, ' » : une note d''état est attendue (neuf, bon, usage, mauvais).');
      END IF;
    ELSE
      RETURN CONCAT('« ', v_label, ' » : type de champ inconnu.');
    END IF;
  END WHILE values_loop;

  IF p_complete THEN
    SET v_field_index = 0;
    WHILE v_field_index < v_field_count DO
      SET v_field = JSON_EXTRACT(p_fields, CONCAT('$[', v_field_index, ']'));
      SET v_field_index = v_field_index + 1;
      IF JSON_UNQUOTE(JSON_EXTRACT(v_field, '$.required')) = 'true' THEN
        SET v_value = JSON_EXTRACT(p_values,
          CONCAT('$.', JSON_QUOTE(JSON_UNQUOTE(JSON_EXTRACT(v_field, '$.id')))));
        SET v_value_type = JSON_TYPE(v_value);
        IF v_value IS NULL OR v_value_type = 'NULL'
           OR (v_value_type = 'STRING' AND TRIM(JSON_UNQUOTE(v_value)) = '') THEN
          RETURN CONCAT('« ', JSON_UNQUOTE(JSON_EXTRACT(v_field, '$.label')),
            ' » est obligatoire : renseignez-le avant de clore.');
        END IF;
      END IF;
    END WHILE;
  END IF;

  RETURN NULL;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Modèles et versions : écrits par le back-office seul
-- ---------------------------------------------------------------------------
-- Lisibles sous portée client (les libellés des champs s'affichent dans
-- l'espace), mais jamais écrits depuis l'espace client.
DROP TRIGGER IF EXISTS inspection_templates_before_insert;
--> statement-breakpoint
CREATE TRIGGER inspection_templates_before_insert
BEFORE INSERT ON inspection_templates
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : les modèles d''états des lieux sont écrits par le centre.';
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS inspection_templates_before_update;
--> statement-breakpoint
CREATE TRIGGER inspection_templates_before_update
BEFORE UPDATE ON inspection_templates
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : les modèles d''états des lieux sont écrits par le centre.';
  END IF;
END;
--> statement-breakpoint

-- Une version publiée est figée : c'est elle que gardent les états des lieux
-- saisis avec. Modifier un modèle, c'est en publier une nouvelle. Sous
-- PostgreSQL le droit d'écrire était retiré au rôle applicatif ; ici ce sont
-- des triggers. `fields` est validé à la publication (CA011).
DROP TRIGGER IF EXISTS inspection_template_versions_before_insert;
--> statement-breakpoint
CREATE TRIGGER inspection_template_versions_before_insert
BEFORE INSERT ON inspection_template_versions
FOR EACH ROW
BEGIN
  DECLARE v_error TEXT;
  DECLARE v_message VARCHAR(128);
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : les modèles d''états des lieux sont écrits par le centre.';
  END IF;
  SET v_error = inspection_fields_error(NEW.fields);
  IF v_error IS NOT NULL THEN
    SET v_message = LEFT(CONCAT('CA011: ', v_error), 128);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS inspection_template_versions_before_update;
--> statement-breakpoint
CREATE TRIGGER inspection_template_versions_before_update
BEFORE UPDATE ON inspection_template_versions
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
    MESSAGE_TEXT = 'Une version de modèle publiée ne se modifie pas : publiez-en une nouvelle.';
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS inspection_template_versions_before_delete;
--> statement-breakpoint
CREATE TRIGGER inspection_template_versions_before_delete
BEFORE DELETE ON inspection_template_versions
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
    MESSAGE_TEXT = 'Une version de modèle publiée ne se supprime pas.';
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- États des lieux : garde (CA010 figé, CA011 non conforme)
-- ---------------------------------------------------------------------------
-- - un état des lieux naît brouillon, au centre (jamais sous portée client),
--   avec la version du modèle du **type** de sa ressource (CA011) ;
-- - ne changent jamais : nature, ressource, client, version du modèle,
--   auteur (CA010) ;
-- - brouillon : les valeurs suivent la version (clés connues, types, options,
--   échelle) ; à la clôture (`status` → `closed`, `closed_by` exigé,
--   `closed_at` posé par la base), chaque champ obligatoire est renseigné
--   (CA011) ; une sortie désigne une entrée close de la même ressource et du
--   même client ;
-- - clos : figé (CA010), sauf la validation du client, une fois —
--   `signed_by_member_id` et `client_remarks`, `signed_at` posé par la base.
--
-- Portée client (ex-politique restrictive) : seuls les états clos et vivants
-- des entreprises du compte sont visibles et écrits. PostgreSQL ignorait
-- silencieusement une mise à jour hors de cette vue ; ici elle est refusée
-- (42501), faute de pouvoir filtrer les lignes d'un UPDATE.
-- `@app_anonymization` laisse passer l'anonymisation (ADR 040).
DROP TRIGGER IF EXISTS inspections_before_delete;
--> statement-breakpoint
CREATE TRIGGER inspections_before_delete
BEFORE DELETE ON inspections
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
    'CA010: Un état des lieux ne se supprime pas : un brouillon se retire, un état clos reste.';
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS inspections_before_insert;
--> statement-breakpoint
CREATE TRIGGER inspections_before_insert
BEFORE INSERT ON inspections
FOR EACH ROW
guard: BEGIN
  DECLARE v_fields JSON;
  DECLARE v_template_found INT DEFAULT 0;
  DECLARE v_template_type VARCHAR(32);
  DECLARE v_resource_type VARCHAR(32);
  DECLARE v_entry_found INT DEFAULT 0;
  DECLARE v_entry_ok TINYINT DEFAULT 1;
  DECLARE v_error TEXT;
  DECLARE v_message VARCHAR(128);

  IF COALESCE(@app_anonymization, '') = 'on' THEN
    LEAVE guard;
  END IF;
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA010: Un état des lieux se saisit au centre, pas depuis l''espace client.';
  END IF;
  IF NEW.status <> 'draft'
     OR NEW.closed_at IS NOT NULL OR NEW.closed_by IS NOT NULL
     OR NEW.signed_at IS NOT NULL OR NEW.signed_by_member_id IS NOT NULL
     OR NEW.client_remarks IS NOT NULL OR NEW.deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA011: Un état des lieux naît brouillon : il se clôt, puis le client le valide.';
  END IF;

  SELECT COUNT(*) INTO v_template_found
    FROM inspection_template_versions
   WHERE tenant_id = NEW.tenant_id AND id = NEW.template_version_id;
  IF v_template_found = 0 THEN
    -- La clé étrangère le dira, avec son propre code.
    LEAVE guard;
  END IF;
  SELECT v.fields, t.resource_type INTO v_fields, v_template_type
    FROM inspection_template_versions AS v
    JOIN inspection_templates AS t ON t.tenant_id = v.tenant_id AND t.id = v.template_id
   WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.template_version_id;

  SELECT MAX(resource_type) INTO v_resource_type FROM resources
   WHERE tenant_id = NEW.tenant_id AND id = NEW.resource_id;
  IF v_resource_type IS NOT NULL AND v_resource_type <> v_template_type THEN
    SET v_message = LEFT(CONCAT('CA011: Ce modèle est celui du type « ', v_template_type,
      ' » : la ressource est du type « ', v_resource_type, ' ».'), 128);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;

  IF NEW.entry_inspection_id IS NOT NULL THEN
    SELECT COUNT(*), COALESCE(MIN(kind = 'entry' AND status = 'closed' AND deleted_at IS NULL), 1)
      INTO v_entry_found, v_entry_ok
      FROM inspections
     WHERE tenant_id = NEW.tenant_id AND id = NEW.entry_inspection_id;
    IF v_entry_found > 0 AND v_entry_ok = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA011: Une sortie désigne l''état des lieux d''entrée qu''elle clôt, et celui-ci doit être clos.';
    END IF;
  END IF;

  SET v_error = inspection_values_error(v_fields, NEW.`values`, 0);
  IF v_error IS NOT NULL THEN
    SET v_message = LEFT(CONCAT('CA011: ', v_error), 128);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS inspections_before_update;
--> statement-breakpoint
CREATE TRIGGER inspections_before_update
BEFORE UPDATE ON inspections
FOR EACH ROW
guard: BEGIN
  DECLARE v_fields JSON;
  DECLARE v_template_found INT DEFAULT 0;
  DECLARE v_entry_found INT DEFAULT 0;
  DECLARE v_entry_ok TINYINT DEFAULT 1;
  DECLARE v_same_but_signature TINYINT DEFAULT 0;
  DECLARE v_error TEXT;
  DECLARE v_message VARCHAR(128);

  IF @app_client_ids IS NOT NULL AND NOT (
       FIND_IN_SET(OLD.client_id, @app_client_ids)
       AND OLD.status = 'closed' AND OLD.deleted_at IS NULL
       AND FIND_IN_SET(NEW.client_id, @app_client_ids)
       AND NEW.status = 'closed' AND NEW.deleted_at IS NULL) THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Écriture refusée : cet état des lieux n''est pas visible depuis votre espace.';
  END IF;
  IF COALESCE(@app_anonymization, '') = 'on' THEN
    LEAVE guard;
  END IF;

  IF NOT (NEW.id <=> OLD.id AND NEW.tenant_id <=> OLD.tenant_id AND NEW.kind <=> OLD.kind
          AND NEW.resource_id <=> OLD.resource_id AND NEW.client_id <=> OLD.client_id
          AND NEW.template_version_id <=> OLD.template_version_id
          AND NEW.created_by <=> OLD.created_by AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA010: Un état des lieux ne change ni de nature, ni de ressource, ni de client, ni de version de modèle.';
  END IF;

  IF OLD.status = 'closed' THEN
    -- Tout sauf la validation du client et `updated_at`.
    SET v_same_but_signature = (
      NEW.status <=> OLD.status AND NEW.booking_id <=> OLD.booking_id
      AND NEW.contract_id <=> OLD.contract_id
      AND NEW.entry_inspection_id <=> OLD.entry_inspection_id
      AND NEW.performed_at <=> OLD.performed_at AND NEW.`values` <=> OLD.`values`
      AND NEW.observations <=> OLD.observations
      AND NEW.closed_at <=> OLD.closed_at AND NEW.closed_by <=> OLD.closed_by
      AND NEW.deleted_at <=> OLD.deleted_at);
    IF v_same_but_signature
       AND NEW.signed_at <=> OLD.signed_at AND NEW.signed_by_member_id <=> OLD.signed_by_member_id
       AND NEW.client_remarks <=> OLD.client_remarks THEN
      LEAVE guard;
    END IF;
    IF OLD.signed_at IS NULL AND NEW.signed_by_member_id IS NOT NULL AND v_same_but_signature THEN
      SET NEW.signed_at = CURRENT_TIMESTAMP(3);
      LEAVE guard;
    END IF;
    IF OLD.signed_at IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA010: Cet état des lieux est clos : il ne change plus ; seule la validation du client reste à venir.';
    END IF;
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA010: Cet état des lieux est clos : il ne change plus.';
  END IF;

  -- Brouillon.
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA010: Un état des lieux en saisie ne se modifie pas depuis l''espace client.';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA010: Ce brouillon d''état des lieux a été retiré.';
  END IF;
  IF NEW.signed_at IS NOT NULL OR NEW.signed_by_member_id IS NOT NULL
     OR NEW.client_remarks IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA011: Le client valide un état des lieux clos, pas un brouillon.';
  END IF;

  SELECT COUNT(*) INTO v_template_found
    FROM inspection_template_versions
   WHERE tenant_id = NEW.tenant_id AND id = NEW.template_version_id;
  IF v_template_found = 0 THEN
    LEAVE guard;
  END IF;
  SELECT fields INTO v_fields FROM inspection_template_versions
   WHERE tenant_id = NEW.tenant_id AND id = NEW.template_version_id;

  IF NEW.entry_inspection_id IS NOT NULL
     AND NOT (NEW.entry_inspection_id <=> OLD.entry_inspection_id) THEN
    SELECT COUNT(*), COALESCE(MIN(kind = 'entry' AND status = 'closed' AND deleted_at IS NULL), 1)
      INTO v_entry_found, v_entry_ok
      FROM inspections
     WHERE tenant_id = NEW.tenant_id AND id = NEW.entry_inspection_id;
    IF v_entry_found > 0 AND v_entry_ok = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA011: Une sortie désigne l''état des lieux d''entrée qu''elle clôt, et celui-ci doit être clos.';
    END IF;
  END IF;

  SET v_error = inspection_values_error(v_fields, NEW.`values`, NEW.status = 'closed');
  IF v_error IS NOT NULL THEN
    SET v_message = LEFT(CONCAT('CA011: ', v_error), 128);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;

  IF NEW.status = 'closed' THEN
    IF NEW.closed_by IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA011: La clôture d''un état des lieux porte son auteur.';
    END IF;
    IF NEW.deleted_at IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA011: Un brouillon retiré ne se clôt pas.';
    END IF;
    SET NEW.closed_at = CURRENT_TIMESTAMP(3);
  END IF;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Photos : garde (CA010, CA011)
-- ---------------------------------------------------------------------------
-- Déposées, légendées, rattachées à un champ ou retirées tant que l'état des
-- lieux est un brouillon, au centre (CA010) ; le fichier et l'état des lieux
-- d'une photo ne changent jamais ; le champ illustré est un champ de la version
-- du modèle (CA011). L'état des lieux est verrouillé en partage : une photo ne
-- se glisse pas pendant sa clôture.
--
-- `@app_inspection_photo_purge` laisse passer la purge (`mark_inspection_photo_
-- purged`), `@app_inspection_photo_rekey` le changement de version de clé
-- (`rekey_inspection_photo`), et eux seuls.
DROP TRIGGER IF EXISTS inspection_photos_before_delete;
--> statement-breakpoint
CREATE TRIGGER inspection_photos_before_delete
BEFORE DELETE ON inspection_photos
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
    'CA010: Une photo d''état des lieux ne se supprime pas : elle se retire d''un brouillon.';
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS inspection_photos_before_insert;
--> statement-breakpoint
CREATE TRIGGER inspection_photos_before_insert
BEFORE INSERT ON inspection_photos
FOR EACH ROW
guard: BEGIN
  DECLARE v_found INT DEFAULT 0;
  DECLARE v_open TINYINT DEFAULT 0;
  DECLARE v_version CHAR(36);
  DECLARE v_fields JSON;
  DECLARE v_field_found INT DEFAULT 0;
  DECLARE v_message VARCHAR(128);

  IF COALESCE(@app_inspection_photo_purge, '') = 'on' THEN
    LEAVE guard;
  END IF;
  IF COALESCE(@app_inspection_photo_rekey, '') = 'on' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA010: Le rechiffrement d''une photo ne change que sa version de clé.';
  END IF;
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA010: Les photos d''un état des lieux se déposent au centre.';
  END IF;

  SELECT COUNT(*), COALESCE(MAX(status = 'draft' AND deleted_at IS NULL), 0), MAX(template_version_id)
    INTO v_found, v_open, v_version
    FROM inspections
   WHERE tenant_id = NEW.tenant_id AND id = NEW.inspection_id
     FOR SHARE;
  IF v_found = 0 THEN
    -- La clé étrangère le dira, avec son propre code.
    LEAVE guard;
  END IF;
  IF v_open = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA010: Cet état des lieux est clos ou retiré : ses photos ne changent plus.';
  END IF;

  IF NEW.field_id IS NOT NULL THEN
    SELECT fields INTO v_fields FROM inspection_template_versions
     WHERE tenant_id = NEW.tenant_id AND id = v_version;
    SELECT COUNT(*) INTO v_field_found
      FROM JSON_TABLE(v_fields, '$[*]' COLUMNS (field_id VARCHAR(64) PATH '$.id')) AS f
     WHERE BINARY f.field_id = BINARY NEW.field_id;
    IF v_field_found = 0 THEN
      SET v_message = LEFT(CONCAT('CA011: Le champ « ', NEW.field_id,
        ' » n''existe pas dans le modèle de cet état des lieux.'), 128);
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
    END IF;
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS inspection_photos_before_update;
--> statement-breakpoint
CREATE TRIGGER inspection_photos_before_update
BEFORE UPDATE ON inspection_photos
FOR EACH ROW
guard: BEGIN
  DECLARE v_found INT DEFAULT 0;
  DECLARE v_open TINYINT DEFAULT 0;
  DECLARE v_version CHAR(36);
  DECLARE v_fields JSON;
  DECLARE v_field_found INT DEFAULT 0;
  DECLARE v_same_but_key TINYINT DEFAULT 0;
  DECLARE v_message VARCHAR(128);

  IF COALESCE(@app_inspection_photo_purge, '') = 'on' THEN
    LEAVE guard;
  END IF;
  IF COALESCE(@app_inspection_photo_rekey, '') = 'on' THEN
    SET v_same_but_key = (
      NEW.id <=> OLD.id AND NEW.tenant_id <=> OLD.tenant_id
      AND NEW.inspection_id <=> OLD.inspection_id AND NEW.storage_key <=> OLD.storage_key
      AND NEW.content_type <=> OLD.content_type AND NEW.byte_size <=> OLD.byte_size
      AND NEW.width <=> OLD.width AND NEW.height <=> OLD.height
      AND NEW.caption <=> OLD.caption AND NEW.field_id <=> OLD.field_id
      AND NEW.position <=> OLD.position AND NEW.uploaded_by <=> OLD.uploaded_by
      AND NEW.created_at <=> OLD.created_at AND NEW.deleted_at <=> OLD.deleted_at);
    IF NOT v_same_but_key THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA010: Le rechiffrement d''une photo ne change que sa version de clé.';
    END IF;
    LEAVE guard;
  END IF;
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA010: Les photos d''un état des lieux se déposent au centre.';
  END IF;

  IF NOT (NEW.id <=> OLD.id AND NEW.tenant_id <=> OLD.tenant_id
          AND NEW.inspection_id <=> OLD.inspection_id AND NEW.storage_key <=> OLD.storage_key
          AND NEW.encryption_key_version <=> OLD.encryption_key_version
          AND NEW.content_type <=> OLD.content_type AND NEW.byte_size <=> OLD.byte_size
          AND NEW.width <=> OLD.width AND NEW.height <=> OLD.height
          AND NEW.uploaded_by <=> OLD.uploaded_by AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA010: Une photo déposée ne change ni de fichier ni d''état des lieux : retirez-la et déposez-en une autre.';
  END IF;
  IF NEW.caption <=> OLD.caption AND NEW.field_id <=> OLD.field_id
     AND NEW.position <=> OLD.position AND NEW.deleted_at <=> OLD.deleted_at THEN
    LEAVE guard;
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA010: Cette photo a été retirée.';
  END IF;

  SELECT COUNT(*), COALESCE(MAX(status = 'draft' AND deleted_at IS NULL), 0), MAX(template_version_id)
    INTO v_found, v_open, v_version
    FROM inspections
   WHERE tenant_id = NEW.tenant_id AND id = NEW.inspection_id
     FOR SHARE;
  IF v_found = 0 THEN
    LEAVE guard;
  END IF;
  IF v_open = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA010: Cet état des lieux est clos ou retiré : ses photos ne changent plus.';
  END IF;

  IF NEW.field_id IS NOT NULL THEN
    SELECT fields INTO v_fields FROM inspection_template_versions
     WHERE tenant_id = NEW.tenant_id AND id = v_version;
    SELECT COUNT(*) INTO v_field_found
      FROM JSON_TABLE(v_fields, '$[*]' COLUMNS (field_id VARCHAR(64) PATH '$.id')) AS f
     WHERE BINARY f.field_id = BINARY NEW.field_id;
    IF v_field_found = 0 THEN
      SET v_message = LEFT(CONCAT('CA011: Le champ « ', NEW.field_id,
        ' » n''existe pas dans le modèle de cet état des lieux.'), 128);
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
    END IF;
  END IF;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Journal des consultations des photos : ajout seul, portée client
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS inspection_photo_views_before_insert;
--> statement-breakpoint
CREATE TRIGGER inspection_photo_views_before_insert
BEFORE INSERT ON inspection_photo_views
FOR EACH ROW
BEGIN
  DECLARE v_client CHAR(36);
  IF @app_client_ids IS NOT NULL THEN
    SELECT i.client_id INTO v_client
      FROM inspection_photos AS p
      JOIN inspections AS i ON i.tenant_id = p.tenant_id AND i.id = p.inspection_id
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.photo_id;
    IF v_client IS NOT NULL AND NOT FIND_IN_SET(v_client, @app_client_ids) THEN
      SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
        MESSAGE_TEXT = 'Écriture refusée : cette photo n''appartient pas à votre entreprise.';
    END IF;
  END IF;
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS inspection_photo_views_before_update;
--> statement-breakpoint
CREATE TRIGGER inspection_photo_views_before_update
BEFORE UPDATE ON inspection_photo_views
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
    MESSAGE_TEXT = 'Le journal des consultations des photos ne se modifie pas.';
END;
--> statement-breakpoint

DROP TRIGGER IF EXISTS inspection_photo_views_before_delete;
--> statement-breakpoint
CREATE TRIGGER inspection_photo_views_before_delete
BEFORE DELETE ON inspection_photo_views
FOR EACH ROW
BEGIN
  IF COALESCE(@app_journal_purge, '') <> 'on' THEN
    SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142,
      MESSAGE_TEXT = 'Le journal des consultations des photos ne s''efface que par sa purge échue.';
  END IF;
END;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Conservation et rechiffrement (ADR 039, ADR 020)
-- ---------------------------------------------------------------------------
-- Marque une photo purgée, une fois son fichier effacé du stockage. Revérifie
-- l'échéance : l'application peut purger, jamais choisir quoi. Rend 1 si la
-- photo était échue et vient d'être marquée. Seul chemin pour retirer une
-- photo d'un état des lieux clos.
--
-- Le départ de la conservation est la clôture de la sortie : pour une sortie,
-- la sienne ; pour une entrée, celle de la sortie close qui la désigne. Rien ne
-- court (NULL) pour un brouillon, ou une entrée sans sortie close.
-- (`expired_inspection_photos` est réécrite en TypeScript : conservation.ts.)
DROP FUNCTION IF EXISTS mark_inspection_photo_purged;
--> statement-breakpoint
CREATE FUNCTION mark_inspection_photo_purged(p_photo_id CHAR(36)) RETURNS TINYINT
NOT DETERMINISTIC MODIFIES SQL DATA SQL SECURITY DEFINER
BEGIN
  DECLARE v_previous VARCHAR(16) DEFAULT @app_inspection_photo_purge;
  DECLARE v_done TINYINT DEFAULT 0;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @app_inspection_photo_purge = v_previous;
    RESIGNAL;
  END;
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA010: La purge des photos est une tâche du back-office.';
  END IF;
  SET @app_inspection_photo_purge = 'on';
  UPDATE inspection_photos AS p
    JOIN inspections AS i ON i.tenant_id = p.tenant_id AND i.id = p.inspection_id
    JOIN tenants AS t ON t.id = p.tenant_id
     SET p.deleted_at = CURRENT_TIMESTAMP(3)
   WHERE p.id = p_photo_id
     AND p.tenant_id = @app_tenant_id
     AND p.deleted_at IS NULL
     AND CASE
           WHEN i.status <> 'closed' THEN NULL
           WHEN i.kind = 'exit' THEN i.closed_at
           ELSE (
             SELECT MIN(x.closed_at) FROM inspections AS x
              WHERE x.tenant_id = i.tenant_id AND x.entry_inspection_id = i.id
                AND x.status = 'closed' AND x.deleted_at IS NULL
           )
         END < TIMESTAMPADD(MONTH, -t.inspection_photo_retention_months, CURRENT_TIMESTAMP(3));
  SET v_done = IF(ROW_COUNT() > 0, 1, 0);
  SET @app_inspection_photo_purge = v_previous;
  RETURN v_done;
END;
--> statement-breakpoint

-- Une photo vivante passe de la clé `p_from_version` à `p_to_version`, une fois
-- son fichier réécrit. Rend 0 si elle a changé entre-temps (purgée, rechiffrée
-- par une autre reprise). Refusée sous portée client (CA010).
DROP FUNCTION IF EXISTS rekey_inspection_photo;
--> statement-breakpoint
CREATE FUNCTION rekey_inspection_photo(
  p_photo_id CHAR(36),
  p_from_version INT,
  p_to_version INT
) RETURNS TINYINT
NOT DETERMINISTIC MODIFIES SQL DATA SQL SECURITY INVOKER
BEGIN
  DECLARE v_previous VARCHAR(16) DEFAULT @app_inspection_photo_rekey;
  DECLARE v_done TINYINT DEFAULT 0;
  DECLARE v_message VARCHAR(128);
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @app_inspection_photo_rekey = v_previous;
    RESIGNAL;
  END;
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA010: Le rechiffrement des photos est une tâche du centre.';
  END IF;
  IF p_to_version IS NULL OR p_to_version < 1 OR p_to_version <=> p_from_version THEN
    SET v_message = CONCAT('CA010: Version de clé de destination invalide : ', COALESCE(p_to_version, 'NULL'), '.');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;
  SET @app_inspection_photo_rekey = 'on';
  UPDATE inspection_photos
     SET encryption_key_version = p_to_version
   WHERE tenant_id = @app_tenant_id AND id = p_photo_id
     AND encryption_key_version = p_from_version AND deleted_at IS NULL;
  SET v_done = IF(ROW_COUNT() > 0, 1, 0);
  SET @app_inspection_photo_rekey = v_previous;
  RETURN v_done;
END;
--> statement-breakpoint

-- Purge du journal des consultations des photos, au terme de
-- `tenants.inspection_access_log_retention_months` (modèle :
-- `purge_expired_mail_scan_views()`). Pour le centre courant seulement.
DROP FUNCTION IF EXISTS purge_expired_inspection_photo_views;
--> statement-breakpoint
CREATE FUNCTION purge_expired_inspection_photo_views() RETURNS INT
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
    FROM inspection_photo_views AS views
    JOIN tenants ON tenants.id = views.tenant_id
   WHERE tenants.id = @app_tenant_id
     AND views.viewed_at
         < TIMESTAMPADD(MONTH, -tenants.inspection_access_log_retention_months, CURRENT_TIMESTAMP(3));
  SET v_count = ROW_COUNT();
  SET @app_journal_purge = v_previous;
  RETURN v_count;
END;
