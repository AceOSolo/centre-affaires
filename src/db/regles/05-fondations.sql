-- Fondations : centre unique et numérotation des documents (ADR 021).
-- Idempotent : rejoué par le migrateur dès que le fichier change.
-- Les anciennes fonctions `uuid_generate_v7`, `current_tenant_id`,
-- `tenant_id_default` et `set_updated_at` n'ont plus d'objet : l'identifiant
-- est posé par l'application, le centre vient de `@app_tenant_id`, et
-- `updated_at` est tenu par les triggers que génère le migrateur.

-- Centre unique tant que le produit est mono-centre. Cet identifiant est celui
-- de DEFAULT_TENANT_ID (src/db/tenants.ts) et de la valeur par défaut de
-- `tenant_id`. Sans effet s'il existe déjà.
INSERT INTO tenants (id, name, slug)
VALUES ('01999f00-0000-7000-8000-000000000001', 'Centre principal', 'centre-principal')
ON DUPLICATE KEY UPDATE id = id;

--> statement-breakpoint

DROP FUNCTION IF EXISTS next_document_number;

--> statement-breakpoint

-- Numéro suivant d'un type de document pour le centre du contexte :
-- `CT-2026-0001` (contrat), `FA-2026-0001` (facture), `AV-2026-0001` (avoir).
--
-- Une série par centre, par type et par année civile du centre ; l'année est
-- dans le numéro. Quatre chiffres au moins, davantage au-delà de 9999.
--
-- Sans trou ni doublon, même en concurrence : l'`ON DUPLICATE KEY UPDATE`
-- prend le verrou de la ligne du compteur jusqu'à la fin de la transaction
-- appelante. Une transaction annulée rend son numéro.
CREATE FUNCTION next_document_number(p_type varchar(20)) RETURNS varchar(32)
NOT DETERMINISTIC
MODIFIES SQL DATA
SQL SECURITY DEFINER
BEGIN
  DECLARE v_tenant char(36) DEFAULT @app_tenant_id;
  DECLARE v_time_zone varchar(64);
  DECLARE v_year int;
  DECLARE v_value int;
  DECLARE v_prefix char(2);

  IF v_tenant IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Numérotation impossible hors du contexte d''un centre (app_tenant_id).';
  END IF;

  SET v_prefix = CASE p_type
    WHEN 'contract' THEN 'CT'
    WHEN 'invoice' THEN 'FA'
    WHEN 'credit_note' THEN 'AV'
    ELSE NULL
  END;
  IF v_prefix IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Type de document inconnu : numérotation impossible.';
  END IF;

  SELECT timezone INTO v_time_zone FROM tenants WHERE id = v_tenant;
  IF v_time_zone IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Centre inconnu : numérotation impossible.';
  END IF;

  -- Année civile dans le fuseau du centre (la connexion est en UTC).
  SET v_year = YEAR(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', v_time_zone));
  IF v_year IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Fuseaux horaires MySQL non chargés (mysql_tzinfo_to_sql) : numérotation impossible.';
  END IF;

  -- `LAST_INSERT_ID(expr)` mémorise la valeur au niveau de la connexion : on la
  -- relit sans second SELECT, donc sans fenêtre où un autre numéro s'insère.
  INSERT INTO document_sequences (id, tenant_id, document_type, year, `last_value`)
  VALUES (UUID(), v_tenant, p_type, v_year, LAST_INSERT_ID(1))
  ON DUPLICATE KEY UPDATE `last_value` = LAST_INSERT_ID(`last_value` + 1);
  SET v_value = LAST_INSERT_ID();

  RETURN CONCAT(v_prefix, '-', v_year, '-', LPAD(v_value, GREATEST(4, CHAR_LENGTH(v_value)), '0'));
END
