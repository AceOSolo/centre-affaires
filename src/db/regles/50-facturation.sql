-- Facturation : règles métier de la base (ADR 026, 027), portées des migrations
-- PostgreSQL 0029 à 0044 (tables de la facturation seulement : grilles,
-- services, offres, souscriptions, lots, mandats SEPA, factures et lignes,
-- paiements, relances, plan de comptes, exports comptables).
--
-- Idempotent : rejoué par le migrateur dès que le fichier change. Contrat des
-- routines : `docs/migration-mysql/routines-facturation.md`.
--
-- Codes d'erreur (`src/db/errors.ts`) :
--   CA000  chevauchement (remplace les contraintes d'exclusion) ;
--   CA002  facture émise ou brouillon abandonné : figé ;
--   CA003  facture non conforme : émission, avoir ou ligne refusés ;
--   CA004  souscription figée ;
--   CA006  paiement refusé ;
--   CA007  mandat SEPA : RUM et client figés ;
--   CA015  écriture refusée par la portée client (remplace le WITH CHECK des
--          politiques RLS) ;
--   42501  (errno 1142) suppression ou réécriture d'un journal : remplace les
--          REVOKE DELETE / UPDATE du rôle applicatif de PostgreSQL.
--
-- Limites de MySQL à connaître en lisant ce fichier :
--
-- - un trigger ne porte qu'un événement : chaque trigger d'origine est éclaté
--   en `_before_insert` / `_before_update` / `_before_delete` ;
-- - pas de trigger d'instruction ni d'écriture de la table du trigger : la
--   répartition de la TVA par taux et les totaux d'un brouillon ne se
--   recalculent que par `invoice_refresh_amounts()` (voir le contrat) ;
-- - `MESSAGE_TEXT` d'un SIGNAL : 128 caractères, préfixe `CAnnn: ` compris ;
-- - les routines qui écrivent sont `DETERMINISTIC MODIFIES SQL DATA` :
--   `DETERMINISTIC` n'est pas vrai, il évite l'erreur 1418 sous `log_bin`.
--
-- Drapeaux de session (posés par une routine, remis à NULL en sortie, y
-- compris sur erreur) : `@app_invoice_amounts_sync`, `@app_invoice_issue`,
-- `@app_invoice_settlement_sync`.

--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. Règles d'arrondi (0029) et statut de paiement (0031)
-- ---------------------------------------------------------------------------
-- Montant net HT d'une ligne, en centimes :
--
--   brut   = quantité × prix unitaire
--   remisé = brut − remise en montant, puis × (10000 − remise en bp) / 10000
--   net    = remisé × prorata_numérateur / prorata_dénominateur
--
-- arrondi une seule fois au centime le plus proche, la moitié s'éloignant de
-- zéro (`round(numeric)` de PostgreSQL), en arithmétique entière exacte :
-- signe(N) × ⌊(2·|N| + D) / (2·D)⌋. Même expression que `lineNetAmountSql()`
-- (`modules/facturation/schema.ts`), écrite en ligne dans les colonnes
-- générées. Nul si la quantité ou le prix est nul.
DROP FUNCTION IF EXISTS line_net_amount_cents;
--> statement-breakpoint

CREATE FUNCTION line_net_amount_cents(
  p_quantity INT,
  p_unit_price_cents INT,
  p_discount_bp INT,
  p_discount_cents INT,
  p_prorata_numerator INT,
  p_prorata_denominator INT
) RETURNS INT
DETERMINISTIC
BEGIN
  DECLARE v_n BIGINT;
  DECLARE v_d BIGINT;
  SET v_n = (p_quantity * p_unit_price_cents - COALESCE(p_discount_cents, 0))
            * (10000 - COALESCE(p_discount_bp, 0))
            * COALESCE(p_prorata_numerator, 1);
  SET v_d = 10000 * COALESCE(p_prorata_denominator, 1);
  RETURN SIGN(v_n) * ((2 * ABS(v_n) + v_d) DIV (2 * v_d));
END
--> statement-breakpoint

-- TVA d'une base HT à un taux en points de base (2000 = 20 %), en centimes,
-- arrondie au centime le plus proche, la moitié s'éloignant de zéro.
--
-- EN 16931 (BR-CO-17) : la TVA se calcule par taux sur la somme des bases, pas
-- ligne à ligne. `invoice_refresh_amounts()` l'applique ainsi et répartit
-- l'écart d'arrondi sur les lignes.
DROP FUNCTION IF EXISTS vat_amount_cents;
--> statement-breakpoint

CREATE FUNCTION vat_amount_cents(p_base_cents BIGINT, p_rate_bp INT) RETURNS BIGINT
DETERMINISTIC
BEGIN
  DECLARE v_n BIGINT;
  SET v_n = p_base_cents * p_rate_bp;
  RETURN SIGN(v_n) * ((2 * ABS(v_n) + 10000) DIV 20000);
END
--> statement-breakpoint

-- Hors brouillon, le statut d'une facture est une fonction de ses montants :
--
--   annulée      avoirs émis ≥ total TTC (total > 0)
--   payée        total − avoirs − paiements ≤ 0 (une facture à 0 € l'est)
--   part. payée  reste dû et paiements > 0
--   émise        sinon
--
-- Un avoir n'a que `issued` : il ne se paie pas, il réduit sa facture. La
-- contrainte `invoices_status_derived` (schema-factures.ts) porte la même règle.
DROP FUNCTION IF EXISTS invoice_payment_status;
--> statement-breakpoint

CREATE FUNCTION invoice_payment_status(
  p_kind VARCHAR(20),
  p_total_cents INT,
  p_paid_cents INT,
  p_credited_cents INT
) RETURNS VARCHAR(20)
DETERMINISTIC
BEGIN
  RETURN CASE
    WHEN p_kind = 'credit_note' THEN 'issued'
    WHEN p_total_cents > 0 AND p_credited_cents >= p_total_cents THEN 'cancelled'
    WHEN p_total_cents - p_credited_cents - p_paid_cents <= 0 THEN 'paid'
    WHEN p_paid_cents > 0 THEN 'partially_paid'
    ELSE 'issued'
  END;
END
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Compte auxiliaire dérivé de la raison sociale (0044)
-- ---------------------------------------------------------------------------
-- Même règle que `deriveAccountingCode` (`modules/facturation/fec.ts`) :
-- accents retirés, majuscules, seulement chiffres et lettres A à Z, 17
-- caractères au plus, « CLIENT » si rien ne reste. Appelée par l'anonymisation
-- d'un client (module rgpd), qui fige le compte avant d'effacer le nom.
--
-- PostgreSQL décomposait en NFD ; MySQL n'a pas de normalisation. Une lettre
-- accentuée est reconnue par la collation `utf8mb4_0900_ai_ci` (insensible aux
-- accents) : elle vaut la lettre ASCII à laquelle elle est égale. Les lettres
-- que NFD ne décompose pas (ø, đ, ł, ħ, ŧ…) et celles que JavaScript met en
-- majuscules en plusieurs lettres (ß, ligatures) sont traitées à part, comme
-- dans la migration d'origine ; tout ce qui sort des blocs latins est retiré.
-- Un test compare la base et le TypeScript sur ces caractères
-- (`comptabilite-anonymisation.db.test.ts`).
DROP FUNCTION IF EXISTS derive_accounting_code;
--> statement-breakpoint

CREATE FUNCTION derive_accounting_code(p_name TEXT) RETURNS VARCHAR(17)
DETERMINISTIC CONTAINS SQL
BEGIN
  DECLARE v_text TEXT CHARACTER SET utf8mb4;
  DECLARE v_result VARCHAR(64) CHARACTER SET utf8mb4 DEFAULT '';
  DECLARE v_i INT DEFAULT 1;
  DECLARE v_n INT;
  DECLARE v_char VARCHAR(4) CHARACTER SET utf8mb4;
  DECLARE v_code BIGINT;
  DECLARE v_letter INT;

  IF p_name IS NULL THEN
    RETURN NULL;
  END IF;

  SET v_text = CONVERT(p_name USING utf8mb4);
  -- Majuscules de JavaScript qui donnent plusieurs lettres, ou des lettres
  -- latines à partir d'autres caractères (ß, ı, ſ, ligatures…).
  SET v_text = REPLACE(v_text COLLATE utf8mb4_bin, 'ß', 'SS');
  SET v_text = REPLACE(v_text, 'ı', 'I');
  SET v_text = REPLACE(v_text, 'İ', 'I');
  SET v_text = REPLACE(v_text, 'ŉ', 'N');
  SET v_text = REPLACE(v_text, 'ſ', 'S');
  SET v_text = REPLACE(v_text, 'ẛ', 'S');
  SET v_text = REPLACE(v_text, 'ẚ', 'A');
  SET v_text = REPLACE(v_text, 'ﬀ', 'FF');
  SET v_text = REPLACE(v_text, 'ﬁ', 'FI');
  SET v_text = REPLACE(v_text, 'ﬂ', 'FL');
  SET v_text = REPLACE(v_text, 'ﬃ', 'FFI');
  SET v_text = REPLACE(v_text, 'ﬄ', 'FFL');
  SET v_text = REPLACE(v_text, 'ﬅ', 'ST');
  SET v_text = REPLACE(v_text, 'ﬆ', 'ST');

  SET v_n = CHAR_LENGTH(v_text);
  WHILE v_i <= v_n AND CHAR_LENGTH(v_result) < 17 DO
    SET v_char = SUBSTRING(v_text, v_i, 1);
    SET v_code = ORD(CONVERT(v_char USING utf32));
    IF (v_code BETWEEN 48 AND 57) OR (v_code BETWEEN 65 AND 90) THEN
      SET v_result = CONCAT(v_result, v_char);
    ELSEIF v_code BETWEEN 97 AND 122 THEN
      SET v_result = CONCAT(v_result, UPPER(v_char));
    ELSEIF (v_code BETWEEN 192 AND 591 OR v_code BETWEEN 7680 AND 7935)
       AND v_code NOT IN (198, 208, 215, 216, 222, 223, 230, 240, 247, 248, 254,
                          272, 273, 294, 295, 305, 306, 307, 312, 319, 320, 321, 322, 329, 330, 331,
                          338, 339, 358, 359, 383, 384, 385, 386, 387, 391, 392, 393, 394, 401, 402,
                          403, 407, 408, 409, 410, 413, 414, 420, 421, 427, 428, 429, 430, 434, 435,
                          436, 437, 438, 484, 485, 571, 572, 573, 574, 575, 576, 582, 583, 584, 585,
                          588, 589, 590, 591, 7834, 7835, 7836, 7837, 7838,
                          7930, 7931, 7932, 7933, 7934, 7935) THEN
      SET v_letter = 65;
      WHILE v_letter <= 90 DO
        IF v_char COLLATE utf8mb4_0900_ai_ci = CHAR(v_letter USING utf8mb4) THEN
          SET v_result = CONCAT(v_result, CHAR(v_letter USING utf8mb4));
          SET v_letter = 91;
        ELSE
          SET v_letter = v_letter + 1;
        END IF;
      END WHILE;
    END IF;
    SET v_i = v_i + 1;
  END WHILE;

  RETURN COALESCE(NULLIF(LEFT(v_result, 17), ''), 'CLIENT');
END
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Grilles tarifaires : une grille par défaut par jour (0038)
-- ---------------------------------------------------------------------------
-- Remplace la contrainte d'exclusion `rate_plans_default_no_overlap` :
-- deux grilles par défaut vivantes d'un centre ne se recouvrent jamais (dates
-- de validité nulles : sans borne de ce côté, bornes comprises). Les écritures
-- de grilles par défaut d'un centre sont sérialisées par un verrou sur la
-- ligne du centre.
DROP TRIGGER IF EXISTS rate_plans_before_insert;
--> statement-breakpoint

CREATE TRIGGER rate_plans_before_insert BEFORE INSERT ON rate_plans
FOR EACH ROW
BEGIN
  DECLARE v_lock CHAR(36);
  DECLARE v_count INT DEFAULT 0;
  IF NEW.is_default <> 0 AND NEW.deleted_at IS NULL THEN
    SELECT id INTO v_lock FROM tenants WHERE id = NEW.tenant_id FOR UPDATE;
    SELECT COUNT(*) INTO v_count
      FROM rate_plans AS p
     WHERE p.tenant_id = NEW.tenant_id AND p.is_default <> 0 AND p.deleted_at IS NULL
       AND p.id <> NEW.id
       AND COALESCE(p.valid_from, '0001-01-01') <= COALESCE(NEW.valid_to, '9999-12-31')
       AND COALESCE(NEW.valid_from, '0001-01-01') <= COALESCE(p.valid_to, '9999-12-31');
    IF v_count > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA000: Une autre grille par défaut est déjà valable sur une partie de ces jours.';
    END IF;
  END IF;
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS rate_plans_before_update;
--> statement-breakpoint

CREATE TRIGGER rate_plans_before_update BEFORE UPDATE ON rate_plans
FOR EACH ROW
BEGIN
  DECLARE v_lock CHAR(36);
  DECLARE v_count INT DEFAULT 0;
  IF NEW.is_default <> 0 AND NEW.deleted_at IS NULL THEN
    SELECT id INTO v_lock FROM tenants WHERE id = NEW.tenant_id FOR UPDATE;
    SELECT COUNT(*) INTO v_count
      FROM rate_plans AS p
     WHERE p.tenant_id = NEW.tenant_id AND p.is_default <> 0 AND p.deleted_at IS NULL
       AND p.id <> NEW.id
       AND COALESCE(p.valid_from, '0001-01-01') <= COALESCE(NEW.valid_to, '9999-12-31')
       AND COALESCE(NEW.valid_from, '0001-01-01') <= COALESCE(p.valid_to, '9999-12-31');
    IF v_count > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA000: Une autre grille par défaut est déjà valable sur une partie de ces jours.';
    END IF;
  END IF;
END
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Pas de suppression physique (décision 6)
-- ---------------------------------------------------------------------------
-- PostgreSQL retirait `DELETE` au rôle applicatif (`REVOKE`) : une tentative
-- échouait en 42501. MySQL n'a pas de droit par table dans ce montage : un
-- trigger refuse, avec le même code (errno 1142 → 42501, `dbErrorCode`).
DROP TRIGGER IF EXISTS services_before_delete;
--> statement-breakpoint

CREATE TRIGGER services_before_delete BEFORE DELETE ON services
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142, MESSAGE_TEXT =
    'Un service ne se supprime pas : archivez-le (deleted_at).';
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS offers_before_delete;
--> statement-breakpoint

CREATE TRIGGER offers_before_delete BEFORE DELETE ON offers
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142, MESSAGE_TEXT =
    'Une offre ne se supprime pas : archivez-la (deleted_at).';
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS offer_items_before_delete;
--> statement-breakpoint

CREATE TRIGGER offer_items_before_delete BEFORE DELETE ON offer_items
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142, MESSAGE_TEXT =
    'Une ligne d''offre ne se supprime pas : retirez-la (deleted_at).';
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS subscribed_services_before_delete;
--> statement-breakpoint

CREATE TRIGGER subscribed_services_before_delete BEFORE DELETE ON subscribed_services
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142, MESSAGE_TEXT =
    'Une souscription ne se supprime pas : mettez-y fin (ends_on) ou archivez-la.';
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS invoice_runs_before_delete;
--> statement-breakpoint

CREATE TRIGGER invoice_runs_before_delete BEFORE DELETE ON invoice_runs
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142, MESSAGE_TEXT =
    'Un lot de facturation ne se supprime pas.';
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS invoices_before_delete;
--> statement-breakpoint

CREATE TRIGGER invoices_before_delete BEFORE DELETE ON invoices
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142, MESSAGE_TEXT =
    'Une facture ne se supprime pas : un brouillon s''abandonne, une facture se corrige par un avoir.';
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS invoice_lines_before_delete;
--> statement-breakpoint

CREATE TRIGGER invoice_lines_before_delete BEFORE DELETE ON invoice_lines
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142, MESSAGE_TEXT =
    'Une ligne de facture ne se supprime pas : retirez-la d''un brouillon (deleted_at).';
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS payments_before_delete;
--> statement-breakpoint

CREATE TRIGGER payments_before_delete BEFORE DELETE ON payments
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142, MESSAGE_TEXT =
    'Un paiement ne se supprime pas : annulez-le (cancelled_at).';
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS sepa_mandates_before_delete;
--> statement-breakpoint

CREATE TRIGGER sepa_mandates_before_delete BEFORE DELETE ON sepa_mandates
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142, MESSAGE_TEXT =
    'Un mandat ne se supprime pas : révoquez-le.';
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS invoice_reminders_before_delete;
--> statement-breakpoint

CREATE TRIGGER invoice_reminders_before_delete BEFORE DELETE ON invoice_reminders
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142, MESSAGE_TEXT =
    'Une relance est une preuve : elle ne se supprime pas.';
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS accounting_exports_before_delete;
--> statement-breakpoint

CREATE TRIGGER accounting_exports_before_delete BEFORE DELETE ON accounting_exports
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142, MESSAGE_TEXT =
    'Le journal des exports comptables ne se réécrit pas.';
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS invoice_reminders_before_update;
--> statement-breakpoint

CREATE TRIGGER invoice_reminders_before_update BEFORE UPDATE ON invoice_reminders
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142, MESSAGE_TEXT =
    'Une relance est une preuve : elle ne se réécrit pas.';
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS accounting_exports_before_update;
--> statement-breakpoint

CREATE TRIGGER accounting_exports_before_update BEFORE UPDATE ON accounting_exports
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '42501' SET MYSQL_ERRNO = 1142, MESSAGE_TEXT =
    'Le journal des exports comptables ne se réécrit pas.';
END
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Tables du seul back-office (R17, R28, ADR 019)
-- ---------------------------------------------------------------------------
-- Le bilan d'un lot, le plan de comptes, les exports et les relances ne se
-- lisent ni ne s'écrivent depuis un espace client : toute écriture sous portée
-- client (`@app_client_ids` non NULL) est refusée (CA015). Les lectures sont
-- filtrées par les requêtes (conventions §6).
DROP TRIGGER IF EXISTS invoice_runs_scope_insert;
--> statement-breakpoint

CREATE TRIGGER invoice_runs_scope_insert BEFORE INSERT ON invoice_runs
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Cette table est réservée au back-office : écriture refusée sous la portée d''un compte client.';
  END IF;
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS invoice_runs_scope_update;
--> statement-breakpoint

CREATE TRIGGER invoice_runs_scope_update BEFORE UPDATE ON invoice_runs
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Cette table est réservée au back-office : écriture refusée sous la portée d''un compte client.';
  END IF;
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS accounting_accounts_scope_insert;
--> statement-breakpoint

CREATE TRIGGER accounting_accounts_scope_insert BEFORE INSERT ON accounting_accounts
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Cette table est réservée au back-office : écriture refusée sous la portée d''un compte client.';
  END IF;
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS accounting_accounts_scope_update;
--> statement-breakpoint

CREATE TRIGGER accounting_accounts_scope_update BEFORE UPDATE ON accounting_accounts
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Cette table est réservée au back-office : écriture refusée sous la portée d''un compte client.';
  END IF;
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS accounting_exports_scope_insert;
--> statement-breakpoint

CREATE TRIGGER accounting_exports_scope_insert BEFORE INSERT ON accounting_exports
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Cette table est réservée au back-office : écriture refusée sous la portée d''un compte client.';
  END IF;
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS accounting_exports_scope_update;
--> statement-breakpoint

CREATE TRIGGER accounting_exports_scope_update BEFORE UPDATE ON accounting_exports
FOR EACH ROW
BEGIN
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Cette table est réservée au back-office : écriture refusée sous la portée d''un compte client.';
  END IF;
END
--> statement-breakpoint

-- Journal des relances (0036) : sur une facture émise, pas un brouillon ni un
-- avoir (CA003). Réservé au back-office.
DROP TRIGGER IF EXISTS invoice_reminders_before_insert;
--> statement-breakpoint

CREATE TRIGGER invoice_reminders_before_insert BEFORE INSERT ON invoice_reminders
FOR EACH ROW
BEGIN
  DECLARE v_count INT DEFAULT 0;
  IF @app_client_ids IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Cette table est réservée au back-office : écriture refusée sous la portée d''un compte client.';
  END IF;
  SELECT COUNT(*) INTO v_count
    FROM invoices
   WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id
     AND kind = 'invoice' AND status <> 'draft' AND deleted_at IS NULL;
  IF v_count = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA003: Une relance porte sur une facture émise, pas sur un brouillon ni un avoir.';
  END IF;
END
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Souscriptions (0031, 0030)
-- ---------------------------------------------------------------------------
-- Ce qui a été convenu ne se réécrit pas (prix, TVA, quantité, inclus, service,
-- client, contrat, début) : on y met fin (`ends_on`) ou on l'archive, puis on
-- souscrit à nouveau (CA004). Remplace aussi la contrainte d'exclusion
-- `subscribed_services_no_overlap` : un client ne souscrit pas deux fois le
-- même service, pour le même contrat, sur des jours qui se recouvrent (CA000).
-- Les écritures d'un même client sont sérialisées par un verrou sur sa fiche.
DROP TRIGGER IF EXISTS subscribed_services_before_insert;
--> statement-breakpoint

CREATE TRIGGER subscribed_services_before_insert BEFORE INSERT ON subscribed_services
FOR EACH ROW
BEGIN
  -- Copie locale de la portée : une variable de session n'a pas la collation des colonnes.
  DECLARE v_scope VARCHAR(4000) DEFAULT @app_client_ids;
  DECLARE v_lock CHAR(36);
  DECLARE v_count INT DEFAULT 0;
  IF v_scope IS NOT NULL AND FIND_IN_SET(NEW.client_id, v_scope) = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Cette ligne n''appartient à aucune entreprise du compte connecté.';
  END IF;
  IF NEW.deleted_at IS NULL THEN
    SELECT id INTO v_lock FROM clients WHERE tenant_id = NEW.tenant_id AND id = NEW.client_id FOR UPDATE;
    SELECT COUNT(*) INTO v_count
      FROM subscribed_services AS s
     WHERE s.tenant_id = NEW.tenant_id AND s.client_id = NEW.client_id
       AND s.service_id = NEW.service_id
       AND COALESCE(s.contract_id, '00000000-0000-0000-0000-000000000000')
         = COALESCE(NEW.contract_id, '00000000-0000-0000-0000-000000000000')
       AND s.deleted_at IS NULL AND s.id <> NEW.id
       AND s.starts_on <= COALESCE(NEW.ends_on, '9999-12-31')
       AND NEW.starts_on <= COALESCE(s.ends_on, '9999-12-31');
    IF v_count > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA000: Ce client a déjà souscrit ce service sur des jours qui se recouvrent.';
    END IF;
  END IF;
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS subscribed_services_before_update;
--> statement-breakpoint

CREATE TRIGGER subscribed_services_before_update BEFORE UPDATE ON subscribed_services
FOR EACH ROW
BEGIN
  -- Copie locale de la portée : une variable de session n'a pas la collation des colonnes.
  DECLARE v_scope VARCHAR(4000) DEFAULT @app_client_ids;
  DECLARE v_lock CHAR(36);
  DECLARE v_count INT DEFAULT 0;
  IF v_scope IS NOT NULL AND FIND_IN_SET(NEW.client_id, v_scope) = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Cette ligne n''appartient à aucune entreprise du compte connecté.';
  END IF;
  IF v_scope IS NOT NULL AND FIND_IN_SET(OLD.client_id, v_scope) = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Cette ligne n''appartient à aucune entreprise du compte connecté.';
  END IF;
  IF NOT (NEW.tenant_id <=> OLD.tenant_id
        AND NEW.client_id <=> OLD.client_id
        AND NEW.contract_id <=> OLD.contract_id
        AND NEW.service_id <=> OLD.service_id
        AND NEW.quantity <=> OLD.quantity
        AND NEW.unit <=> OLD.unit
        AND NEW.unit_price_cents <=> OLD.unit_price_cents
        AND NEW.discount_bp <=> OLD.discount_bp
        AND NEW.discount_amount_cents <=> OLD.discount_amount_cents
        AND NEW.vat_rate_bp <=> OLD.vat_rate_bp
        AND NEW.currency <=> OLD.currency
        AND NEW.included_quantity <=> OLD.included_quantity
        AND NEW.starts_on <=> OLD.starts_on) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA004: Une souscription ne se réécrit pas : mettez-y fin, puis souscrivez aux nouvelles conditions.';
  END IF;
  IF NEW.deleted_at IS NULL THEN
    SELECT id INTO v_lock FROM clients WHERE tenant_id = NEW.tenant_id AND id = NEW.client_id FOR UPDATE;
    SELECT COUNT(*) INTO v_count
      FROM subscribed_services AS s
     WHERE s.tenant_id = NEW.tenant_id AND s.client_id = NEW.client_id
       AND s.service_id = NEW.service_id
       AND COALESCE(s.contract_id, '00000000-0000-0000-0000-000000000000')
         = COALESCE(NEW.contract_id, '00000000-0000-0000-0000-000000000000')
       AND s.deleted_at IS NULL AND s.id <> NEW.id
       AND s.starts_on <= COALESCE(NEW.ends_on, '9999-12-31')
       AND NEW.starts_on <= COALESCE(s.ends_on, '9999-12-31');
    IF v_count > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA000: Ce client a déjà souscrit ce service sur des jours qui se recouvrent.';
    END IF;
  END IF;
END
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. Mandats SEPA (0031)
-- ---------------------------------------------------------------------------
-- La RUM et le client ne changent jamais (règlement SEPA, CA007). Un
-- changement de compte réécrit l'IBAN chiffré sous la même RUM.
DROP TRIGGER IF EXISTS sepa_mandates_before_insert;
--> statement-breakpoint

CREATE TRIGGER sepa_mandates_before_insert BEFORE INSERT ON sepa_mandates
FOR EACH ROW
BEGIN
  -- Copie locale de la portée : une variable de session n'a pas la collation des colonnes.
  DECLARE v_scope VARCHAR(4000) DEFAULT @app_client_ids;
  IF v_scope IS NOT NULL AND FIND_IN_SET(NEW.client_id, v_scope) = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Cette ligne n''appartient à aucune entreprise du compte connecté.';
  END IF;
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS sepa_mandates_before_update;
--> statement-breakpoint

CREATE TRIGGER sepa_mandates_before_update BEFORE UPDATE ON sepa_mandates
FOR EACH ROW
BEGIN
  -- Copie locale de la portée : une variable de session n'a pas la collation des colonnes.
  DECLARE v_scope VARCHAR(4000) DEFAULT @app_client_ids;
  IF v_scope IS NOT NULL AND FIND_IN_SET(NEW.client_id, v_scope) = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Cette ligne n''appartient à aucune entreprise du compte connecté.';
  END IF;
  IF v_scope IS NOT NULL AND FIND_IN_SET(OLD.client_id, v_scope) = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA015: Cette ligne n''appartient à aucune entreprise du compte connecté.';
  END IF;
  IF NEW.reference <> OLD.reference OR NEW.client_id <> OLD.client_id OR NEW.tenant_id <> OLD.tenant_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA007: La RUM et le débiteur d''un mandat ne changent pas : établissez un nouveau mandat.';
  END IF;
END
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. Lignes de facture (0031, 0032, 0040, 0041)
-- ---------------------------------------------------------------------------
-- Garde des lignes, avant chaque écriture :
--
-- - une ligne ne se supprime pas (décision 6) ; d'un brouillon, elle se retire
--   par `deleted_at` ;
-- - une ligne d'une facture émise ne change plus (CA002), sauf la libération
--   de sa source par un avoir émis (`released_at`, posée par la base) ;
-- - dans un brouillon : une ligne d'avoir ne porte pas de source et ne crédite
--   qu'une ligne de la facture corrigée ; une ligne de facture porte la source
--   que sa nature exige, et cette source est celle du client facturé (CA003) ;
-- - un loyer ou un forfait de contrat vise un contrat engagé, et la version de
--   prix en vigueur sur toute sa période (vue `contract_price_versions`) ;
--   un forfait souscrit, une souscription qui couvre la période ; un acte de
--   courrier, un pli ouvert et non retiré, ou une demande faite (CA003) ;
-- - une ligne ponctuelle d'un contrat (`is_recurring` faux) prend pour période
--   le premier jour de sa version ;
-- - une source n'est facturée qu'une fois : les index uniques (réservation,
--   pli, demande) et, ici, les deux exclusions de période (contrat, souscription)
--   qui remplacent `invoice_lines_contract_period_no_overlap` et
--   `invoice_lines_subscription_period_no_overlap` (CA000) ;
-- - TVA provisoire de la ligne et TTC ; la répartition par taux est faite par
--   `invoice_refresh_amounts()`.
--
-- La procédure porte tout ce qui est commun à l'insertion et à la mise à jour ;
-- les triggers lui passent les valeurs de la ligne (un trigger MySQL ne peut
-- pas partager son corps) et reprennent d'elle les jours de la période d'une
-- ligne ponctuelle.
DROP PROCEDURE IF EXISTS invoice_line_check;
--> statement-breakpoint

CREATE PROCEDURE invoice_line_check(
  IN p_is_update TINYINT,
  IN p_tenant_id CHAR(36),
  IN p_id CHAR(36),
  IN p_invoice_id CHAR(36),
  IN p_old_tenant_id CHAR(36),
  IN p_old_invoice_id CHAR(36),
  IN p_same_but_released TINYINT,
  IN p_same_but_deleted TINYINT,
  IN p_kind VARCHAR(20),
  IN p_contract_id CHAR(36),
  IN p_contract_line_id CHAR(36),
  IN p_booking_id CHAR(36),
  IN p_subscribed_service_id CHAR(36),
  IN p_mail_item_id CHAR(36),
  IN p_mail_request_id CHAR(36),
  IN p_service_id CHAR(36),
  IN p_credited_line_id CHAR(36),
  IN p_quantity INT,
  IN p_unit_price_cents INT,
  IN p_discount_bp INT,
  IN p_discount_cents INT,
  IN p_prorata_numerator INT,
  IN p_released_at DATETIME(3),
  IN p_deleted_at DATETIME(3),
  INOUT p_period_start DATE,
  INOUT p_period_end DATE,
  OUT p_compute TINYINT
)
READS SQL DATA
main: BEGIN
  DECLARE v_message VARCHAR(128);
  DECLARE v_status VARCHAR(20);
  DECLARE v_invoice_kind VARCHAR(20);
  DECLARE v_client CHAR(36);
  DECLARE v_number VARCHAR(32);
  DECLARE v_invoice_deleted DATETIME(3);
  DECLARE v_credited_invoice CHAR(36);
  DECLARE v_currency CHAR(3);
  DECLARE v_other CHAR(36);
  DECLARE v_count INT DEFAULT 0;
  DECLARE v_recurring TINYINT;
  DECLARE v_version_start DATE;
  DECLARE v_version_amendment CHAR(36);
  DECLARE v_version_end DATE;
  DECLARE v_req_client CHAR(36);
  DECLARE v_req_kind VARCHAR(20);
  DECLARE v_req_status VARCHAR(20);
  DECLARE v_req_postage INT;
  DECLARE v_req_currency CHAR(3);
  DECLARE v_service_code VARCHAR(40);
  DECLARE v_zero CHAR(36) DEFAULT '00000000-0000-0000-0000-000000000000';

  SET p_compute = 0;

  -- Verrou partagé sur la facture : l'émission (verrou exclusif) attend les
  -- écritures de lignes en cours, et inversement.
  SELECT status, kind, client_id, number, deleted_at, credited_invoice_id, currency
    INTO v_status, v_invoice_kind, v_client, v_number, v_invoice_deleted, v_credited_invoice, v_currency
    FROM invoices
   WHERE tenant_id = p_tenant_id AND id = p_invoice_id
     FOR SHARE;
  IF v_status IS NULL THEN
    -- La clé étrangère le dira, avec son propre code.
    LEAVE main;
  END IF;

  IF p_is_update = 1 AND (p_invoice_id <> p_old_invoice_id OR p_tenant_id <> p_old_tenant_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA002: Une ligne ne change pas de facture.';
  END IF;

  IF v_status <> 'draft' THEN
    IF p_is_update = 1 AND COALESCE(@app_invoice_settlement_sync, '') = 'on' AND p_same_but_released = 1 THEN
      LEAVE main;
    END IF;
    SET v_message = LEFT(CONCAT('CA002: La facture ', v_number,
      ' est émise : ses lignes ne se modifient plus. Toute correction passe par un avoir.'), 128);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;

  IF v_invoice_deleted IS NOT NULL THEN
    -- Brouillon abandonné : ses lignes ne font que se retirer avec lui.
    IF p_is_update = 1 AND p_deleted_at IS NOT NULL AND p_same_but_deleted = 1 THEN
      LEAVE main;
    END IF;
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA002: Ce brouillon a été abandonné : il ne se modifie plus.';
  END IF;

  IF p_released_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA003: La libération d''une source est posée par la base, à l''émission d''un avoir.';
  END IF;

  IF v_invoice_kind = 'credit_note' THEN
    IF (p_contract_id IS NOT NULL) + (p_contract_line_id IS NOT NULL) + (p_booking_id IS NOT NULL)
       + (p_subscribed_service_id IS NOT NULL) + (p_mail_item_id IS NOT NULL)
       + (p_mail_request_id IS NOT NULL) > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA003: Une ligne d''avoir ne porte pas de source : elle désigne la ligne qu''elle crédite.';
    END IF;
    IF p_credited_line_id IS NOT NULL THEN
      SELECT COUNT(*) INTO v_count
        FROM invoice_lines AS o
       WHERE o.tenant_id = p_tenant_id AND o.id = p_credited_line_id
         AND o.invoice_id = v_credited_invoice AND o.deleted_at IS NULL;
      IF v_count = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
          'CA003: La ligne créditée n''appartient pas à la facture que l''avoir corrige.';
      END IF;
    END IF;
  ELSE
    IF p_credited_line_id IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA003: Seule une ligne d''avoir crédite une ligne de facture.';
    END IF;

    IF (p_kind = 'rent' AND (p_contract_id IS NULL OR p_period_start IS NULL))
       OR (p_kind = 'booking' AND p_booking_id IS NULL)
       OR (p_kind = 'act' AND p_service_id IS NULL)
       OR (p_kind = 'package' AND ((p_subscribed_service_id IS NULL AND p_contract_line_id IS NULL)
                                   OR p_period_start IS NULL))
       OR (p_booking_id IS NOT NULL AND p_kind <> 'booking')
       OR (p_mail_item_id IS NOT NULL AND p_kind <> 'act')
       OR (p_mail_request_id IS NOT NULL AND p_kind NOT IN ('act', 'other'))
       OR (p_contract_line_id IS NOT NULL AND p_kind NOT IN ('rent', 'package'))
       OR (p_subscribed_service_id IS NOT NULL AND p_kind NOT IN ('package', 'act')) THEN
      SET v_message = LEFT(CONCAT('CA003: Ligne de facture incohérente : une ligne « ',
        p_kind, ' » ne porte pas cette source.'), 128);
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
    END IF;

    IF p_contract_id IS NOT NULL THEN
      SET v_other = NULL;
      SELECT client_id INTO v_other FROM contracts WHERE tenant_id = p_tenant_id AND id = p_contract_id;
      IF NOT (v_other <=> v_client) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA003: Ce contrat n''est pas celui du client facturé.';
      END IF;
    END IF;
    IF p_booking_id IS NOT NULL THEN
      SET v_other = NULL;
      SELECT client_id INTO v_other FROM bookings
       WHERE tenant_id = p_tenant_id AND id = p_booking_id AND kind = 'booking';
      IF NOT (v_other <=> v_client) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
          'CA003: Cette réservation n''est pas une réservation du client facturé.';
      END IF;
    END IF;
    IF p_subscribed_service_id IS NOT NULL THEN
      SET v_other = NULL;
      SELECT client_id INTO v_other FROM subscribed_services
       WHERE tenant_id = p_tenant_id AND id = p_subscribed_service_id;
      IF NOT (v_other <=> v_client) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA003: Cette souscription n''est pas celle du client facturé.';
      END IF;
    END IF;
    IF p_mail_item_id IS NOT NULL THEN
      SET v_other = NULL;
      SELECT client_id INTO v_other FROM mail_items WHERE tenant_id = p_tenant_id AND id = p_mail_item_id;
      IF NOT (v_other <=> v_client) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA003: Ce pli n''est pas adressé au client facturé.';
      END IF;
    END IF;

    -- Demande de courrier faite (ADR 037) : verrouillée en partage, ses frais
    -- ne changent pas pendant qu'on la facture.
    IF p_mail_request_id IS NOT NULL THEN
      SELECT client_id, kind, status, postage_cents, postage_currency
        INTO v_req_client, v_req_kind, v_req_status, v_req_postage, v_req_currency
        FROM mail_requests
       WHERE tenant_id = p_tenant_id AND id = p_mail_request_id
         FOR SHARE;
      IF v_req_status IS NOT NULL THEN
        IF NOT (v_req_client <=> v_client) THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
            'CA003: Cette demande de courrier n''est pas celle du client facturé.';
        END IF;
        IF v_req_kind = 'open_and_scan' THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
            'CA003: Une ouverture se facture par son pli (mail_item_id), jamais par sa demande.';
        END IF;
        IF v_req_status <> 'done' THEN
          SET v_message = LEFT(CONCAT('CA003: Seule une demande faite se facture : celle-ci est « ', v_req_status, ' ».'), 128);
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
        END IF;
        IF p_kind = 'act' THEN
          SET v_service_code = mail_request_service_code(v_req_kind);
          SELECT COUNT(*) INTO v_count
            FROM services
           WHERE tenant_id = p_tenant_id AND id = p_service_id AND code = v_service_code;
          IF v_count = 0 THEN
            SET v_message = LEFT(CONCAT('CA003: Cette demande se facture avec le service « ', COALESCE(v_service_code, '?'), ' ».'), 128);
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
          END IF;
        ELSE
          IF v_req_kind <> 'forward' OR v_req_postage IS NULL THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
              'CA003: Seuls les frais d''affranchissement relevés d''une réexpédition se facturent ainsi.';
          END IF;
          IF p_quantity <> 1
             OR p_unit_price_cents <> v_req_postage
             OR (p_discount_bp IS NOT NULL) + (p_discount_cents IS NOT NULL) + (p_prorata_numerator IS NOT NULL) > 0
             OR v_req_currency <> v_currency THEN
            SET v_message = LEFT(CONCAT('CA003: Les frais d''affranchissement se refacturent tels que relevés : ', v_req_postage,
                          ' centimes (', v_req_currency, '), une fois, sans remise.'), 128);
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
          END IF;
        END IF;
      END IF;
    END IF;

    -- Ligne ponctuelle d'un contrat : sa période est le premier jour de sa version.
    IF p_contract_line_id IS NOT NULL THEN
      SET v_recurring = NULL;
      SELECT cl.is_recurring, COALESCE(a.effective_on, k.starts_on)
        INTO v_recurring, v_version_start
        FROM contract_lines AS cl
        JOIN contracts AS k ON k.tenant_id = cl.tenant_id AND k.id = cl.contract_id
        LEFT JOIN contract_amendments AS a ON a.tenant_id = cl.tenant_id AND a.id = cl.amendment_id
       WHERE cl.tenant_id = p_tenant_id AND cl.id = p_contract_line_id;
      IF v_recurring IS NOT NULL AND v_recurring = 0 THEN
        SET p_period_start = v_version_start;
        SET p_period_end = v_version_start;
      END IF;
    END IF;

    -- Loyer ou forfait d'un contrat : un contrat engagé, et la version de prix
    -- en vigueur sur toute la période de la ligne. Le contrat est verrouillé en
    -- écriture : la signature d'un avenant attend la facturation en cours, et
    -- deux lignes du même contrat ne se vérifient pas en même temps (c'est ce
    -- qui tenait l'exclusion de période).
    IF p_contract_id IS NOT NULL AND p_kind IN ('rent', 'package') AND p_subscribed_service_id IS NULL THEN
      SELECT COUNT(*) INTO v_count
        FROM contracts
       WHERE tenant_id = p_tenant_id AND id = p_contract_id
         AND status IN ('active', 'terminated') AND deleted_at IS NULL
         FOR UPDATE;
      IF v_count = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
          'CA003: Seul un contrat engagé (en cours ou résilié, non archivé) se facture.';
      END IF;
      SELECT COUNT(*) INTO v_count
        FROM contract_price_versions AS v
       WHERE v.tenant_id = p_tenant_id AND v.contract_id = p_contract_id AND v.starts_on <= p_period_start;
      IF v_count = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA003: La période facturée commence avant le contrat.';
      END IF;
      SELECT v.amendment_id, v.ends_on INTO v_version_amendment, v_version_end
        FROM contract_price_versions AS v
       WHERE v.tenant_id = p_tenant_id AND v.contract_id = p_contract_id AND v.starts_on <= p_period_start
       ORDER BY v.starts_on DESC
       LIMIT 1;
      IF v_version_end IS NOT NULL AND p_period_end > v_version_end THEN
        SET v_message = LEFT(CONCAT(
          'CA003: La période facturée dépasse la version du contrat qui la couvre (jusqu''au ',
          DATE_FORMAT(v_version_end, '%d/%m/%Y'), ').'), 128);
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
      END IF;
      IF p_contract_line_id IS NOT NULL THEN
        SELECT COUNT(*) INTO v_count
          FROM contract_lines
         WHERE tenant_id = p_tenant_id AND id = p_contract_line_id
           AND amendment_id <=> v_version_amendment;
        IF v_count = 0 THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
            'CA003: Cette ligne de contrat n''est pas celle de la version en vigueur sur la période.';
        END IF;
      ELSE
        SELECT COUNT(*) INTO v_count
          FROM contract_lines
         WHERE tenant_id = p_tenant_id AND contract_id = p_contract_id
           AND amendment_id <=> v_version_amendment
           AND deleted_at IS NULL AND is_recurring <> 0;
        IF v_count > 0 THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
            'CA003: Ce contrat a des lignes récurrentes sur cette période : facturez-les ligne à ligne.';
        END IF;
      END IF;

      -- Aucun jour déjà tenu par une autre version du contrat. La version d'une
      -- ligne existante : celle de sa ligne de contrat, ou, pour un loyer
      -- global, celle en vigueur sur son premier jour.
      IF p_deleted_at IS NULL THEN
        SELECT COUNT(*) INTO v_count
          FROM invoice_lines AS e
          LEFT JOIN contract_lines AS el ON el.tenant_id = e.tenant_id AND el.id = e.contract_line_id
         WHERE e.tenant_id = p_tenant_id
           AND e.contract_id = p_contract_id
           AND e.id <> p_id
           AND e.kind IN ('rent', 'package')
           AND e.subscribed_service_id IS NULL
           AND e.period_start IS NOT NULL
           AND e.deleted_at IS NULL
           AND e.released_at IS NULL
           AND e.period_start <= p_period_end AND p_period_start <= e.period_end
           AND NOT ((CASE
                       WHEN e.contract_line_id IS NOT NULL THEN el.amendment_id
                       ELSE (SELECT v.amendment_id
                               FROM contract_price_versions AS v
                              WHERE v.tenant_id = p_tenant_id AND v.contract_id = p_contract_id
                                AND v.starts_on <= e.period_start
                              ORDER BY v.starts_on DESC
                              LIMIT 1)
                     END) <=> v_version_amendment);
        IF v_count > 0 THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
            'CA003: Ces jours sont déjà facturés par une autre version du prix du contrat : établissez d''abord un avoir.';
        END IF;
      END IF;
    END IF;

    -- Forfait souscrit : la souscription couvre toute la période.
    IF p_subscribed_service_id IS NOT NULL AND p_kind = 'package' THEN
      SELECT COUNT(*) INTO v_count
        FROM subscribed_services
       WHERE tenant_id = p_tenant_id AND id = p_subscribed_service_id
         AND deleted_at IS NULL
         AND starts_on <= p_period_start
         AND (ends_on IS NULL OR ends_on >= p_period_end);
      IF v_count = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
          'CA003: La souscription ne couvre pas toute la période facturée.';
      END IF;
    END IF;

    -- Un pli se facture ouvert, et pas s'il a été retiré (ADR 015).
    IF p_mail_item_id IS NOT NULL THEN
      SELECT COUNT(*) INTO v_count
        FROM mail_items
       WHERE tenant_id = p_tenant_id AND id = p_mail_item_id
         AND opened_at IS NOT NULL AND deleted_at IS NULL;
      IF v_count = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA003: Seul un pli ouvert, et non retiré, se facture.';
      END IF;
    END IF;
  END IF;

  -- Exclusions de période (une source n'est facturée qu'une fois, hors avoir).
  IF p_deleted_at IS NULL AND p_period_start IS NOT NULL THEN
    IF p_kind IN ('rent', 'package') AND p_contract_id IS NOT NULL AND p_subscribed_service_id IS NULL THEN
      SELECT COUNT(*) INTO v_count
        FROM invoice_lines AS e
       WHERE e.tenant_id = p_tenant_id AND e.contract_id = p_contract_id
         AND COALESCE(e.contract_line_id, v_zero) = COALESCE(p_contract_line_id, v_zero)
         AND e.kind IN ('rent', 'package') AND e.subscribed_service_id IS NULL
         AND e.period_start IS NOT NULL AND e.deleted_at IS NULL AND e.released_at IS NULL
         AND e.id <> p_id
         AND e.period_start <= p_period_end AND p_period_start <= e.period_end;
      IF v_count > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
          'CA000: Ce contrat est déjà facturé sur une partie de ces jours.';
      END IF;
    END IF;
    IF p_kind = 'package' AND p_subscribed_service_id IS NOT NULL THEN
      -- La souscription est verrouillée : deux lignes ne se vérifient pas en même temps.
      SELECT id INTO v_other FROM subscribed_services
       WHERE tenant_id = p_tenant_id AND id = p_subscribed_service_id FOR UPDATE;
      SELECT COUNT(*) INTO v_count
        FROM invoice_lines AS e
       WHERE e.tenant_id = p_tenant_id AND e.subscribed_service_id = p_subscribed_service_id
         AND e.kind = 'package' AND e.period_start IS NOT NULL
         AND e.deleted_at IS NULL AND e.released_at IS NULL
         AND e.id <> p_id
         AND e.period_start <= p_period_end AND p_period_start <= e.period_end;
      IF v_count > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
          'CA000: Cette souscription est déjà facturée sur une partie de ces jours.';
      END IF;
    END IF;
  END IF;

  SET p_compute = 1;
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS invoice_lines_before_insert;
--> statement-breakpoint

CREATE TRIGGER invoice_lines_before_insert BEFORE INSERT ON invoice_lines
FOR EACH ROW
BEGIN
  -- Copie locale de la portée : une variable de session n'a pas la collation des colonnes.
  DECLARE v_scope VARCHAR(4000) DEFAULT @app_client_ids;
  DECLARE v_count INT DEFAULT 0;
  DECLARE v_compute TINYINT DEFAULT 0;
  DECLARE v_net INT;
  DECLARE v_period_start DATE DEFAULT NEW.period_start;
  DECLARE v_period_end DATE DEFAULT NEW.period_end;
  IF v_scope IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count
      FROM invoices AS i
     WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.invoice_id
       AND FIND_IN_SET(i.client_id, v_scope) > 0
       AND i.status <> 'draft' AND i.deleted_at IS NULL;
    IF v_count = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA015: Cette ligne n''appartient à aucune entreprise du compte connecté.';
    END IF;
  END IF;
  CALL invoice_line_check(0, NEW.tenant_id, NEW.id, NEW.invoice_id, NEW.tenant_id, NEW.invoice_id, 0, 0,
    NEW.kind, NEW.contract_id, NEW.contract_line_id, NEW.booking_id, NEW.subscribed_service_id,
    NEW.mail_item_id, NEW.mail_request_id, NEW.service_id, NEW.credited_line_id,
    NEW.quantity, NEW.unit_price_cents, NEW.discount_bp, NEW.discount_amount_cents,
    NEW.prorata_numerator, NEW.released_at, NEW.deleted_at,
    v_period_start, v_period_end, v_compute);
  IF v_compute = 1 THEN
    SET NEW.period_start = v_period_start;
    SET NEW.period_end = v_period_end;
    SET v_net = line_net_amount_cents(NEW.quantity, NEW.unit_price_cents, NEW.discount_bp,
                                      NEW.discount_amount_cents, NEW.prorata_numerator,
                                      NEW.prorata_denominator);
    -- Sous `invoice_refresh_amounts()` la TVA vient du calcul par taux.
    IF COALESCE(@app_invoice_amounts_sync, '') <> 'on' THEN
      SET NEW.vat_amount_cents = vat_amount_cents(v_net, NEW.vat_rate_bp);
    END IF;
    SET NEW.total_amount_cents = v_net + NEW.vat_amount_cents;
  END IF;
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS invoice_lines_before_update;
--> statement-breakpoint

CREATE TRIGGER invoice_lines_before_update BEFORE UPDATE ON invoice_lines
FOR EACH ROW
BEGIN
  -- Copie locale de la portée : une variable de session n'a pas la collation des colonnes.
  DECLARE v_scope VARCHAR(4000) DEFAULT @app_client_ids;
  DECLARE v_count INT DEFAULT 0;
  DECLARE v_compute TINYINT DEFAULT 0;
  DECLARE v_net INT;
  DECLARE v_same_but_released TINYINT DEFAULT 0;
  DECLARE v_same_but_deleted TINYINT DEFAULT 0;
  DECLARE v_period_start DATE DEFAULT NEW.period_start;
  DECLARE v_period_end DATE DEFAULT NEW.period_end;
  IF v_scope IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count
      FROM invoices AS i
     WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.invoice_id
       AND FIND_IN_SET(i.client_id, v_scope) > 0
       AND i.status <> 'draft' AND i.deleted_at IS NULL;
    IF v_count = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA015: Cette ligne n''appartient à aucune entreprise du compte connecté.';
    END IF;
  END IF;
  -- « La ligne n'a changé que par … » : comparaison colonne par colonne
  -- (MySQL n'a pas `to_jsonb(NEW)`). Une colonne ajoutée à `invoice_lines`
  -- doit l'être ici aussi ; `updated_at` et les colonnes générées sont exclues.
  IF NEW.id <=> OLD.id
      AND NEW.tenant_id <=> OLD.tenant_id
      AND NEW.invoice_id <=> OLD.invoice_id
      AND NEW.position <=> OLD.position
      AND NEW.kind <=> OLD.kind
      AND NEW.description <=> OLD.description
      AND NEW.period_start <=> OLD.period_start
      AND NEW.period_end <=> OLD.period_end
      AND NEW.quantity <=> OLD.quantity
      AND NEW.unit <=> OLD.unit
      AND NEW.unit_price_cents <=> OLD.unit_price_cents
      AND NEW.discount_bp <=> OLD.discount_bp
      AND NEW.discount_amount_cents <=> OLD.discount_amount_cents
      AND NEW.prorata_numerator <=> OLD.prorata_numerator
      AND NEW.prorata_denominator <=> OLD.prorata_denominator
      AND NEW.vat_rate_bp <=> OLD.vat_rate_bp
      AND NEW.vat_category <=> OLD.vat_category
      AND NEW.vat_exemption_reason <=> OLD.vat_exemption_reason
      AND NEW.vat_amount_cents <=> OLD.vat_amount_cents
      AND NEW.total_amount_cents <=> OLD.total_amount_cents
      AND NEW.contract_id <=> OLD.contract_id
      AND NEW.contract_line_id <=> OLD.contract_line_id
      AND NEW.booking_id <=> OLD.booking_id
      AND NEW.subscribed_service_id <=> OLD.subscribed_service_id
      AND NEW.mail_item_id <=> OLD.mail_item_id
      AND NEW.mail_request_id <=> OLD.mail_request_id
      AND NEW.service_id <=> OLD.service_id
      AND NEW.resource_id <=> OLD.resource_id
      AND NEW.credited_line_id <=> OLD.credited_line_id
      AND NEW.created_at <=> OLD.created_at
      AND NEW.deleted_at <=> OLD.deleted_at THEN
    SET v_same_but_released = 1;
  END IF;
  IF NEW.id <=> OLD.id
      AND NEW.tenant_id <=> OLD.tenant_id
      AND NEW.invoice_id <=> OLD.invoice_id
      AND NEW.position <=> OLD.position
      AND NEW.kind <=> OLD.kind
      AND NEW.description <=> OLD.description
      AND NEW.period_start <=> OLD.period_start
      AND NEW.period_end <=> OLD.period_end
      AND NEW.quantity <=> OLD.quantity
      AND NEW.unit <=> OLD.unit
      AND NEW.unit_price_cents <=> OLD.unit_price_cents
      AND NEW.discount_bp <=> OLD.discount_bp
      AND NEW.discount_amount_cents <=> OLD.discount_amount_cents
      AND NEW.prorata_numerator <=> OLD.prorata_numerator
      AND NEW.prorata_denominator <=> OLD.prorata_denominator
      AND NEW.vat_rate_bp <=> OLD.vat_rate_bp
      AND NEW.vat_category <=> OLD.vat_category
      AND NEW.vat_exemption_reason <=> OLD.vat_exemption_reason
      AND NEW.vat_amount_cents <=> OLD.vat_amount_cents
      AND NEW.total_amount_cents <=> OLD.total_amount_cents
      AND NEW.contract_id <=> OLD.contract_id
      AND NEW.contract_line_id <=> OLD.contract_line_id
      AND NEW.booking_id <=> OLD.booking_id
      AND NEW.subscribed_service_id <=> OLD.subscribed_service_id
      AND NEW.mail_item_id <=> OLD.mail_item_id
      AND NEW.mail_request_id <=> OLD.mail_request_id
      AND NEW.service_id <=> OLD.service_id
      AND NEW.resource_id <=> OLD.resource_id
      AND NEW.credited_line_id <=> OLD.credited_line_id
      AND NEW.released_at <=> OLD.released_at
      AND NEW.created_at <=> OLD.created_at THEN
    SET v_same_but_deleted = 1;
  END IF;
  CALL invoice_line_check(1, NEW.tenant_id, NEW.id, NEW.invoice_id, OLD.tenant_id, OLD.invoice_id,
    v_same_but_released, v_same_but_deleted,
    NEW.kind, NEW.contract_id, NEW.contract_line_id, NEW.booking_id, NEW.subscribed_service_id,
    NEW.mail_item_id, NEW.mail_request_id, NEW.service_id, NEW.credited_line_id,
    NEW.quantity, NEW.unit_price_cents, NEW.discount_bp, NEW.discount_amount_cents,
    NEW.prorata_numerator, NEW.released_at, NEW.deleted_at,
    v_period_start, v_period_end, v_compute);
  IF v_compute = 1 THEN
    SET NEW.period_start = v_period_start;
    SET NEW.period_end = v_period_end;
    SET v_net = line_net_amount_cents(NEW.quantity, NEW.unit_price_cents, NEW.discount_bp,
                                      NEW.discount_amount_cents, NEW.prorata_numerator,
                                      NEW.prorata_denominator);
    -- Sous `invoice_refresh_amounts()` la TVA vient du calcul par taux.
    IF COALESCE(@app_invoice_amounts_sync, '') <> 'on' THEN
      SET NEW.vat_amount_cents = vat_amount_cents(v_net, NEW.vat_rate_bp);
    END IF;
    SET NEW.total_amount_cents = v_net + NEW.vat_amount_cents;
  END IF;
END
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 9. Factures : nées brouillons, émises par la base, figées ensuite (0031)
-- ---------------------------------------------------------------------------
-- Garde de `invoices` :
--
-- - une facture naît brouillon, totaux et règlements à zéro ; un avoir vise
--   une facture émise ;
-- - un brouillon se modifie, sauf ses totaux (tenus par la base), sa nature,
--   la facture qu'il corrige, et son client une fois qu'il a des lignes ;
--   il ne passe à l'état émis que par `issue_invoice()` ;
-- - un brouillon abandonné (`deleted_at`) ne change plus ;
-- - une facture émise ne change plus (CA002), sauf ce que la base déduit des
--   paiements et des avoirs (`paid_cents`, `credited_cents`, `status`) ;
-- - une facture ne se supprime jamais (section 4).
--
-- Sous portée client, seules les factures et avoirs émis de ses entreprises
-- s'écrivent : un client ne voit jamais un brouillon (R17).
DROP TRIGGER IF EXISTS invoices_before_insert;
--> statement-breakpoint

CREATE TRIGGER invoices_before_insert BEFORE INSERT ON invoices
FOR EACH ROW
BEGIN
  -- Copie locale de la portée : une variable de session n'a pas la collation des colonnes.
  DECLARE v_scope VARCHAR(4000) DEFAULT @app_client_ids;
  DECLARE v_count INT DEFAULT 0;
  IF v_scope IS NOT NULL THEN
    IF FIND_IN_SET(NEW.client_id, v_scope) = 0 OR NEW.status = 'draft' OR NEW.deleted_at IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA015: Cette facture n''appartient à aucune entreprise du compte connecté.';
    END IF;
  END IF;
  IF NEW.status <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA003: Une facture naît brouillon : elle est émise par issue_invoice().';
  END IF;
  SET NEW.total_excl_tax_cents = 0;
  SET NEW.total_tax_cents = 0;
  SET NEW.total_incl_tax_cents = 0;
  SET NEW.paid_cents = 0;
  SET NEW.credited_cents = 0;
  IF NEW.kind = 'credit_note' THEN
    SELECT COUNT(*) INTO v_count
      FROM invoices AS o
     WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.credited_invoice_id
       AND o.kind = 'invoice' AND o.status <> 'draft';
    IF v_count = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA003: Un avoir corrige une facture émise.';
    END IF;
  END IF;
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS invoices_before_update;
--> statement-breakpoint

CREATE TRIGGER invoices_before_update BEFORE UPDATE ON invoices
FOR EACH ROW
BEGIN
  -- Copie locale de la portée : une variable de session n'a pas la collation des colonnes.
  DECLARE v_scope VARCHAR(4000) DEFAULT @app_client_ids;
  DECLARE v_message VARCHAR(128);
  DECLARE v_count INT DEFAULT 0;
  IF v_scope IS NOT NULL THEN
    IF FIND_IN_SET(OLD.client_id, v_scope) = 0 OR OLD.status = 'draft' OR OLD.deleted_at IS NOT NULL
       OR FIND_IN_SET(NEW.client_id, v_scope) = 0 OR NEW.status = 'draft' OR NEW.deleted_at IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA015: Cette facture n''appartient à aucune entreprise du compte connecté.';
    END IF;
  END IF;

  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.kind <> OLD.kind
     OR NOT (NEW.credited_invoice_id <=> OLD.credited_invoice_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA002: La nature d''une facture et la facture qu''un avoir corrige ne changent pas.';
  END IF;

  IF OLD.deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA002: Ce brouillon a été abandonné : il ne se modifie plus.';
  END IF;

  IF OLD.status = 'draft' THEN
    IF NEW.status <> 'draft' AND COALESCE(@app_invoice_issue, '') <> 'on' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA003: Une facture s''émet par issue_invoice() : numéro, date, échéance et mentions viennent de la base.';
    END IF;
    IF COALESCE(@app_invoice_amounts_sync, '') <> 'on' THEN
      SET NEW.total_excl_tax_cents = OLD.total_excl_tax_cents;
      SET NEW.total_tax_cents = OLD.total_tax_cents;
      SET NEW.total_incl_tax_cents = OLD.total_incl_tax_cents;
    END IF;
    IF NEW.client_id <> OLD.client_id THEN
      SELECT COUNT(*) INTO v_count
        FROM invoice_lines
       WHERE tenant_id = OLD.tenant_id AND invoice_id = OLD.id AND deleted_at IS NULL;
      IF v_count > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA003: Ce brouillon a des lignes : il ne change pas de client.';
      END IF;
    END IF;
  ELSEIF NOT (COALESCE(@app_invoice_settlement_sync, '') = 'on'
              AND NEW.id <=> OLD.id
                  AND NEW.tenant_id <=> OLD.tenant_id
                  AND NEW.kind <=> OLD.kind
                  AND NEW.number <=> OLD.number
                  AND NEW.client_id <=> OLD.client_id
                  AND NEW.credited_invoice_id <=> OLD.credited_invoice_id
                  AND NEW.invoice_run_id <=> OLD.invoice_run_id
                  AND NEW.period_start <=> OLD.period_start
                  AND NEW.period_end <=> OLD.period_end
                  AND NEW.issue_date <=> OLD.issue_date
                  AND NEW.issued_at <=> OLD.issued_at
                  AND NEW.issued_by <=> OLD.issued_by
                  AND NEW.payment_terms_days <=> OLD.payment_terms_days
                  AND NEW.due_date <=> OLD.due_date
                  AND NEW.currency <=> OLD.currency
                  AND NEW.total_excl_tax_cents <=> OLD.total_excl_tax_cents
                  AND NEW.total_tax_cents <=> OLD.total_tax_cents
                  AND NEW.total_incl_tax_cents <=> OLD.total_incl_tax_cents
                  AND NEW.expected_payment_method <=> OLD.expected_payment_method
                  AND NEW.sepa_mandate_id <=> OLD.sepa_mandate_id
                  AND NEW.mandate_reference <=> OLD.mandate_reference
                  AND NEW.buyer_reference <=> OLD.buyer_reference
                  AND NEW.notes <=> OLD.notes
                  AND NEW.seller_snapshot <=> OLD.seller_snapshot
                  AND NEW.buyer_snapshot <=> OLD.buyer_snapshot
                  AND NEW.legal_mentions <=> OLD.legal_mentions
                  AND NEW.created_at <=> OLD.created_at
                  AND NEW.deleted_at <=> OLD.deleted_at) THEN
    SET v_message = LEFT(CONCAT('CA002: La facture ', OLD.number,
      ' est émise : elle ne se modifie plus. Toute correction passe par un avoir.'), 128);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;
END
--> statement-breakpoint

-- Un brouillon abandonné retire ses lignes : elles libèrent leurs sources,
-- qu'un autre brouillon peut alors facturer.
DROP TRIGGER IF EXISTS invoices_after_update;
--> statement-breakpoint

CREATE TRIGGER invoices_after_update AFTER UPDATE ON invoices
FOR EACH ROW
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    UPDATE invoice_lines
       SET deleted_at = NEW.deleted_at
     WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.id AND deleted_at IS NULL;
  END IF;
END
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 10. Montants d'une facture (EN 16931, 0031, 0032)
-- ---------------------------------------------------------------------------
-- Recalcule la TVA des lignes et les totaux d'un brouillon. La TVA se calcule
-- par catégorie et par taux sur la somme des bases (BR-CO-17), puis se répartit
-- sur les lignes : chacune reçoit sa TVA arrondie, et l'écart d'arrondi du taux
-- va à la ligne de plus forte valeur absolue (puis la première par position).
-- La somme des TVA des lignes égale donc exactement la TVA de la ventilation.
--
-- Sauf, dans un avoir, pour les lignes qui **soldent** une ligne de la facture
-- corrigée (le net crédité, avoirs émis compris, égale son net, au même taux
-- et dans la même catégorie) : elles en créditent exactement la TVA restante —
-- la TVA de la ligne d'origine moins celle que les avoirs émis ont déjà
-- créditée —, pour que le cumul des avoirs retombe sur le TTC de la facture.
--
-- Sans effet sur une facture émise ou un brouillon abandonné. Pose
-- `@app_invoice_amounts_sync` le temps de ses écritures : les gardes laissent
-- alors passer la TVA calculée ici. **À appeler après chaque série
-- d'écritures de lignes** (voir le contrat). Rend 0.
DROP FUNCTION IF EXISTS invoice_refresh_amounts;
--> statement-breakpoint

CREATE FUNCTION invoice_refresh_amounts(p_invoice_id CHAR(36)) RETURNS INT
DETERMINISTIC MODIFIES SQL DATA
BEGIN
  DECLARE v_status VARCHAR(20);
  DECLARE v_kind VARCHAR(20);
  DECLARE v_deleted_at DATETIME(3);
  DECLARE v_tenant CHAR(36);
  DECLARE v_excl BIGINT DEFAULT 0;
  DECLARE v_tax BIGINT DEFAULT 0;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @app_invoice_amounts_sync = NULL;
    RESIGNAL;
  END;

  SELECT tenant_id, status, kind, deleted_at INTO v_tenant, v_status, v_kind, v_deleted_at
    FROM invoices WHERE id = p_invoice_id;
  IF v_status IS NULL OR v_status <> 'draft' OR v_deleted_at IS NOT NULL THEN
    RETURN 0;
  END IF;

  SET @app_invoice_amounts_sync = 'on';

  UPDATE invoice_lines AS l
    JOIN (
      WITH cur_lines AS (
        SELECT l2.id, l2.net_amount_cents AS net, l2.vat_rate_bp AS rate, l2.vat_category AS category,
               l2.position AS position, l2.credited_line_id,
               vat_amount_cents(l2.net_amount_cents, l2.vat_rate_bp) AS line_vat
          FROM invoice_lines AS l2
         WHERE l2.tenant_id = v_tenant AND l2.invoice_id = p_invoice_id AND l2.deleted_at IS NULL
      ), prev AS (
        -- Ce que les avoirs émis ont déjà crédité de chaque ligne d'origine.
        SELECT cl.credited_line_id AS original_id,
               SUM(cl.net_amount_cents) AS net, SUM(cl.vat_amount_cents) AS vat
          FROM invoice_lines AS cl
          JOIN invoices AS cn ON cn.tenant_id = cl.tenant_id AND cn.id = cl.invoice_id
         WHERE cl.tenant_id = v_tenant AND cl.credited_line_id IS NOT NULL
           AND cl.deleted_at IS NULL AND cn.kind = 'credit_note' AND cn.status <> 'draft'
         GROUP BY cl.credited_line_id
      ), settled AS (
        -- Lignes d'origine que cet avoir solde, et la TVA qu'il leur reste.
        SELECT o.id AS original_id,
               o.vat_amount_cents - COALESCE(MAX(prev.vat), 0) AS vat_due
          FROM cur_lines
          JOIN invoice_lines AS o ON o.tenant_id = v_tenant AND o.id = cur_lines.credited_line_id
          LEFT JOIN prev ON prev.original_id = o.id
         WHERE v_kind = 'credit_note'
         GROUP BY o.id, o.net_amount_cents, o.vat_amount_cents, o.vat_rate_bp, o.vat_category
        HAVING SUM(cur_lines.net) + COALESCE(MAX(prev.net), 0) = o.net_amount_cents
           AND MIN(cur_lines.rate = o.vat_rate_bp AND cur_lines.category = o.vat_category) = 1
      ), keyed AS (
        -- Groupe de calcul : la ligne d'origine soldée, ou la catégorie et le taux.
        SELECT cur_lines.*,
               COALESCE(CONCAT('solde:', settled.original_id),
                        CONCAT('taux:', cur_lines.category, ':', cur_lines.rate)) AS grp,
               settled.vat_due
          FROM cur_lines
          LEFT JOIN settled ON settled.original_id = cur_lines.credited_line_id
      ), ranked AS (
        SELECT keyed.*,
               ROW_NUMBER() OVER (PARTITION BY grp ORDER BY ABS(net) DESC, position, id) AS rnk
          FROM keyed
      ), grouped AS (
        SELECT grp,
               COALESCE(MAX(vat_due), vat_amount_cents(SUM(net), MAX(rate))) - SUM(line_vat) AS gap
          FROM ranked
         GROUP BY grp
      )
      SELECT ranked.id, ranked.net,
             ranked.line_vat + CASE WHEN ranked.rnk = 1 THEN grouped.gap ELSE 0 END AS vat
        FROM ranked JOIN grouped ON grouped.grp = ranked.grp
    ) AS target ON target.id = l.id
     SET l.vat_amount_cents = target.vat,
         l.total_amount_cents = target.net + target.vat
   WHERE l.tenant_id = v_tenant
     AND (l.vat_amount_cents <> target.vat OR l.total_amount_cents <> target.net + target.vat);

  SELECT COALESCE(SUM(net_amount_cents), 0), COALESCE(SUM(vat_amount_cents), 0) INTO v_excl, v_tax
    FROM invoice_lines
   WHERE tenant_id = v_tenant AND invoice_id = p_invoice_id AND deleted_at IS NULL;

  UPDATE invoices
     SET total_excl_tax_cents = v_excl,
         total_tax_cents = v_tax,
         total_incl_tax_cents = v_excl + v_tax
   WHERE tenant_id = v_tenant AND id = p_invoice_id
     AND (total_excl_tax_cents <> v_excl OR total_tax_cents <> v_tax);

  SET @app_invoice_amounts_sync = NULL;
  RETURN 0;
END
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 11. Règlement d'une facture émise (0031)
-- ---------------------------------------------------------------------------
-- Paiements non annulés, avoirs émis, statut déduit, et libération des sources
-- des lignes entièrement créditées (une ligne d'avoir émise au moins, et la
-- somme créditée égale à son montant net). Appelée par la base seule : après
-- un paiement, après l'émission d'un avoir. Rend 0.
DROP FUNCTION IF EXISTS invoice_settle;
--> statement-breakpoint

CREATE FUNCTION invoice_settle(p_invoice_id CHAR(36)) RETURNS INT
DETERMINISTIC MODIFIES SQL DATA
BEGIN
  DECLARE v_tenant CHAR(36);
  DECLARE v_kind VARCHAR(20);
  DECLARE v_status VARCHAR(20);
  DECLARE v_total INT;
  DECLARE v_paid BIGINT DEFAULT 0;
  DECLARE v_credited BIGINT DEFAULT 0;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @app_invoice_settlement_sync = NULL;
    RESIGNAL;
  END;

  SELECT tenant_id, kind, status, total_incl_tax_cents INTO v_tenant, v_kind, v_status, v_total
    FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_status IS NULL OR v_status = 'draft' OR v_kind <> 'invoice' THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(SUM(amount_cents), 0) INTO v_paid
    FROM payments
   WHERE tenant_id = v_tenant AND invoice_id = p_invoice_id AND cancelled_at IS NULL;
  SELECT COALESCE(SUM(total_incl_tax_cents), 0) INTO v_credited
    FROM invoices
   WHERE tenant_id = v_tenant AND credited_invoice_id = p_invoice_id
     AND kind = 'credit_note' AND status <> 'draft';

  SET @app_invoice_settlement_sync = 'on';

  UPDATE invoices
     SET paid_cents = v_paid,
         credited_cents = v_credited,
         status = invoice_payment_status(kind, total_incl_tax_cents, v_paid, v_credited)
   WHERE id = p_invoice_id
     AND (paid_cents <> v_paid OR credited_cents <> v_credited);

  -- `released_at` : les lignes entièrement créditées libèrent leur source. La
  -- somme créditée se calcule dans une table dérivée (MySQL refuse une
  -- sous-requête sur la table mise à jour).
  UPDATE invoice_lines AS o
    JOIN (
      SELECT cl.credited_line_id AS original_id, SUM(cl.net_amount_cents) AS credited
        FROM invoice_lines AS cl
        JOIN invoices AS cn ON cn.tenant_id = cl.tenant_id AND cn.id = cl.invoice_id
       WHERE cl.tenant_id = v_tenant AND cl.credited_line_id IS NOT NULL
         AND cl.deleted_at IS NULL AND cn.kind = 'credit_note' AND cn.status <> 'draft'
       GROUP BY cl.credited_line_id
    ) AS c ON c.original_id = o.id
     SET o.released_at = CURRENT_TIMESTAMP(3)
   WHERE o.tenant_id = v_tenant
     AND o.invoice_id = p_invoice_id
     AND o.deleted_at IS NULL
     AND o.released_at IS NULL
     AND c.credited = o.net_amount_cents;

  SET @app_invoice_settlement_sync = NULL;
  RETURN 0;
END
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 12. Émission d'une facture ou d'un avoir (R13, ADR 021, ADR 026, ADR 032)
-- ---------------------------------------------------------------------------
-- Seul chemin d'un brouillon vers l'état émis. Dans la transaction appelante :
--
-- 1. verrouille le brouillon ;
-- 2. vérifie les mentions obligatoires du vendeur et de l'acheteur, le motif
--    d'exonération de TVA des lignes sans taux, et le moyen de paiement (IBAN du
--    centre pour un virement, mandat actif et ICS pour un prélèvement) ;
-- 3. recalcule TVA et totaux ; refuse une facture vide ou négative, un avoir
--    nul, excédentaire, ou qui crédite une ligne au-delà de son montant ;
-- 4. prend le numéro (`next_document_number`, sans trou : une annulation de la
--    transaction le rend), date la facture du jour du centre, calcule
--    l'échéance, fige le vendeur, l'acheteur et les mentions ;
-- 5. pour un avoir, règle la facture corrigée (`invoice_settle`).
--
-- Refus : CA003 (non conforme), CA002 (déjà émise). Rend le numéro. Le jour du
-- centre est calculé par `CONVERT_TZ` : les fuseaux de MySQL doivent être
-- chargés (comme pour `next_document_number`).
DROP FUNCTION IF EXISTS issue_invoice;
--> statement-breakpoint

CREATE FUNCTION issue_invoice(p_invoice_id CHAR(36), p_issued_by CHAR(36)) RETURNS VARCHAR(32)
DETERMINISTIC MODIFIES SQL DATA
BEGIN
  DECLARE v_message VARCHAR(128);
  -- facture
  DECLARE v_tenant_id CHAR(36);
  DECLARE v_kind VARCHAR(20);
  DECLARE v_status VARCHAR(20);
  DECLARE v_number VARCHAR(32);
  DECLARE v_deleted_at DATETIME(3);
  DECLARE v_client_id CHAR(36);
  DECLARE v_credited_invoice_id CHAR(36);
  DECLARE v_currency CHAR(3);
  DECLARE v_method VARCHAR(20);
  DECLARE v_mandate_id CHAR(36);
  DECLARE v_terms_days INT;
  DECLARE v_total INT;
  -- centre
  DECLARE t_timezone VARCHAR(64);
  DECLARE t_legal_name TEXT;
  DECLARE t_legal_form TEXT;
  DECLARE t_share_capital BIGINT;
  DECLARE t_siren TEXT;
  DECLARE t_siret TEXT;
  DECLARE t_vat_number TEXT;
  DECLARE t_rcs_city TEXT;
  DECLARE t_address_line1 TEXT;
  DECLARE t_address_line2 TEXT;
  DECLARE t_postal_code TEXT;
  DECLARE t_city TEXT;
  DECLARE t_country CHAR(2);
  DECLARE t_email TEXT;
  DECLARE t_phone TEXT;
  DECLARE t_website TEXT;
  DECLARE t_bank_iban TEXT;
  DECLARE t_bank_bic TEXT;
  DECLARE t_sepa_creditor TEXT;
  DECLARE t_payment_terms INT;
  DECLARE t_penalty TEXT;
  DECLARE t_recovery INT;
  DECLARE t_discount TEXT;
  DECLARE t_vat_on_debits TINYINT;
  DECLARE t_footer TEXT;
  -- client
  DECLARE c_name VARCHAR(255);
  DECLARE c_legal_form TEXT;
  DECLARE c_siret VARCHAR(14);
  DECLARE c_vat_number TEXT;
  DECLARE c_address_line1 TEXT;
  DECLARE c_address_line2 TEXT;
  DECLARE c_postal_code TEXT;
  DECLARE c_city TEXT;
  DECLARE c_country CHAR(2);
  DECLARE c_email TEXT;
  DECLARE c_accounting_code VARCHAR(17);
  -- avoir et mandat
  DECLARE o_kind VARCHAR(20);
  DECLARE o_status VARCHAR(20);
  DECLARE o_number VARCHAR(32);
  DECLARE o_currency CHAR(3);
  DECLARE o_credited INT;
  DECLARE o_total INT;
  DECLARE m_status VARCHAR(20);
  DECLARE m_deleted_at DATETIME(3);
  DECLARE m_reference VARCHAR(35);
  -- calcul
  DECLARE v_missing TEXT DEFAULT '';
  DECLARE v_count INT DEFAULT 0;
  DECLARE v_today DATE;
  DECLARE v_terms INT;
  DECLARE v_siret VARCHAR(14);
  DECLARE v_number_new VARCHAR(32);
  DECLARE v_unused INT;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @app_invoice_issue = NULL;
    SET @app_invoice_amounts_sync = NULL;
    SET @app_invoice_settlement_sync = NULL;
    RESIGNAL;
  END;

  SELECT tenant_id, kind, status, number, deleted_at, client_id, credited_invoice_id, currency,
         expected_payment_method, sepa_mandate_id, payment_terms_days
    INTO v_tenant_id, v_kind, v_status, v_number, v_deleted_at, v_client_id, v_credited_invoice_id,
         v_currency, v_method, v_mandate_id, v_terms_days
    FROM invoices
   WHERE id = p_invoice_id
     FOR UPDATE;
  IF v_status IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA003: Facture introuvable dans ce centre.';
  END IF;
  IF v_status <> 'draft' THEN
    SET v_message = LEFT(CONCAT('CA002: La facture ', v_number, ' est déjà émise.'), 128);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;
  IF v_deleted_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA003: Ce brouillon a été abandonné : il ne s''émet pas.';
  END IF;

  SELECT timezone, legal_name, legal_form, share_capital_cents, siren, siret, vat_number, rcs_city,
         address_line1, address_line2, postal_code, city, country, email, phone, website_url,
         bank_iban, bank_bic, sepa_creditor_id, invoice_payment_terms_days, late_payment_penalty_text,
         recovery_indemnity_cents, early_payment_discount_text, vat_on_debits, invoice_footer_text
    INTO t_timezone, t_legal_name, t_legal_form, t_share_capital, t_siren, t_siret, t_vat_number, t_rcs_city,
         t_address_line1, t_address_line2, t_postal_code, t_city, t_country, t_email, t_phone, t_website,
         t_bank_iban, t_bank_bic, t_sepa_creditor, t_payment_terms, t_penalty,
         t_recovery, t_discount, t_vat_on_debits, t_footer
    FROM tenants
   WHERE id = v_tenant_id;
  SELECT name, legal_form, siret, vat_number, address_line1, address_line2, postal_code, city, country,
         email, accounting_code
    INTO c_name, c_legal_form, c_siret, c_vat_number, c_address_line1, c_address_line2, c_postal_code,
         c_city, c_country, c_email, c_accounting_code
    FROM clients
   WHERE tenant_id = v_tenant_id AND id = v_client_id;

  -- Mentions obligatoires (art. 242 nonies A de l'annexe II du CGI,
  -- art. L. 441-9 du Code de commerce).
  IF NULLIF(TRIM(t_legal_name), '') IS NULL THEN
    SET v_missing = CONCAT_WS(', ', NULLIF(v_missing, ''), 'raison sociale du centre');
  END IF;
  IF NULLIF(TRIM(t_address_line1), '') IS NULL OR NULLIF(TRIM(t_postal_code), '') IS NULL
     OR NULLIF(TRIM(t_city), '') IS NULL THEN
    SET v_missing = CONCAT_WS(', ', NULLIF(v_missing, ''), 'adresse du centre');
  END IF;
  IF t_siren IS NULL THEN
    SET v_missing = CONCAT_WS(', ', NULLIF(v_missing, ''), 'SIREN du centre');
  END IF;
  IF t_vat_number IS NULL THEN
    SET v_missing = CONCAT_WS(', ', NULLIF(v_missing, ''), 'numéro de TVA intracommunautaire du centre');
  END IF;
  IF NULLIF(TRIM(c_address_line1), '') IS NULL OR NULLIF(TRIM(c_postal_code), '') IS NULL
     OR NULLIF(TRIM(c_city), '') IS NULL THEN
    SET v_missing = CONCAT_WS(', ', NULLIF(v_missing, ''), 'adresse du client');
  END IF;
  -- Motif d'exonération (EN 16931, BT-120) : catégories E, AE, K, G, O.
  SELECT COUNT(*) INTO v_count
    FROM invoice_lines
   WHERE tenant_id = v_tenant_id AND invoice_id = p_invoice_id AND deleted_at IS NULL
     AND vat_category NOT IN ('S', 'Z')
     AND NULLIF(TRIM(vat_exemption_reason), '') IS NULL;
  IF v_count > 0 THEN
    SET v_missing = CONCAT_WS(', ', NULLIF(v_missing, ''), 'motif d''exonération de TVA des lignes sans taux');
  END IF;
  IF v_kind = 'invoice' THEN
    IF v_method = 'transfer' AND t_bank_iban IS NULL THEN
      SET v_missing = CONCAT_WS(', ', NULLIF(v_missing, ''), 'IBAN du centre (paiement par virement)');
    END IF;
    IF v_method = 'direct_debit' THEN
      IF t_sepa_creditor IS NULL THEN
        SET v_missing = CONCAT_WS(', ', NULLIF(v_missing, ''), 'identifiant créancier SEPA du centre');
      END IF;
      SELECT status, deleted_at, reference INTO m_status, m_deleted_at, m_reference
        FROM sepa_mandates
       WHERE tenant_id = v_tenant_id AND id = v_mandate_id;
      IF m_status IS NULL OR m_status <> 'active' OR m_deleted_at IS NOT NULL THEN
        SET v_missing = CONCAT_WS(', ', NULLIF(v_missing, ''), 'mandat de prélèvement actif du client');
      END IF;
    END IF;
  END IF;
  IF v_missing <> '' THEN
    -- Le message de MySQL tient en 128 caractères : la fin de la liste est
    -- coupée ; le détail complet se lit avant l'émission (factures-document.ts).
    SET v_message = LEFT(CONCAT('CA003: Émission impossible, il manque : ', v_missing, '.'), 128);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;

  SET v_unused = invoice_refresh_amounts(p_invoice_id);
  SELECT COUNT(*) INTO v_count
    FROM invoice_lines
   WHERE tenant_id = v_tenant_id AND invoice_id = p_invoice_id AND deleted_at IS NULL;
  IF v_count = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA003: Une facture sans ligne ne s''émet pas.';
  END IF;
  SELECT total_incl_tax_cents INTO v_total FROM invoices WHERE id = p_invoice_id;

  IF v_kind = 'invoice' AND v_total < 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA003: Le total de cette facture est négatif : c''est un avoir qu''il faut établir.';
  END IF;

  IF v_kind = 'credit_note' THEN
    IF v_total <= 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA003: Un avoir porte un montant positif.';
    END IF;
    SELECT kind, status, number, currency, credited_cents, total_incl_tax_cents
      INTO o_kind, o_status, o_number, o_currency, o_credited, o_total
      FROM invoices
     WHERE tenant_id = v_tenant_id AND id = v_credited_invoice_id
       FOR UPDATE;
    IF o_kind IS NULL OR o_kind <> 'invoice' OR o_status = 'draft' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA003: Un avoir corrige une facture émise.';
    END IF;
    IF o_currency <> v_currency THEN
      SET v_message = LEFT(CONCAT('CA003: L''avoir et la facture ', o_number,
        ' ne sont pas dans la même devise.'), 128);
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
    END IF;
    IF o_credited + v_total > o_total THEN
      SET v_message = LEFT(CONCAT('CA003: Avoir excédentaire : il reste ',
        o_total - o_credited, ' centimes TTC à créditer sur la facture ', o_number, '.'), 128);
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
    END IF;
    SELECT COUNT(*) INTO v_count FROM (
      SELECT o.id
        FROM invoice_lines AS o
        JOIN invoice_lines AS cl ON cl.tenant_id = o.tenant_id AND cl.credited_line_id = o.id
        JOIN invoices AS cn ON cn.tenant_id = cl.tenant_id AND cn.id = cl.invoice_id
       WHERE o.tenant_id = v_tenant_id
         AND o.invoice_id = v_credited_invoice_id
         AND cl.deleted_at IS NULL
         AND (cn.id = p_invoice_id OR (cn.kind = 'credit_note' AND cn.status <> 'draft'))
       GROUP BY o.id, o.net_amount_cents
      HAVING CASE WHEN o.net_amount_cents >= 0
                  THEN SUM(cl.net_amount_cents) NOT BETWEEN 0 AND o.net_amount_cents
                  ELSE SUM(cl.net_amount_cents) NOT BETWEEN o.net_amount_cents AND 0
             END
    ) AS excess;
    IF v_count > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA003: Une ligne serait créditée au-delà de son montant.';
    END IF;
  END IF;

  -- Jour d'émission dans le fuseau du centre (la connexion est en UTC).
  SET v_today = DATE(CONVERT_TZ(CURRENT_TIMESTAMP(3), '+00:00', t_timezone));
  IF v_today IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'Fuseaux horaires MySQL non chargés (mysql_tzinfo_to_sql) : émission impossible.';
  END IF;
  SET v_terms = CASE WHEN v_kind = 'invoice' THEN COALESCE(v_terms_days, t_payment_terms) ELSE 0 END;
  SET v_number_new = next_document_number(CASE v_kind WHEN 'invoice' THEN 'invoice' ELSE 'credit_note' END);
  SET v_siret = NULLIF(REGEXP_REPLACE(COALESCE(c_siret, ''), '[[:space:]]', ''), '');

  SET @app_invoice_issue = 'on';
  UPDATE invoices
     SET number = v_number_new,
         status = invoice_payment_status(kind, total_incl_tax_cents, 0, 0),
         issue_date = v_today,
         issued_at = CURRENT_TIMESTAMP(3),
         issued_by = p_issued_by,
         payment_terms_days = v_terms,
         due_date = DATE_ADD(v_today, INTERVAL v_terms DAY),
         mandate_reference = CASE WHEN v_method = 'direct_debit' THEN m_reference END,
         seller_snapshot = JSON_OBJECT(
           'legalName', t_legal_name,
           'legalForm', t_legal_form,
           'shareCapitalCents', t_share_capital,
           'siren', t_siren,
           'siret', t_siret,
           'vatNumber', t_vat_number,
           'rcsCity', t_rcs_city,
           'addressLine1', t_address_line1,
           'addressLine2', t_address_line2,
           'postalCode', t_postal_code,
           'city', t_city,
           'country', t_country,
           'email', t_email,
           'phone', t_phone,
           'websiteUrl', t_website,
           'bankIban', t_bank_iban,
           'bankBic', t_bank_bic,
           'sepaCreditorId', t_sepa_creditor
         ),
         buyer_snapshot = JSON_OBJECT(
           'name', c_name,
           'legalForm', c_legal_form,
           'siret', v_siret,
           'siren', CASE WHEN v_siret REGEXP '^[0-9]{14}$' THEN LEFT(v_siret, 9) END,
           'vatNumber', c_vat_number,
           'addressLine1', c_address_line1,
           'addressLine2', c_address_line2,
           'postalCode', c_postal_code,
           'city', c_city,
           'country', c_country,
           'email', c_email,
           'accountingCode', c_accounting_code
         ),
         legal_mentions = JSON_OBJECT(
           'paymentTermsDays', v_terms,
           'latePaymentPenaltyText', t_penalty,
           'recoveryIndemnityCents', t_recovery,
           'earlyPaymentDiscountText', t_discount,
           'vatOnDebits', IF(t_vat_on_debits <> 0, CAST('true' AS JSON), CAST('false' AS JSON)),
           'operationCategory', 'services',
           'footerText', t_footer,
           'creditedInvoiceNumber', o_number
         )
   WHERE id = p_invoice_id;
  SET @app_invoice_issue = NULL;

  IF v_kind = 'credit_note' THEN
    SET v_unused = invoice_settle(v_credited_invoice_id);
  END IF;

  RETURN v_number_new;
END
--> statement-breakpoint

-- Brouillon d'avoir qui annule ce qui reste d'une facture émise : chaque ligne
-- pas encore entièrement créditée y est reprise pour son reliquat — à
-- l'identique si rien n'en a été crédité, pour le reste net sinon. Le code peut
-- ensuite le modifier (avoir partiel) avant de l'émettre par `issue_invoice`.
-- Le brouillon a pour identifiant `p_id`, fourni par l'appelant.
DROP PROCEDURE IF EXISTS draft_credit_note;
--> statement-breakpoint

CREATE PROCEDURE draft_credit_note(IN p_id CHAR(36), IN p_invoice_id CHAR(36), IN p_reason TEXT)
BEGIN
  DECLARE v_message VARCHAR(128);
  DECLARE v_tenant CHAR(36);
  DECLARE v_kind VARCHAR(20);
  DECLARE v_status VARCHAR(20);
  DECLARE v_number VARCHAR(32);
  DECLARE v_client CHAR(36);
  DECLARE v_period_start DATE;
  DECLARE v_period_end DATE;
  DECLARE v_currency CHAR(3);
  DECLARE v_unused INT;

  SELECT tenant_id, kind, status, number, client_id, period_start, period_end, currency
    INTO v_tenant, v_kind, v_status, v_number, v_client, v_period_start, v_period_end, v_currency
    FROM invoices
   WHERE id = p_invoice_id
     FOR UPDATE;
  IF v_status IS NULL OR v_kind <> 'invoice' OR v_status = 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA003: Seule une facture émise se corrige par un avoir.';
  END IF;
  IF v_status = 'cancelled' THEN
    SET v_message = LEFT(CONCAT('CA003: La facture ', v_number, ' est déjà entièrement créditée.'), 128);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
  END IF;

  INSERT INTO invoices (
    id, tenant_id, kind, client_id, credited_invoice_id, period_start, period_end, currency,
    expected_payment_method, notes
  )
  VALUES (
    p_id, v_tenant, 'credit_note', v_client, p_invoice_id, v_period_start, v_period_end, v_currency,
    'transfer', p_reason
  );

  INSERT INTO invoice_lines (
    id, tenant_id, invoice_id, position, kind, description, period_start, period_end,
    quantity, unit, unit_price_cents, discount_bp, discount_amount_cents,
    prorata_numerator, prorata_denominator, vat_rate_bp, vat_category, vat_exemption_reason,
    service_id, resource_id, credited_line_id
  )
  SELECT UUID(), r.tenant_id, p_id, r.position, r.kind, r.description, r.period_start, r.period_end,
         CASE WHEN r.credited = 0 THEN r.quantity ELSE 1 END,
         CASE WHEN r.credited = 0 THEN r.unit END,
         CASE WHEN r.credited = 0 THEN r.unit_price_cents ELSE r.net_amount_cents - r.credited END,
         CASE WHEN r.credited = 0 THEN r.discount_bp END,
         CASE WHEN r.credited = 0 THEN r.discount_amount_cents END,
         CASE WHEN r.credited = 0 THEN r.prorata_numerator END,
         CASE WHEN r.credited = 0 THEN r.prorata_denominator END,
         r.vat_rate_bp, r.vat_category, r.vat_exemption_reason,
         r.service_id, r.resource_id, r.id
    FROM (
      SELECT o.*,
             (SELECT COALESCE(SUM(cl.net_amount_cents), 0)
                FROM invoice_lines AS cl
                JOIN invoices AS cn ON cn.tenant_id = cl.tenant_id AND cn.id = cl.invoice_id
               WHERE cl.tenant_id = o.tenant_id AND cl.credited_line_id = o.id
                 AND cl.deleted_at IS NULL AND cn.kind = 'credit_note' AND cn.status <> 'draft') AS credited
        FROM invoice_lines AS o
       WHERE o.tenant_id = v_tenant AND o.invoice_id = p_invoice_id
         AND o.deleted_at IS NULL AND o.released_at IS NULL
    ) AS r
   ORDER BY r.position, r.id;

  SET v_unused = invoice_refresh_amounts(p_id);
END
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 13. Paiements (R16, ADR 027, 0031)
-- ---------------------------------------------------------------------------
-- Sur une facture émise seulement, dans sa devise ; jamais supprimé ni
-- modifié, seulement annulé (CA006). Le statut de la facture suit.
-- Sous portée client : seulement les paiements des factures émises de ses
-- entreprises.
DROP TRIGGER IF EXISTS payments_before_insert;
--> statement-breakpoint

CREATE TRIGGER payments_before_insert BEFORE INSERT ON payments
FOR EACH ROW
BEGIN
  -- Copie locale de la portée : une variable de session n'a pas la collation des colonnes.
  DECLARE v_scope VARCHAR(4000) DEFAULT @app_client_ids;
  DECLARE v_message VARCHAR(128);
  DECLARE v_count INT DEFAULT 0;
  DECLARE v_kind VARCHAR(20);
  DECLARE v_status VARCHAR(20);
  DECLARE v_number VARCHAR(32);
  DECLARE v_deleted_at DATETIME(3);
  DECLARE v_currency CHAR(3);
  IF v_scope IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count
      FROM invoices AS i
     WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.invoice_id
       AND FIND_IN_SET(i.client_id, v_scope) > 0
       AND i.status <> 'draft' AND i.deleted_at IS NULL;
    IF v_count = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA015: Ce paiement n''appartient à aucune entreprise du compte connecté.';
    END IF;
  END IF;
  SELECT kind, status, number, deleted_at, currency
    INTO v_kind, v_status, v_number, v_deleted_at, v_currency
    FROM invoices
   WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id;
  IF v_status IS NOT NULL THEN
    IF v_kind <> 'invoice' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA006: Un avoir ne se paie pas : un remboursement se pointe sur la facture, en montant négatif.';
    END IF;
    IF v_status = 'draft' OR v_deleted_at IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA006: Un brouillon ne se paie pas : émettez d''abord la facture.';
    END IF;
    IF NEW.currency <> v_currency THEN
      SET v_message = LEFT(CONCAT('CA006: Le paiement est en ', NEW.currency,
        ', la facture ', v_number, ' en ', v_currency, '.'), 128);
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
    END IF;
    IF NEW.cancelled_at IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA006: Un paiement s''enregistre valide, puis s''annule.';
    END IF;
  END IF;
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS payments_before_update;
--> statement-breakpoint

CREATE TRIGGER payments_before_update BEFORE UPDATE ON payments
FOR EACH ROW
BEGIN
  -- Copie locale de la portée : une variable de session n'a pas la collation des colonnes.
  DECLARE v_scope VARCHAR(4000) DEFAULT @app_client_ids;
  DECLARE v_count INT DEFAULT 0;
  IF v_scope IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count
      FROM invoices AS i
     WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.invoice_id
       AND FIND_IN_SET(i.client_id, v_scope) > 0
       AND i.status <> 'draft' AND i.deleted_at IS NULL;
    IF v_count = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
        'CA015: Ce paiement n''appartient à aucune entreprise du compte connecté.';
    END IF;
  END IF;
  IF OLD.cancelled_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA006: Ce paiement est annulé : il ne change plus.';
  END IF;
  IF NOT (NEW.id <=> OLD.id
        AND NEW.tenant_id <=> OLD.tenant_id
        AND NEW.invoice_id <=> OLD.invoice_id
        AND NEW.amount_cents <=> OLD.amount_cents
        AND NEW.currency <=> OLD.currency
        AND NEW.paid_on <=> OLD.paid_on
        AND NEW.method <=> OLD.method
        AND NEW.reference <=> OLD.reference
        AND NEW.sepa_mandate_id <=> OLD.sepa_mandate_id
        AND NEW.notes <=> OLD.notes
        AND NEW.recorded_by <=> OLD.recorded_by
        AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
      'CA006: Un paiement ne se modifie pas : annulez-le, puis saisissez le bon.';
  END IF;
END
--> statement-breakpoint

-- Après un paiement ou son annulation : la facture se règle.
DROP TRIGGER IF EXISTS payments_after_insert;
--> statement-breakpoint

CREATE TRIGGER payments_after_insert AFTER INSERT ON payments
FOR EACH ROW
BEGIN
  DECLARE v_unused INT;
  SET v_unused = invoice_settle(NEW.invoice_id);
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS payments_after_update;
--> statement-breakpoint

CREATE TRIGGER payments_after_update AFTER UPDATE ON payments
FOR EACH ROW
BEGIN
  DECLARE v_unused INT;
  SET v_unused = invoice_settle(NEW.invoice_id);
END
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 14. Dernier jour facturé d'un contrat (0032)
-- ---------------------------------------------------------------------------
-- Loyers et lignes du contrat (hors forfaits souscrits) que tient encore une
-- facture : émise ou brouillon, ni retirés ni libérés par un avoir. Nul : rien.
-- Définie ici parce qu'elle lit `invoice_lines` ; le trigger d'avenant (module
-- contrats) et `contrats/versions.ts` l'appellent.
DROP FUNCTION IF EXISTS contract_billed_through;
--> statement-breakpoint

CREATE FUNCTION contract_billed_through(p_contract_id CHAR(36)) RETURNS DATE
READS SQL DATA
BEGIN
  -- Copie locale : une variable de session n'a pas la collation des colonnes.
  DECLARE v_tenant CHAR(36) DEFAULT @app_tenant_id;
  DECLARE v_day DATE;
  SELECT MAX(l.period_end) INTO v_day
    FROM invoice_lines AS l
   WHERE l.contract_id = p_contract_id
     AND (v_tenant IS NULL OR l.tenant_id = v_tenant)
     AND l.kind IN ('rent', 'package')
     AND l.subscribed_service_id IS NULL
     AND l.period_start IS NOT NULL
     AND l.deleted_at IS NULL
     AND l.released_at IS NULL;
  RETURN v_day;
END
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 15. Plan de comptes par centre (R16, ADR 027, 0031)
-- ---------------------------------------------------------------------------
-- Comptes du plan comptable général proposés par défaut, à valider par
-- l'expert-comptable du centre. N'écrase jamais un compte déjà paramétré.
-- Posé à la création d'un centre, quel que soit le rôle qui le crée. Ne traite
-- que le centre passé en argument. Rend le nombre de comptes du centre.
DROP FUNCTION IF EXISTS seed_accounting_accounts;
--> statement-breakpoint

CREATE FUNCTION seed_accounting_accounts(p_tenant_id CHAR(36)) RETURNS INT
DETERMINISTIC MODIFIES SQL DATA
BEGIN
  DECLARE v_inserted INT DEFAULT 0;
  -- `ON DUPLICATE KEY UPDATE id = id` : sans effet sur un compte déjà posé
  -- (clé `accounting_accounts_key`, lignes nulles comprises).
  INSERT INTO accounting_accounts (id, tenant_id, purpose, line_kind, vat_rate_bp, account_number, label)
  VALUES
    (UUID(), p_tenant_id, 'customers', NULL, NULL, '411000', 'Clients'),
    (UUID(), p_tenant_id, 'bank', NULL, NULL, '512000', 'Banque'),
    (UUID(), p_tenant_id, 'revenue', 'rent', NULL, '706100', 'Prestations : loyers et domiciliation'),
    (UUID(), p_tenant_id, 'revenue', 'booking', NULL, '706200', 'Prestations : réservations d''espaces'),
    (UUID(), p_tenant_id, 'revenue', 'package', NULL, '706300', 'Prestations : forfaits de services'),
    (UUID(), p_tenant_id, 'revenue', 'act', NULL, '706400', 'Prestations : actes'),
    (UUID(), p_tenant_id, 'revenue', 'discount', NULL, '709000', 'Rabais, remises et ristournes accordés'),
    (UUID(), p_tenant_id, 'revenue', 'other', NULL, '706000', 'Prestations de services'),
    (UUID(), p_tenant_id, 'vat_collected', NULL, 2000, '445711', 'TVA collectée à 20 %'),
    (UUID(), p_tenant_id, 'vat_collected', NULL, 1000, '445712', 'TVA collectée à 10 %'),
    (UUID(), p_tenant_id, 'vat_collected', NULL, 550, '445713', 'TVA collectée à 5,5 %'),
    (UUID(), p_tenant_id, 'vat_collected', NULL, 210, '445714', 'TVA collectée à 2,1 %')
  ON DUPLICATE KEY UPDATE id = id;
  SELECT COUNT(*) INTO v_inserted FROM accounting_accounts WHERE tenant_id = p_tenant_id;
  RETURN v_inserted;
END
--> statement-breakpoint

DROP TRIGGER IF EXISTS tenants_seed_accounting_accounts;
--> statement-breakpoint

CREATE TRIGGER tenants_seed_accounting_accounts AFTER INSERT ON tenants
FOR EACH ROW
BEGIN
  DECLARE v_unused INT;
  SET v_unused = seed_accounting_accounts(NEW.id);
END
--> statement-breakpoint

-- Les centres déjà en base (le centre unique, posé par 05-fondations.sql).
SELECT seed_accounting_accounts(id) FROM tenants;
